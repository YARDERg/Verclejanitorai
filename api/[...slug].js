import {
  PROVIDER_BACKENDS,
  GOOGLE_OPENAI_URL,
  VERCEL_GATEWAY_URL,
  getBearerToken,
  detectBackendFromApiKey,
  prepareUpstreamRequest,
} from '../lib/provider-router.mjs';

export const config = { runtime: 'edge' };

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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === 'GET') {
    return json({
      ok: true,
      message:
        'الـ proxy شغّال. API key يحدد تلقائيًا: AIza... = Google AI Studio، vck_... = Vercel AI Gateway.',
    });
  }

  if (req.method !== 'POST') {
    return json({ error: { message: 'Method Not Allowed' } }, 405);
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = getBearerToken(req.headers);
  const backend = detectBackendFromApiKey(apiKey);

  if (!backend) {
    return json(
      {
        error: {
          message:
            'مفتاح API غير معروف. استخدم مفتاح Google AI Studio الذي يبدأ بـ AIza أو مفتاح Vercel AI Gateway الذي يبدأ بـ vck_.',
          type: 'invalid_api_key_format',
        },
      },
      401,
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400);
  }

  if (typeof body.model !== 'string') {
    return json({ error: { message: 'Missing or invalid model field' } }, 400);
  }

  const prepared = prepareUpstreamRequest(body, backend);
  const upstreamUrl =
    backend === PROVIDER_BACKENDS.GOOGLE
      ? GOOGLE_OPENAI_URL
      : VERCEL_GATEWAY_URL;

  const upstreamHeaders = {
    'Content-Type': 'application/json',
    ...(authHeader ? { Authorization: authHeader } : {}),
  };

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json(
      {
        error: {
          message: `تعذّر الوصول إلى ${backend === PROVIDER_BACKENDS.GOOGLE ? 'Google AI Studio' : 'Vercel AI Gateway'}: ${e.message}`,
        },
      },
      502,
    );
  }

  // نمرّر الرد كما هو، مع CORS.
  const respHeaders = new Headers(upstreamResp.headers);
  const cors = corsHeaders();
  for (const k in cors) respHeaders.set(k, cors[k]);

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}
