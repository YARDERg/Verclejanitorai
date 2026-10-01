// Select the upstream provider from the API key format sent by JanitorAI.
// Vercel AI Gateway keys use the vck_ prefix. Google AI Studio currently
// issues authorization keys beginning with AQ. (and historically standard
// keys beginning with AIza). Keep both Google formats supported.

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

export const GOOGLE_KEY_PREFIXES = Object.freeze([
  'AQ.',
  'AIza',
]);

export function isGoogleApiKey(apiKey) {
  if (typeof apiKey !== 'string') return false;
  const key = apiKey.trim();
  return GOOGLE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function detectBackendFromApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
  const key = apiKey.trim();

  if (key.startsWith('vck_')) return PROVIDER_BACKENDS.VERCEL;

  // Google AI Studio has moved from AIza standard keys to AQ. authorization
  // keys. Do not reject either format. Keep the historical non-empty fallback
  // as well because Google may introduce another key prefix in the future.
  if (isGoogleApiKey(key)) return PROVIDER_BACKENDS.GOOGLE;
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
