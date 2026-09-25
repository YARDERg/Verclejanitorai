// نسخة Node.js عادية (بدون أي مكتبات خارجية) من نفس البروكسي،
// للتشغيل محليًا على Termux/أي جهاز، وعمل tunnel عليها بـ cloudflared.
//
// المزوّد والـ reasoning effort بياخدوا من خانة Model في JanitorAI نفسها،
// بصيغة: provider/modelname/reasoningeffort (الجزء الأخير اختياري).
//
// في JanitorAI حط رابط الـ tunnel الخام بس (من غير أي إضافة زي
// /chat/completions) — البروكسي بيقبل POST على أي مسار (/، /chat/completions،
// /v1/chat/completions... إلخ) ويتعامل معاه كطلب chat/completions، فمفيش داعي
// تضيف حاجة يدويًا في خانة الـ Proxy URL.
//
// كل طلب بيتسجل محليًا على جهازك في ملف قاعدة بيانات واحد: local-server/logs.db
// (SQLite) — بيتفتح ويضاف عليه في كل مرة تشغّل السيرفر، حتى لو بعد جلسات
// Termux مختلفة. راجع logger.mjs و view-logs.mjs.
//
// تشغيل:  node server.mjs   (أو PORT=5000 node server.mjs)

import http from 'node:http';
import { logRequest, logCostUpdate, logError } from './logger.mjs';

const GATEWAY_CHAT_URL =
  process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1/chat/completions';
const GATEWAY_GENERATION_URL =
  process.env.AI_GATEWAY_GENERATION_URL || 'https://ai-gateway.vercel.sh/v1/generation';
const PORT = process.env.PORT || 5000;

// مسار معروف بنستخدمه بس للتوضيح/اللوج — البروكسي فعليًا بيقبل POST على أي
// مسار تاني برضه (JanitorAI بيبعت لـ <Proxy URL>/chat/completions تلقائيًا
// لو ضغطت "Add /chat/completions"، وده شغّال برضه حتى لو سبته من غيرها).
const CHAT_COMPLETIONS_PATH = '/chat/completions';

const VALID_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendJson(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * يفكّ خانة الـ Model من JanitorAI بصيغة:
 *   provider/modelname            (بدون reasoning)
 *   provider/modelname/reasoning  (مع reasoning)
 */
function parseModelField(rawModel) {
  if (typeof rawModel !== 'string' || !rawModel.includes('/')) {
    return { model: rawModel, provider: null, reasoning: null };
  }

  const parts = rawModel.split('/');
  let reasoning = null;

  const last = parts[parts.length - 1].toLowerCase();
  if (parts.length >= 3 && VALID_EFFORTS.has(last)) {
    reasoning = last;
    parts.pop();
  }

  return {
    model: parts.join('/'),
    provider: parts[0] || null,
    reasoning,
  };
}

/**
 * يحاول يجيب التكلفة الفعلية لطلب معيّن من Vercel AI Gateway.
 * usage events عند Vercel بتتسجل async، فبنستنى وبنعيد المحاولة كذا مرة
 * من غير ما نأخر الرد اللي راح للمستخدم أصلًا (الدالة دي بتتنادى من غير await).
 */
async function fetchCostInBackground(generationId, authHeader) {
  if (!generationId || !authHeader) return;

  const delaysMs = [3000, 5000, 8000]; // 3 محاولات: بعد 3، 5، 8 ثواني
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const url = `${GATEWAY_GENERATION_URL}?id=${encodeURIComponent(generationId)}`;
      const resp = await fetch(url, { headers: { Authorization: authHeader } });
      if (resp.status === 404) continue; // لسه مش متسجل عند Vercel، جرّب تاني
      if (!resp.ok) return;

      const data = await resp.json();
      logCostUpdate(generationId, {
        total_cost: data.total_cost ?? null,
        market_cost: data.market_cost ?? null,
        surcharge_cost: data.surcharge_cost ?? null,
        gateway_cost: data.gateway_cost ?? null,
        provider_name: data.provider_name ?? null,
        tokens_prompt: data.tokens_prompt ?? null,
        tokens_completion: data.tokens_completion ?? null,
        tokens_reasoning: data.native_tokens_reasoning ?? null,
        latency_ms: data.latency ?? null,
        generation_time_ms: data.generation_time ?? null,
      });
      return;
    } catch {
      // تجاهل وجرّب تاني في اللفة الجاية؛ لو فشلت كل المحاولات، مفيش تكلفة
      // متسجلة بس باقي بيانات الطلب (input/output/reasoning) اتسجلت عادي.
    }
  }
}

/**
 * يقرأ SSE stream من Vercel، بيبعت كل chunk للعميل زي ما هو لحظيًا (streaming
 * حقيقي)، وفي نفس الوقت بيجمّع الرد النهائي (content + reasoning + usage)
 * عشان يتسجل في اللوج بعد ما الـ stream يخلص.
 */
async function pipeAndCollectStream(upstreamResp, res) {
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  let content = '';
  let reasoning = '';
  let usage = null;
  let generationId = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    res.write(Buffer.from(value));

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const chunk = JSON.parse(payload);
        if (chunk.id) generationId = chunk.id;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (typeof delta?.reasoning === 'string') reasoning += delta.reasoning;
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      } catch {
        // سطر SSE مش JSON صالح (نادر) — تجاهله وكمّل
      }
    }
  }

  res.end();
  return { content, reasoning, usage, generationId, finishReason };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      message:
        'الـ proxy شغّال. حط رابط التونيل الخام في JanitorAI من غير أي إضافة، ' +
        'واستخدم خانة Model بصيغة provider/model/reasoning',
      chat_endpoint_used_internally: CHAT_COMPLETIONS_PATH,
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
  }

  const startedAt = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    // تجاهل، مش مهم للتشغيل
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
  }

  const rawModelField = body.model;
  let provider = null;
  let reasoningEffort = null;

  if (typeof body.model === 'string') {
    const parsedModel = parseModelField(body.model);
    body.model = parsedModel.model;
    provider = parsedModel.provider;
    reasoningEffort = parsedModel.reasoning;

    if (provider) {
      body.providerOptions = body.providerOptions || {};
      body.providerOptions.gateway = body.providerOptions.gateway || {};
      body.providerOptions.gateway.order = [provider];
    }

    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'off') {
      body.reasoning = { ...(body.reasoning || {}), effort: reasoningEffort };
    }
  }

  const isStream = body.stream === true;
  const authHeader = req.headers['authorization'];
  const upstreamHeaders = { 'Content-Type': 'application/json' };
  if (authHeader) upstreamHeaders['Authorization'] = authHeader;

  const inputSummary = {
    path: pathname,
    raw_model_field: rawModelField ?? null,
    messages: Array.isArray(body.messages) ? body.messages : null,
    temperature: body.temperature ?? null,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
  };

  let upstreamResp;
  try {
    upstreamResp = await fetch(GATEWAY_CHAT_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    logError({
      provider,
      model: body.model ?? null,
      reasoning_effort: reasoningEffort,
      input: inputSummary,
      message: e.message,
    });
    return sendJson(res, 502, {
      error: { message: 'تعذّر الوصول لـ AI Gateway: ' + e.message },
    });
  }

  setCors(res);
  const headersObj = {};
  upstreamResp.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-encoding') return;
    headersObj[k] = v;
  });

  const baseLogEntry = {
    provider,
    model: body.model ?? null,
    reasoning_effort: reasoningEffort,
    stream: isStream,
    status: upstreamResp.status,
    input: inputSummary,
  };

  // لو الرد مش ناجح، سجّل رسالة الخطأ من Vercel كما هي وابعتها للعميل
  if (!upstreamResp.ok) {
    const text = await upstreamResp.text();
    res.writeHead(upstreamResp.status, headersObj);
    res.end(text);

    logRequest({
      ...baseLogEntry,
      duration_ms: Date.now() - startedAt,
      generation_id: null,
      output: { content: null, finish_reason: null },
      reasoning: { text: null },
      usage: null,
      error_body: text.slice(0, 4000),
    });
    return;
  }

  if (isStream) {
    res.writeHead(upstreamResp.status, headersObj);
    const { content, reasoning, usage, generationId, finishReason } =
      await pipeAndCollectStream(upstreamResp, res);

    logRequest({
      ...baseLogEntry,
      duration_ms: Date.now() - startedAt,
      generation_id: generationId,
      output: { content: content || null, finish_reason: finishReason },
      reasoning: { text: reasoning || null },
      usage,
    });

    if (generationId) void fetchCostInBackground(generationId, authHeader);
    return;
  }

  // رد عادي (غير stream): نقرأه كامل عشان نبعته للعميل ونسجّله في نفس الوقت
  const text = await upstreamResp.text();
  res.writeHead(upstreamResp.status, headersObj);
  res.end(text);

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // الرد مش JSON لسبب ما — هنسجل النص الخام بس
  }

  const message = parsed?.choices?.[0]?.message;
  const generationId = parsed?.id ?? null;

  logRequest({
    ...baseLogEntry,
    duration_ms: Date.now() - startedAt,
    generation_id: generationId,
    output: {
      content: message?.content ?? (parsed ? null : text.slice(0, 4000)),
      finish_reason: parsed?.choices?.[0]?.finish_reason ?? null,
    },
    reasoning: {
      text: message?.reasoning ?? message?.reasoning_content ?? null,
    },
    usage: parsed?.usage ?? null,
  });

  if (generationId) void fetchCostInBackground(generationId, authHeader);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy شغّال على http://0.0.0.0:${PORT}`);
  console.log('استخدم: cloudflared tunnel --url http://localhost:' + PORT);
  console.log('في JanitorAI حط رابط التونيل الخام بس (من غير /chat/completions).');
  console.log('Model = provider/modelname/reasoningeffort  (مثال: zai/glm-4.6/high)');
  console.log('كل طلب بيتسجل في: local-server/logs.db — شوفه بـ: node view-logs.mjs');
});
