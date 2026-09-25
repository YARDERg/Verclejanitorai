// أداة بسيطة لعرض وتلخيص قاعدة بيانات اللوج (local-server/logs.db)
//
// الاستخدام:
//   node view-logs.mjs                 -> آخر 20 طلب (أحدث حاجة)
//   node view-logs.mjs --last 50       -> آخر 50 طلب
//   node view-logs.mjs 2026-09-25      -> كل طلبات تاريخ معيّن
//   node view-logs.mjs --all           -> يسرد كل التواريخ اللي فيها طلبات
//   node view-logs.mjs --stats         -> إجمالي التوكنز والتكلفة على كل الفترة
//   node view-logs.mjs --full <id>     -> التفاصيل الكاملة لطلب واحد (input
//                                          كامل + output كامل + reasoning كامل)
//                                          — الـ id ده رقم السطر الظاهر في
//                                          أول العمود، أو generation_id بتاع Vercel

import { getDb } from './logger.mjs';

const db = getDb();

function short(text, n = 60) {
  if (!text) return '-';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function lastUserMessage(messagesJson) {
  if (!messagesJson) return null;
  try {
    const messages = JSON.parse(messagesJson);
    return [...messages].reverse().find((m) => m.role === 'user')?.content ?? null;
  } catch {
    return null;
  }
}

function printRows(rows) {
  if (rows.length === 0) {
    console.log('مفيش طلبات مسجّلة.');
    return;
  }
  for (const r of rows) {
    const time = (r.ts || '').replace('T', ' ').slice(0, 19);
    if (r.kind === 'error') {
      console.log(`\n#${r.id} [${time}] ❌ خطأ — model=${r.model ?? '-'} — ${short(r.error_message, 90)}`);
      continue;
    }
    const cost = r.total_cost != null ? `$${r.total_cost}` : '—';
    console.log(
      `\n#${r.id} [${time}] gen_id=${r.generation_id ?? '-'} model=${r.model ?? '-'} ` +
      `provider=${r.provider ?? '-'} reasoning=${r.reasoning_effort ?? '-'} ` +
      `stream=${!!r.stream} status=${r.status} ${r.duration_ms}ms`,
    );
    console.log(
      `  توكنز: input=${r.usage_prompt_tokens ?? '-'} output=${r.usage_completion_tokens ?? '-'} ` +
      `reasoning=${r.usage_reasoning_tokens ?? '-'} تكلفة=${cost}`,
    );
    console.log(`  آخر مدخل: ${short(lastUserMessage(r.input_messages), 70)}`);
    console.log(`  المخرج: ${short(r.output_content, 70)}`);
    if (r.reasoning_text) console.log(`  تفكير: ${short(r.reasoning_text, 70)}`);
  }
}

function showLast(n) {
  const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(n);
  printRows(rows.reverse());
}

function showDate(date) {
  const rows = db
    .prepare("SELECT * FROM requests WHERE ts LIKE ? ORDER BY id ASC")
    .all(`${date}%`);
  printRows(rows);
}

function showAllDates() {
  const rows = db
    .prepare("SELECT DISTINCT substr(ts, 1, 10) AS day FROM requests ORDER BY day")
    .all();
  if (rows.length === 0) {
    console.log('مفيش طلبات مسجّلة لسه.');
    return;
  }
  rows.forEach((r) => console.log(r.day));
}

function showStats() {
  const totals = db
    .prepare(`
      SELECT
        COUNT(*) FILTER (WHERE kind = 'request') AS total_requests,
        COUNT(*) FILTER (WHERE kind = 'error')   AS total_errors,
        SUM(usage_prompt_tokens)     AS total_in,
        SUM(usage_completion_tokens) AS total_out,
        SUM(usage_reasoning_tokens)  AS total_reasoning,
        SUM(total_cost)              AS total_cost,
        COUNT(total_cost)            AS priced_requests
      FROM requests
    `)
    .get();

  console.log(`إجمالي الطلبات الناجحة: ${totals.total_requests ?? 0}`);
  console.log(`إجمالي الأخطاء: ${totals.total_errors ?? 0}`);
  console.log(`إجمالي توكنز الإدخال: ${totals.total_in ?? 0}`);
  console.log(`إجمالي توكنز الإخراج: ${totals.total_out ?? 0}`);
  console.log(`إجمالي توكنز التفكير: ${totals.total_reasoning ?? 0}`);
  console.log(
    `إجمالي التكلفة: $${(totals.total_cost ?? 0).toFixed(4)}` +
    (totals.priced_requests < totals.total_requests
      ? ` (متوفرة لـ ${totals.priced_requests} من ${totals.total_requests} طلب — الباقي التكلفة لسه ما وصلتش من Vercel)`
      : ''),
  );

  console.log('\nحسب الموديل:');
  const byModel = db
    .prepare(`
      SELECT model, COUNT(*) AS n, SUM(total_cost) AS cost
      FROM requests WHERE kind = 'request'
      GROUP BY model ORDER BY n DESC
    `)
    .all();
  for (const row of byModel) {
    console.log(`  ${row.model ?? '-'}: ${row.n} طلب${row.cost ? ` — $${row.cost.toFixed(4)}` : ''}`);
  }
}

function showFull(idOrGenId) {
  let row;
  if (/^\d+$/.test(idOrGenId)) {
    row = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(idOrGenId));
  }
  if (!row) {
    row = db.prepare('SELECT * FROM requests WHERE generation_id = ?').get(idOrGenId);
  }
  if (!row) {
    console.log('مفيش طلب بالـ id ده.');
    return;
  }
  if (row.input_messages) {
    try { row.input_messages = JSON.parse(row.input_messages); } catch {}
  }
  console.log(JSON.stringify(row, null, 2));
}

const args = process.argv.slice(2);

if (args[0] === '--stats') {
  showStats();
} else if (args[0] === '--all') {
  showAllDates();
} else if (args[0] === '--full') {
  const id = args[1];
  if (!id) console.log('استخدم: node view-logs.mjs --full <id أو generation_id>');
  else showFull(id);
} else if (args[0] === '--last') {
  showLast(Number(args[1]) || 20);
} else if (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
  showDate(args[0]);
} else {
  showLast(20);
}
