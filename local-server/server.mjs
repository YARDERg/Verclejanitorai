// JanitorAI proxy with automatic provider selection:
//   Google API keys -> Google AI Studio / Gemini API
//   vck_... -> Vercel AI Gateway
//
// Model field:
//   Google: gemini-model or google/gemini-model, with optional /reasoning
//
// Multiple Google keys: put comma-separated keys in the API key field
// The proxy automatically moves to the next key when quota is exhausted.
//   Vercel: provider/model, with optional /reasoning
//
// Example Google:  gemini-3.8-flash/high
// Example Vercel:  zai/glm-4.6/high
//
// API keys are never stored in the database.

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
import { parseApiKeys, fetchGoogleWithRotation } from '../lib/google-key-pool.mjs';

const GATEWAY_GENERATION_URL =
  process.env.AI_GATEWAY_GENERATION_URL || 'https://ai-gateway.vercel.sh/v1/generation';
const PORT = process.env.PORT || 5000;

process.on('unhandledRejection', (reason) => {
  const message = reason?.message || String(reason);
  console.error('Unhandled promise rejection:', message);
  logError({
    provider: null,
    model: null,
    reasoning_effort: null,
    stream: null,
    input: null,
    message: `Unhandled promise rejection: ${message}`,
  });
});

// Override upstream URLs with environment variables for testing or intermediary proxies.
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
      // Try the next attempt.
    }
  }
}

async function pipeAndCollectStream(upstreamResp, res) {
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let clientClosed = false;

  let content = '';
  let reasoning = '';
  let usage = null;
  let generationId = null;
  let finishReason = null;

  const onClose = () => {
    clientClosed = true;
    void reader.cancel().catch(() => {});
  };
  res.once('close', onClose);

  try {
    while (true) {
      if (clientClosed || res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => {});
        return { content, reasoning, usage, generationId, finishReason, clientClosed: true };
      }

      const { done, value } = await reader.read();
      if (done) break;

      if (clientClosed || res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => {});
        return { content, reasoning, usage, generationId, finishReason, clientClosed: true };
      }

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
          // Ignore malformed SSE lines.
        }
      }
    }

    if (!res.destroyed && !res.writableEnded) res.end();
    return { content, reasoning, usage, generationId, finishReason, clientClosed: false };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (!res.destroyed && !res.writableEnded) res.end();
    throw error;
  } finally {
    res.off('close', onClose);
  }
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
        'Proxy is running. Google AI Studio keys (including new AQ. authorization keys) use Google; vck_ keys use Vercel AI Gateway. Model syntax depends on the provider.',
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
    // Ignore malformed request URLs.
  }

  const authHeader = req.headers['authorization'];
  const apiKey = getBearerToken(req.headers);
  const backend = detectBackendFromApiKey(apiKey);

  if (!backend) {
    return sendJson(res, 401, {
      error: {
        message:
          'Missing or invalid API key. Use a Google AI Studio key (AQ. or legacy AIza...) or a Vercel AI Gateway key starting with vck_.',
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
  let preReadErrorText = null; // Error body read while rotating keys
  let googleKeys = null;
  try {
    if (backend === PROVIDER_BACKENDS.GOOGLE) {
      // Multiple Google keys can be separated with commas or new lines.
      googleKeys = parseApiKeys(apiKey);
      if (!googleKeys.length) {
        return sendJson(res, 401, {
          error: {
            message: 'No Google API keys were provided.',
            type: 'invalid_api_key_format',
          },
        });
      }
      const result = await fetchGoogleWithRotation({
        url: upstreamUrl,
        body,
        keys: googleKeys,
        model: prepared.model,
      });
      upstreamResp = result.resp;
      preReadErrorText = result.errorText;
      inputSummary.api_key_slot = `${result.keyIndex}/${googleKeys.length}`;
      if (googleKeys.length > 1) {
        console.log(
          `[keys] Using key ${result.keyIndex}/${googleKeys.length}` +
            (result.attempts > 1 ? ` after ${result.attempts - 1} failed attempts` : '') +
            ` — ${prepared.model}`,
        );
      }
    } else {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });
    }
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
          'Unable to reach ' +
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
    const text = preReadErrorText ?? (await upstreamResp.text());
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
    try {
      const { content, reasoning, usage, generationId, finishReason, clientClosed } =
        await pipeAndCollectStream(upstreamResp, res);

      logRequest({
        ...baseLogEntry,
        duration_ms: Date.now() - startedAt,
        generation_id: backend === PROVIDER_BACKENDS.VERCEL ? generationId : null,
        output: { content: content || null, finish_reason: finishReason },
        reasoning: { text: reasoning || null },
        usage,
      });

      if (!clientClosed && backend === PROVIDER_BACKENDS.VERCEL && generationId) {
        void fetchCostInBackground(generationId, authHeader);
      }
    } catch (e) {
      const message = e?.message || String(e);
      console.error('Streaming upstream failed:', message);
      logError({
        provider: prepared.provider,
        model: body.model ?? null,
        reasoning_effort: prepared.reasoning,
        stream: 1,
        input: inputSummary,
        message,
      });
    }
    return;
  }

  let text;
  try {
    text = await upstreamResp.text();
  } catch (e) {
    const message = e?.message || String(e);
    console.error('Upstream response interrupted:', message);
    logError({
      provider: prepared.provider,
      model: body.model ?? null,
      reasoning_effort: prepared.reasoning,
      stream: 0,
      input: inputSummary,
      message,
    });
    return sendJson(res, 502, {
      error: { message: 'Upstream response interrupted: ' + message },
    });
  }

  res.writeHead(upstreamResp.status, headersObj);
  res.end(text);

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON response; log the raw text.
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
  console.log(`Proxy running on http://0.0.0.0:${PORT}`);
  console.log('Use: cloudflared tunnel --url http://localhost:' + PORT);
  console.log('API key: Google -> Google AI Studio | vck_... -> Vercel AI Gateway');
  console.log('Google Model = gemini-model/reasoning (example: gemini-3.8-flash/high)');
  console.log('Vercel Model = provider/model/reasoning (example: zai/glm-4.6/high)');
  console.log('Every request is logged in local-server/logs.db. View it with: node view-logs.mjs');
});
