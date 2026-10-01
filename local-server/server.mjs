// Proxy لـ JanitorAI يدعم تلقائيًا:
//   AIza...  -> Google AI Studio / Gemini API
//   vck_...  -> Vercel AI Gateway
//
// خانة Model:
//   Google: gemini-model أو google/gemini-model، مع /reasoning اختياريًا
//   Vercel: provider/model، مع /reasoning اختياريًا
//
// مثال Google:  gemini-3.8-flash/high
// مثال Vercel:  zai/glm-4.6/high
//
// لا يتم حفظ API key في اللوج.

import http from 'node:http';
import { logRequest, logCostUpdate, logError } from './logger.mjs';
import {
  PROVIDER_BACKENDS,
  GOOGLE_OPENAI_URL,
  VERCEL_GATEWAY_URL,
  getBearerToken,
  detectBackendFromApiKey,
  prepareUpstreamRequest,
} from '../lib/provider-router.mjs';

const GATEWAY_GENERATION_URL =
  process.env.AI_GATEWAY_GENERATION_URL || 'https://ai-gateway.vercel.sh/v1/generation';
const PORT = process.env.PORT || 5000;

// يمكن تغيير الروابط بمتغيرات البيئة (للاختبار أو لبروكسي وسيط).
const VERCEL_URL = process.env.AI_GATEWAY_URL || VERCEL_GATEWAY_URL;
const GOOGLE_URL = process.env.GOOGLE_AI_URL || GOOGLE_OPENAI_URL;

const CHAT_COMPLETIONS_PATH = '/chat/completions';

const SKIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
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

async function fetchCostInBackground(generationId, authHeader) {
  if (!generationId || !authHeader) return;

  const delaysMs = [3000, 5000, 8000];
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const url = `${GATEWAY_GENERATION_URL}?id=${encodeURIComponent(generationId)}`;
      const resp = await fetch(url, { headers: { Authorization: authHeader } });
      if (resp.status === 404) continue;
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
      // جرّب المحاولة التالية.
    }
  }
}

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
        // تجاهل أي سطر SSE غير صالح.
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
        'Proxy شغّال. AIza... = Google AI Studio، vck_... = Vercel AI Gateway. صيغة Model حسب الخدمة.',
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
    // تجاهل.
  }

  const authHeader = req.headers['authorization'];
  const apiKey = getBearerToken(req.headers);
  const backend = detectBackendFromApiKey(apiKey);

  if (!backend) {
    return sendJson(res, 401, {
      error: {
        message:
          'مفتاح API غير معروف. استخدم مفتاح Google AI Studio الذي يبدأ بـ AIza أو مفتاح Vercel AI Gateway الذي يبدأ بـ vck_.',
        type: 'invalid_api_key_format',
      },
    });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
  }

  if (typeof body.model !== 'string') {
    return sendJson(res, 400, { error: { message: 'Missing or invalid model field' } });
  }

  const prepared = prepareUpstreamRequest(body, backend);

  body.stream = body.stream === true;
  if (!body.stream) delete body.stream_options;
  const isStream = body.stream;

  const upstreamUrl =
    backend === PROVIDER_BACKENDS.GOOGLE ? GOOGLE_URL : VERCEL_URL;

  const upstreamHeaders = { 'Content-Type': 'application/json' };
  if (authHeader) upstreamHeaders.Authorization = authHeader;

  const inputSummary = {
    path: pathname,
    backend,
    raw_model_field: prepared.rawModelField ?? null,
    messages: Array.isArray(body.messages) ? body.messages : null,
    temperature: body.temperature ?? null,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    stream: isStream ? 1 : 0,
  };

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    const causeText = e.cause
      ? ` [${e.cause.code || ''} ${e.cause.message || ''}]`.replace(/\s+\]/, ']')
      : '';
    const fullMessage = e.message + causeText;
    console.error('Upstream fetch failed:', fullMessage);

    logError({
      provider: prepared.provider,
      model: body.model ?? null,
      reasoning_effort: prepared.reasoning,
      stream: isStream ? 1 : 0,
      input: inputSummary,
      message: fullMessage,
    });

    return sendJson(res, 502, {
      error: {
        message:
          'تعذّر الوصول إلى ' +
          (backend === PROVIDER_BACKENDS.GOOGLE ? 'Google AI Studio' : 'Vercel AI Gateway') +
          ': ' +
          fullMessage,
      },
    });
  }

  setCors(res);
  const headersObj = {};
  upstreamResp.headers.forEach((v, k) => {
    if (SKIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) return;
    headersObj[k] = v;
  });

  const baseLogEntry = {
    provider: prepared.provider,
    model: body.model ?? null,
    reasoning_effort: prepared.reasoning,
    stream: isStream,
    status: upstreamResp.status,
    input: inputSummary,
  };

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
      generation_id: backend === PROVIDER_BACKENDS.VERCEL ? generationId : null,
      output: { content: content || null, finish_reason: finishReason },
      reasoning: { text: reasoning || null },
      usage,
    });

    if (backend === PROVIDER_BACKENDS.VERCEL && generationId) {
      void fetchCostInBackground(generationId, authHeader);
    }
    return;
  }

  const text = await upstreamResp.text();
  res.writeHead(upstreamResp.status, headersObj);
  res.end(text);

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // الرد مش JSON — سجّل النص الخام.
  }

  const message = parsed?.choices?.[0]?.message;
  const generationId =
    backend === PROVIDER_BACKENDS.VERCEL ? (parsed?.id ?? null) : null;

  logRequest({
    ...baseLogEntry,
    duration_ms: Date.now() - startedAt,
    generation_id: generationId,
    output: {
      content: message?.content ?? (parsed ? null : text.slice(0, 4000)),
      finish_reason: parsed?.choices?.[0]?.finish_reason ?? null,
    },
    reasoning: {
      text:
        message?.reasoning ??
        message?.reasoning_content ??
        message?.thinking ??
        null,
    },
    usage: parsed?.usage ?? null,
  });

  if (backend === PROVIDER_BACKENDS.VERCEL && generationId) {
    void fetchCostInBackground(generationId, authHeader);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy شغّال على http://0.0.0.0:${PORT}`);
  console.log('استخدم: cloudflared tunnel --url http://localhost:' + PORT);
  console.log('API key: AIza... -> Google AI Studio | vck_... -> Vercel AI Gateway');
  console.log('Google Model = gemini-model/reasoning (مثال: gemini-3.8-flash/high)');
  console.log('Vercel Model = provider/model/reasoning (مثال: zai/glm-4.6/high)');
  console.log('كل طلب بيتسجل في: local-server/logs.db — شوفه بـ: node view-logs.mjs');
});
