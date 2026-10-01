// Automatic Google AI Studio / Gemini API key rotation.
//
// JanitorAI can send multiple Google keys in the API key field, separated by
// commas or new lines. Example: AIzaKEY1,AIzaKEY2,AIzaKEY3
//
// Important: Gemini rate limits are applied per Google Cloud project, not per
// API key. Rotation only provides additional quota when the keys belong to
// projects with independent quota.

const exhausted = new Map(); // `${fingerprint}|${model}` -> { until, reason }

const INVALID_KEY_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_MINUTE_COOLDOWN_MS = 60 * 1000;
const MIN_COOLDOWN_MS = 5 * 1000;
const MAX_MINUTE_COOLDOWN_MS = 10 * 60 * 1000;

export function parseApiKeys(token) {
  if (typeof token !== 'string') return [];
  const seen = new Set();
  const keys = [];
  for (const part of token.split(/[,\n\r]+/)) {
    const key = part.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function fingerprint(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}:${key.slice(-4)}`;
}

function msUntilPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  const secondsToday = hour * 3600 + get('minute') * 60 + get('second');
  return Math.max((24 * 3600 - secondsToday) * 1000 + 30 * 1000, MIN_COOLDOWN_MS);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRetryDelayMs(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

function getErrorObject(parsed) {
  if (Array.isArray(parsed)) return parsed[0]?.error ?? null;
  return parsed?.error ?? null;
}

function hasInvalidKeySignal(haystack) {
  return /API_KEY_INVALID|API key not valid|API key expired|reported as leaked|invalid api key/i.test(haystack);
}

function hasDailyQuotaSignal(haystack) {
  return /PerDay|per_day|requests?\s*per\s*day|daily/i.test(haystack);
}

/**
 * Classify a failed Google response.
 *
 * Google documents 401 as authentication failure, 403 as permission/access
 * failure, and 429 as quota/rate-limit exhaustion. Some blocked-key cases,
 * notably a key reported as leaked, are returned as 403 and should rotate;
 * unrelated 403 permission/access errors should pass through unchanged.
 */
export function classifyGoogleError(status, errorText) {
  const parsed = safeJson(errorText);
  const err = getErrorObject(parsed);
  const message = String(err?.message ?? '');
  const details = Array.isArray(err?.details) ? err.details : [];
  const haystack = `${message} ${err?.status ?? ''} ${errorText}`;

  if (status === 401 || (status === 400 && hasInvalidKeySignal(haystack))) {
    return { action: 'rotate', kind: 'invalid', cooldownMs: INVALID_KEY_COOLDOWN_MS };
  }

  // Google can return leaked/blocked API keys as HTTP 403. Detect that
  // signal before the generic 403 permission-denied path so the key rotates.
  if (status === 403 && hasInvalidKeySignal(haystack)) {
    return { action: 'rotate', kind: 'invalid', cooldownMs: INVALID_KEY_COOLDOWN_MS };
  }

  // A generic 403 can be a project permission/access problem rather than a
  // bad key, so do not rotate all keys on every 403.
  if (status === 403) {
    return { action: 'passthrough', kind: 'permission_denied' };
  }

  const isQuota = status === 429 || err?.status === 'RESOURCE_EXHAUSTED';
  if (!isQuota) return { action: 'passthrough' };

  let retryMs = null;
  let daily = false;

  for (const detail of details) {
    if (typeof detail?.retryDelay === 'string') {
      retryMs = parseRetryDelayMs(detail.retryDelay) ?? retryMs;
    }
    for (const violation of detail?.violations ?? []) {
      const id = `${violation?.quotaId ?? ''} ${violation?.quotaMetric ?? ''}`;
      if (hasDailyQuotaSignal(id)) daily = true;
    }
  }

  if (!daily && hasDailyQuotaSignal(haystack)) daily = true;

  if (daily) {
    return { action: 'rotate', kind: 'daily', cooldownMs: msUntilPacificMidnight() };
  }

  const cooldownMs = Math.min(
    Math.max(retryMs ?? DEFAULT_MINUTE_COOLDOWN_MS, MIN_COOLDOWN_MS),
    MAX_MINUTE_COOLDOWN_MS,
  );
  return { action: 'rotate', kind: 'minute', cooldownMs };
}

function isAvailable(key, model, now) {
  const record = exhausted.get(`${fingerprint(key)}|${model}`);
  if (!record) return true;
  if (record.until <= now) {
    exhausted.delete(`${fingerprint(key)}|${model}`);
    return true;
  }
  return false;
}

function markExhausted(key, model, cooldownMs, reason) {
  exhausted.set(`${fingerprint(key)}|${model}`, {
    until: Date.now() + cooldownMs,
    reason,
  });
}

function orderCandidates(keys, model) {
  const now = Date.now();
  const available = keys
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => isAvailable(key, model, now));

  if (available.length) return available;

  let best = null;
  keys.forEach((key, index) => {
    const until = exhausted.get(`${fingerprint(key)}|${model}`)?.until ?? 0;
    if (!best || until < best.until) best = { key, index, until };
  });
  return best ? [{ key: best.key, index: best.index }] : [];
}

export async function fetchGoogleWithRotation({ url, body, keys, model, fetchImpl = fetch }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const candidates = orderCandidates(keys, model);

  let last = null;
  let attempts = 0;

  for (const { key, index } of candidates) {
    attempts += 1;
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: payload,
    });

    if (resp.ok) {
      return { resp, keyIndex: index + 1, attempts, errorText: null };
    }

    const errorText = await resp.text();
    last = { resp, keyIndex: index + 1, attempts, errorText };

    const verdict = classifyGoogleError(resp.status, errorText);
    if (verdict.action !== 'rotate') return last;

    markExhausted(key, model, verdict.cooldownMs, verdict.kind);
  }

  return last;
}

export function describePoolState(keys, model) {
  const now = Date.now();
  let earliest = Infinity;
  for (const key of keys) {
    const record = exhausted.get(`${fingerprint(key)}|${model}`);
    if (record && record.until > now) earliest = Math.min(earliest, record.until);
  }
  return {
    total: keys.length,
    retryAfterSeconds: Number.isFinite(earliest) ? Math.ceil((earliest - now) / 1000) : null,
  };
}
