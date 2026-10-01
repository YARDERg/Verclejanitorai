import {
  PROVIDER_BACKENDS,
  GOOGLE_OPENAI_URL,
  VERCEL_GATEWAY_URL,
  getBearerToken,
  detectBackendFromApiKey,
  prepareUpstreamRequest,
} from '../lib/provider-router.mjs';
import { parseApiKeys, fetchGoogleWithRotation } from '../lib/google-key-pool.mjs';

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
        'Proxy is running. vck_ keys use Vercel AI Gateway; other non-empty keys use Google AI Studio. Multiple Google keys may be comma-separated.',
    });
  }

  if (req.method !== 'POST') {
    return json({ error: { message: 'Method Not Allowed' } }, 405);
  }

  const apiKey = getBearerToken(req.headers);
  const backend = detectBackendFromApiKey(apiKey);

  if (!backend) {
    return json(
      {
        error: {
          message: 'Missing or invalid API key.',
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

  let upstreamResp;
  let errorText = null;
  let keySlot = null;

  try {
    if (backend === PROVIDER_BACKENDS.GOOGLE) {
      const keys = parseApiKeys(apiKey);
      const result = await fetchGoogleWithRotation({
        url: upstreamUrl,
        body,
        keys,
        model: prepared.model,
      });

      // Defensive guard: a malformed/empty key pool must never turn into a
      // null dereference and a misleading 502 response.
      if (!result?.resp) {
        return json(
          {
            error: {
              message: 'Missing or invalid Google API key.',
              type: 'invalid_api_key',
            },
          },
          401,
        );
      }

      upstreamResp = result.resp;
      errorText = result.errorText ?? null;
      keySlot = `${result.keyIndex}/${keys.length}`;
    } else {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    }
  } catch (e) {
    return json(
      {
        error: {
          message: `Upstream request failed: ${e.message}`,
        },
      },
      502,
    );
  }

  const respHeaders = new Headers(upstreamResp.headers);
  const cors = corsHeaders();
  for (const key in cors) respHeaders.set(key, cors[key]);
  if (keySlot) respHeaders.set('X-Proxy-Key-Slot', keySlot);

  if (errorText !== null) {
    for (const header of ['content-encoding', 'content-length', 'transfer-encoding']) {
      respHeaders.delete(header);
    }
    return new Response(errorText, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}
