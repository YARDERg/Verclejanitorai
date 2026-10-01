// Select the upstream provider from the API key format sent by JanitorAI.
// Vercel AI Gateway keys use the vck_ prefix. Google AI Studio keys are
// supported as the fallback provider so newer Google key formats are not
// rejected just because they do not use the historical AIza prefix.

export const PROVIDER_BACKENDS = Object.freeze({
  GOOGLE: 'google',
  VERCEL: 'vercel',
});

export const GOOGLE_OPENAI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const VERCEL_GATEWAY_URL =
  'https://ai-gateway.vercel.sh/v1/chat/completions';

export const VALID_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

// Google maps OpenAI reasoning_effort to the thinking levels supported by the
// selected Gemini model. Gemini 3.8 Flash supports low, medium, and high;
// minimal is not supported. Thinking cannot be disabled on Gemini 3 models.
const GOOGLE_EFFORT_MAP = Object.freeze({
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
});

export function getBearerToken(headers) {
  const authHeader = headers.get
    ? headers.get('authorization')
    : headers['authorization'];

  if (typeof authHeader !== 'string') return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function detectBackendFromApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
  const key = apiKey.trim();
  if (key.startsWith('vck_')) return PROVIDER_BACKENDS.VERCEL;
  return PROVIDER_BACKENDS.GOOGLE;
}

export function parseModelField(rawModel, backend) {
  if (typeof rawModel !== 'string') {
    return { model: rawModel, provider: null, reasoning: null };
  }

  let parts = rawModel.split('/');
  let reasoning = null;
  const minParts = backend === PROVIDER_BACKENDS.GOOGLE ? 2 : 3;
  const last = parts[parts.length - 1]?.toLowerCase();

  if (parts.length >= minParts && VALID_EFFORTS.has(last)) {
    reasoning = last;
    parts.pop();
  }

  if (backend === PROVIDER_BACKENDS.GOOGLE) {
    if (parts[0]?.toLowerCase() === 'google') parts.shift();
    return {
      model: parts.join('/'),
      provider: 'google',
      reasoning,
    };
  }

  if (!rawModel.includes('/')) {
    return { model: rawModel, provider: null, reasoning };
  }

  return {
    model: parts.slice(1).join('/'),
    provider: parts[0] || null,
    reasoning,
  };
}

export function prepareUpstreamRequest(body, backend) {
  const rawModelField = body.model;
  const parsed = parseModelField(rawModelField, backend);
  body.model = parsed.model;

  if (backend === PROVIDER_BACKENDS.VERCEL) {
    if (parsed.provider) {
      body.providerOptions = body.providerOptions || {};
      body.providerOptions.gateway = body.providerOptions.gateway || {};
      body.providerOptions.gateway.only = [parsed.provider];
    }

    if (parsed.reasoning && parsed.reasoning !== 'none') {
      body.reasoning = { ...(body.reasoning || {}), effort: parsed.reasoning };
    }
  } else {
    const googleEffort = GOOGLE_EFFORT_MAP[parsed.reasoning];
    if (googleEffort) body.reasoning_effort = googleEffort;
    delete body.providerOptions;
    delete body.reasoning;
  }

  return {
    rawModelField,
    model: parsed.model,
    provider: parsed.provider,
    reasoning: parsed.reasoning,
  };
}
