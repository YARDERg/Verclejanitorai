// اختيار الـ upstream تلقائيًا من نوع الـ API key الذي يرسله JanitorAI.
// Google AI Studio / Gemini API keys تبدأ عادةً بـ AIza
// وVercel AI Gateway API keys الجديدة تبدأ بـ vck_.

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

// Gemini (OpenAI-compatible endpoint) يقبل reasoning_effort = low / medium / high فقط عمليًا:
//  - gemini-3.8-flash لا يدعم minimal (يرجع خطأ) ولا يمكن إيقاف التفكير فيه، فلا نرسل none.
//  - xhigh و max غير موجودين عند Google، فنحوّلهم إلى high.
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
  if (typeof apiKey !== 'string' || !apiKey) return null;
  if (apiKey.startsWith('AIza')) return PROVIDER_BACKENDS.GOOGLE;
  if (apiKey.startsWith('vck_')) return PROVIDER_BACKENDS.VERCEL;
  return null;
}

/**
 * يفك خانة Model من JanitorAI بصيغة:
 *   model
 *   model/reasoning
 *   provider/model
 *   provider/model/reasoning
 *
 * بالنسبة لـ Google نسمح اختياريًا بـ google/ في بداية اسم الموديل
 * حتى يكون من السهل الانتقال بين Google وVercel بدون تغيير كبير في الخانة.
 */
export function parseModelField(rawModel, backend) {
  if (typeof rawModel !== 'string') {
    return { model: rawModel, provider: null, reasoning: null };
  }

  let parts = rawModel.split('/');
  let reasoning = null;

  // Google: model/effort تكفي (جزءان). Vercel: provider/model/effort (3 أجزاء على الأقل)
  // حتى لا يُفسَّر provider/high على أنه reasoning.
  const minParts = backend === PROVIDER_BACKENDS.GOOGLE ? 2 : 3;
  const last = parts[parts.length - 1].toLowerCase();
  if (parts.length >= minParts && VALID_EFFORTS.has(last)) {
    reasoning = last;
    parts.pop();
  }

  if (backend === PROVIDER_BACKENDS.GOOGLE) {
    // google/gemini-2.5-pro أو gemini-2.5-pro كلاهما مقبولان.
    if (parts[0]?.toLowerCase() === 'google') parts.shift();

    return {
      model: parts.join('/'),
      provider: 'google',
      reasoning,
    };
  }

  // منطق Vercel القديم محفوظ كما هو:
  // provider/model أو provider/model/reasoning.
  if (!rawModel.includes('/')) {
    return { model: rawModel, provider: null, reasoning };
  }

  return {
    model: parts.join('/'),
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
      // only = حصر صارم في المزوّد المحدد (بدون fallback لمزوّد آخر)
      body.providerOptions.gateway.only = [parsed.provider];
    }

    if (parsed.reasoning && parsed.reasoning !== 'none') {
      body.reasoning = { ...(body.reasoning || {}), effort: parsed.reasoning };
    }
  } else if (backend === PROVIDER_BACKENDS.GOOGLE) {
    // Gemini's OpenAI-compatible endpoint uses reasoning_effort directly.
    // Missing (or none) reasoning stays missing, so Gemini keeps its own default.
    const googleEffort = GOOGLE_EFFORT_MAP[parsed.reasoning];
    if (googleEffort) body.reasoning_effort = googleEffort;

    // These are Vercel-specific fields and are not meaningful to Google.
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
