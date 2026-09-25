// نسخة Node.js عادية (بدون أي مكتبات خارجية) من نفس البروكسي،
// للتشغيل محليًا على Termux/أي جهاز، وعمل tunnel عليها بـ cloudflared
// بنفس فكرة GeminiForJanitors.
//
// تشغيل:  node server.mjs   (أو PORT=5000 node server.mjs)

import http from 'node:http';
import { Readable } from 'node:stream';

const GATEWAY_CHAT_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const PORT = process.env.PORT || 5000;

const VALID_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const segments = url.pathname.split('/').filter(Boolean);

  // نفس منطق نسخة Vercel: نشيل "chat/completions" اللي JanitorAI بيضيفها تلقائيًا
  const rest = segments.slice();
  if (rest.length && rest[rest.length - 1] === 'completions') rest.pop();
  if (rest.length && rest[rest.length - 1] === 'chat') rest.pop();

  const provider = (rest[0] || 'auto').toLowerCase();
  const reasoning = (rest[1] || 'none').toLowerCase();

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, provider, reasoning });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
  }

  if (provider && provider !== 'auto' && provider !== 'any') {
    body.providerOptions = body.providerOptions || {};
    body.providerOptions.gateway = body.providerOptions.gateway || {};
    body.providerOptions.gateway.order = provider
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  if (
    reasoning &&
    reasoning !== 'none' &&
    reasoning !== 'off' &&
    VALID_EFFORTS.has(reasoning)
  ) {
    body.reasoning = { ...(body.reasoning || {}), effort: reasoning };
  }

  const authHeader = req.headers['authorization'];
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
    return sendJson(res, 502, {
      error: { message: 'تعذّر الوصول لـ AI Gateway: ' + e.message },
    });
  }

  setCors(res);
  const headersObj = {};
  upstreamResp.headers.forEach((v, k) => {
    // بعض الهيدرز زي content-encoding ممكن تسبب مشاكل لو مررناها كما هي
    if (k.toLowerCase() === 'content-encoding') return;
    headersObj[k] = v;
  });
  res.writeHead(upstreamResp.status, headersObj);

  if (upstreamResp.body) {
    Readable.fromWeb(upstreamResp.body).pipe(res);
  } else {
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy شغّال على http://0.0.0.0:${PORT}`);
  console.log('استخدم cloudflared tunnel --url http://localhost:' + PORT + ' عشان تطلع رابط عام');
});
