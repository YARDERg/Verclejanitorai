export const config = { runtime: 'edge' };

const GATEWAY_CHAT_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

// قيم reasoning effort المدعومة من Vercel AI Gateway
const VALID_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/**
 * يفكّ خانة الـ Model من JanitorAI بصيغة:
 *   provider/modelname            (بدون reasoning)
 *   provider/modelname/reasoning  (مع reasoning)
 *
 * أمثلة:
 *   "zai/glm-4.6/high"          -> model: "zai/glm-4.6",          provider: "zai", reasoning: "high"
 *   "zai/glm-4.6"               -> model: "zai/glm-4.6",          provider: "zai", reasoning: null
 *   "groq/openai/gpt-oss-120b"  -> model: "groq/openai/gpt-oss-120b", provider: "groq", reasoning: null
 *   "glm-4.6"                   -> model: "glm-4.6",              provider: null,  reasoning: null
 */
function parseModelField(rawModel) {
  if (typeof rawModel !== 'string' || !rawModel.includes('/')) {
    return { model: rawModel, provider: null, reasoning: null };
  }

  const parts = rawModel.split('/');
  let reasoning = null;

  const last = parts[parts.length - 1].toLowerCase();
  // نعتبر آخر جزء "reasoning" بس لو كان قيمة معروفة، ولسه فاضل جزءين على الأقل بعد شيله
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

export default async function handler(req) {
  // دعم preflight الخاص بالمتصفح (JanitorAI بيستدعي من المتصفح مباشرة)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === 'GET') {
    return json({
      ok: true,
      message: 'الـ proxy شغّال. استخدم POST من JanitorAI مع خانة Model بصيغة provider/model/reasoning',
    });
  }

  if (req.method !== 'POST') {
    return json({ error: { message: 'Method Not Allowed' } }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400);
  }

  if (typeof body.model === 'string') {
    const { model, provider, reasoning } = parseModelField(body.model);
    body.model = model;

    if (provider) {
      body.providerOptions = body.providerOptions || {};
      body.providerOptions.gateway = body.providerOptions.gateway || {};
      body.providerOptions.gateway.only = [provider];
    }

    if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
      body.reasoning = { ...(body.reasoning || {}), effort: reasoning };
    }
  }

  // نمرّر الـ Authorization اللي JanitorAI بعتها (API key بتاع Vercel AI Gateway) كما هي
  const authHeader = req.headers.get('authorization');
  const upstreamHeaders = { 'Content-Type': 'application/json' };
  if (authHeader) upstreamHeaders['Authorization'] = authHeader;

  let upstreamResp;
  try {
    upstreamResp = await fetch(GATEWAY_CHAT_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json({ error: { message: 'تعذّر الوصول لـ AI Gateway: ' + e.message } }, 502);
  }

  // تمرير الرد كما هو (سواء JSON عادي أو SSE stream) مع إضافة CORS
  const respHeaders = new Headers(upstreamResp.headers);
  const cors = corsHeaders();
  for (const k in cors) respHeaders.set(k, cors[k]);

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}
