// طبقة تسجيل محلية — قاعدة بيانات SQLite حقيقية في ملف واحد بس:
// local-server/logs.db
//
// الملف ده بيتفتح ويضاف عليه في كل مرة تشغّل السيرفر — حتى لو قفلت الجلسة
// (Termux session) وفتحتها تاني بعد يوم أو أسبوع، هيكمّل يضيف على نفس
// الملف من غير ما يعمل ملفات جديدة أو يمسح القديم.
//
// بيستخدم node:sqlite المدمجة جوه Node نفسه (من غير أي npm install) —
// متاحة ابتداءً من Node 22.5. لو ظهرلك خطأ إنها مش موجودة، حدّث Node على
// Termux بـ: pkg install nodejs -y

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.join(__dirname, 'logs.db');

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  console.error(
    '\n[logger] الموديول node:sqlite مش متاحة في نسخة Node عندك (محتاج Node 22.5+).\n' +
    'حدّث Node على Termux بـ:  pkg install nodejs -y\n',
  );
  throw e;
}

const db = new DatabaseSync(DB_PATH);
// WAL: يسمح إن view-logs.mjs يقرا من الملف وهو السيرفر لسه شغّال وبيكتب فيه
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS requests (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                     TEXT NOT NULL DEFAULT 'request', -- 'request' أو 'error'
  ts                       TEXT NOT NULL,
  generation_id            TEXT,
  provider                 TEXT,
  model                    TEXT,
  raw_model_field          TEXT,
  reasoning_effort         TEXT,
  path                     TEXT,
  stream                   INTEGER,
  status                   INTEGER,
  duration_ms              INTEGER,
  input_messages           TEXT,
  temperature              REAL,
  max_tokens               INTEGER,
  output_content           TEXT,
  finish_reason            TEXT,
  reasoning_text           TEXT,
  usage_prompt_tokens      INTEGER,
  usage_completion_tokens  INTEGER,
  usage_total_tokens       INTEGER,
  usage_reasoning_tokens   INTEGER,
  error_message            TEXT,
  total_cost               REAL,
  market_cost              REAL,
  surcharge_cost           REAL,
  gateway_cost             REAL,
  provider_name            TEXT,
  cost_tokens_prompt       INTEGER,
  cost_tokens_completion   INTEGER,
  cost_tokens_reasoning    INTEGER,
  latency_ms               INTEGER,
  generation_time_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_generation_id ON requests(generation_id);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
`);

const insertStmt = db.prepare(`
INSERT INTO requests (
  kind, ts, generation_id, provider, model, raw_model_field, reasoning_effort,
  path, stream, status, duration_ms, input_messages, temperature, max_tokens,
  output_content, finish_reason, reasoning_text,
  usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_reasoning_tokens,
  error_message
) VALUES (
  @kind, @ts, @generation_id, @provider, @model, @raw_model_field, @reasoning_effort,
  @path, @stream, @status, @duration_ms, @input_messages, @temperature, @max_tokens,
  @output_content, @finish_reason, @reasoning_text,
  @usage_prompt_tokens, @usage_completion_tokens, @usage_total_tokens, @usage_reasoning_tokens,
  @error_message
)
`);

const updateCostStmt = db.prepare(`
UPDATE requests SET
  total_cost = @total_cost,
  market_cost = @market_cost,
  surcharge_cost = @surcharge_cost,
  gateway_cost = @gateway_cost,
  provider_name = @provider_name,
  cost_tokens_prompt = @cost_tokens_prompt,
  cost_tokens_completion = @cost_tokens_completion,
  cost_tokens_reasoning = @cost_tokens_reasoning,
  latency_ms = @latency_ms,
  generation_time_ms = @generation_time_ms
WHERE generation_id = @generation_id
`);

function safeRun(stmt, params) {
  try {
    stmt.run(params);
  } catch (e) {
    console.error('[logger] فشل الكتابة في قاعدة البيانات:', e.message);
  }
}

/** يسجّل طلب كامل (مدخلات + مخرجات + تفكير + توكنز) بعد الانتهاء من الرد. */
export function logRequest(entry) {
  safeRun(insertStmt, {
    kind: 'request',
    ts: new Date().toISOString(),
    generation_id: entry.generation_id ?? null,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    raw_model_field: entry.input?.raw_model_field ?? null,
    reasoning_effort: entry.reasoning_effort ?? null,
    path: entry.input?.path ?? null,
    stream: entry.stream ? 1 : 0,
    status: entry.status ?? null,
    duration_ms: entry.duration_ms ?? null,
    input_messages: entry.input?.messages ? JSON.stringify(entry.input.messages) : null,
    temperature: entry.input?.temperature ?? null,
    max_tokens: entry.input?.max_tokens ?? null,
    output_content: entry.output?.content ?? null,
    finish_reason: entry.output?.finish_reason ?? null,
    reasoning_text: entry.reasoning?.text ?? null,
    usage_prompt_tokens: entry.usage?.prompt_tokens ?? null,
    usage_completion_tokens: entry.usage?.completion_tokens ?? null,
    usage_total_tokens: entry.usage?.total_tokens ?? null,
    usage_reasoning_tokens: entry.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    error_message: entry.error_body ?? null,
  });
}

/** يسجّل خطأ حصل قبل ما نوصل لرد أصلًا (تعذّر الاتصال بالـ Gateway مثلًا). */
export function logError(entry) {
  safeRun(insertStmt, {
    kind: 'error',
    ts: new Date().toISOString(),
    generation_id: null,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    raw_model_field: entry.input?.raw_model_field ?? null,
    reasoning_effort: entry.reasoning_effort ?? null,
    path: entry.input?.path ?? null,
    stream: null,
    status: null,
    duration_ms: null,
    input_messages: entry.input?.messages ? JSON.stringify(entry.input.messages) : null,
    temperature: entry.input?.temperature ?? null,
    max_tokens: entry.input?.max_tokens ?? null,
    output_content: null,
    finish_reason: null,
    reasoning_text: null,
    usage_prompt_tokens: null,
    usage_completion_tokens: null,
    usage_total_tokens: null,
    usage_reasoning_tokens: null,
    error_message: entry.message ?? null,
  });
}

/** يحدّث سطر طلب موجود بالتكلفة الفعلية لما توصل من Vercel (متأخرة شوية). */
export function logCostUpdate(generationId, cost) {
  if (!generationId) return;
  try {
    updateCostStmt.run({
      generation_id: generationId,
      total_cost: cost.total_cost != null ? Number(cost.total_cost) : null,
      market_cost: cost.market_cost != null ? Number(cost.market_cost) : null,
      surcharge_cost: cost.surcharge_cost != null ? Number(cost.surcharge_cost) : null,
      gateway_cost: cost.gateway_cost != null ? Number(cost.gateway_cost) : null,
      provider_name: cost.provider_name ?? null,
      cost_tokens_prompt: cost.tokens_prompt ?? null,
      cost_tokens_completion: cost.tokens_completion ?? null,
      cost_tokens_reasoning: cost.tokens_reasoning ?? null,
      latency_ms: cost.latency_ms ?? null,
      generation_time_ms: cost.generation_time_ms ?? null,
    });
  } catch (e) {
    console.error('[logger] فشل تحديث التكلفة:', e.message);
  }
}

/** الاتصال الخام بقاعدة البيانات — تستخدمه view-logs.mjs مباشرة لعمل queries. */
export function getDb() {
  return db;
}
