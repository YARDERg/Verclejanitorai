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

export default async function handler(req) {
  // دعم preflight الخاص بالمتصفح (JanitorAI بيستدعي من المتصفح مباشرة)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);

  // JanitorAI بيضيف "/chat/completions" تلقائيًا في آخر الـ Proxy URL
  // فبنشيلها من آخر المسار عشان يفضل بس أجزاء التهيئة (provider/reasoning)
  const rest = segments.slice();
  if (rest.length && rest[rest.length - 1] === 'completions') rest.pop();
  if (rest.length && rest[rest.length - 1] === 'chat') rest.pop();

  // /<provider>/<reasoning>/chat/completions
  // provider: اسم مزود واحد (zai, anthropic, openai, google...) أو أسماء متعددة مفصولة بفاصلة كـ fallback
  //           أو "auto" لو مش عايز تفرض مزود معيّن (AI Gateway هيختار افتراضيًا)
  // reasoning: none | minimal | low | medium | high | xhigh | max
  const provider = (rest[0] || 'auto').toLowerCase();
  const reasoning = (rest[1] || 'none').toLowerCase();

  if (req.method === 'GET') {
    return json({
      ok: true,
      message: 'الـ proxy شغّال. استخدم POST من JanitorAI على نفس هذا المسار مع "/chat/completions".',
      parsed: { provider, reasoning },
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

  // حقن ترتيب المزود (provider order) في providerOptions.gateway.order
  if (provider && provider !== 'auto' && provider !== 'any') {
    body.providerOptions = body.providerOptions || {};
    body.providerOptions.gateway = body.providerOptions.gateway || {};
    body.providerOptions.gateway.order = provider
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  // حقن reasoning effort لو محدد وصالح
  if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
    if (VALID_EFFORTS.has(reasoning)) {
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
