'use strict';
// Static file server + global leaderboard API for Summit Climb.
// The only dependency is `pg`; without DATABASE_URL (or with the database down) the game and /health
// keep working and the leaderboard API answers 503.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const lb = require('./lib/leaderboard');
const { createDb } = require('./lib/db');
const { createAnalytics } = require('./lib/analytics');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');

let RUN_SECRET = process.env.RUN_SECRET || '';
if (RUN_SECRET.length < 16) {
  RUN_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[leaderboard] RUN_SECRET not set (or too short): using a random per-process secret. ' +
    'Run tokens will not survive a restart. Set RUN_SECRET in production.');
}
const db = createDb(process.env.DATABASE_URL || '');
if (db.configured) db.init();
else console.warn('[leaderboard] DATABASE_URL not set: global leaderboard disabled (game still works).');

const analytics = createAnalytics({ databaseUrl: process.env.DATABASE_URL || '', statsToken: process.env.STATS_TOKEN || '' });
analytics.init();

// Optional moderation key: enables DELETE /api/admin/scores/:id (disabled when unset).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 24 ? process.env.ADMIN_TOKEN : '';
const adminLimiter = new lb.RateLimiter(30, 10 * 60 * 1000);
const submitLimiter = new lb.RateLimiter(Number(process.env.SUBMIT_RATE_MAX) || 10, 10 * 60 * 1000);
const runLimiter = new lb.RateLimiter(Number(process.env.RUN_RATE_MAX) || 120, 10 * 60 * 1000);
const MAX_BODY = 16 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;

function sendText(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > MAX_BODY) return reject(Object.assign(new Error('too large'), { status: 413 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Browsers send Origin on cross-site POSTs; refuse other sites posting into our board.
function crossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

async function handleApi(req, res, pathname, url) {
  const ip = lb.clientIp(req);

  if (pathname === '/api/run') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (crossOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    const rl = runLimiter.hit(ip);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate_limited', retryAfter: rl.retryAfterSec }, { 'Retry-After': String(rl.retryAfterSec) });
    const { token, issuedAt } = lb.signToken(RUN_SECRET);
    return sendJson(res, 200, { token, issuedAt, leaderboard: db.ready });
  }

  if (pathname === '/api/scores' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!db.ready) return sendJson(res, 503, { error: 'leaderboard_unavailable' });
    let limit = parseInt(url.searchParams.get('limit') || '10', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    limit = Math.min(limit, 50);
    const period = url.searchParams.get('period') === 'today' ? 'today' : 'all';
    const scores = await db.top(limit, period);
    return sendJson(res, 200, { period, limit, scores }, { 'Cache-Control': 'public, max-age=10' });
  }

  if (pathname === '/api/scores' && req.method === 'POST') {
    if (crossOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    const rl = submitLimiter.hit(ip);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate_limited', retryAfter: rl.retryAfterSec }, { 'Retry-After': String(rl.retryAfterSec) });
    let body;
    try { body = await readJson(req); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'body_too_large' : 'bad_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'bad_body' });

    const tok = lb.verifyToken(RUN_SECRET, body.token);
    if (!tok) return sendJson(res, 400, { error: 'invalid_token' });
    const nm = lb.normalizeName(body.name);
    if (nm.error) return sendJson(res, 400, { error: nm.error });
    const v = lb.validateRun(body, Date.now() - tok.issuedAt);
    if (!v.ok) {
      console.warn(`[leaderboard] rejected ${v.error}${v.detail ? ' (' + v.detail + ')' : ''} ip=${lb.hashIp(RUN_SECRET, ip).slice(0, 8)}`);
      return sendJson(res, 400, { error: v.error }); // detail stays in the server log (don't coach cheaters)
    }
    if (!db.ready) return sendJson(res, 503, { error: 'leaderboard_unavailable' });
    const id = await db.insertScore({ ...v.value, name: nm.name, ipHash: lb.hashIp(RUN_SECRET, ip), nonce: tok.nonce });
    if (!id) return sendJson(res, 409, { error: 'token_used' });
    const r = await db.rankOf(v.value.score);
    console.log(`[leaderboard] #${id} ${nm.name} ${v.value.score} (floor ${v.value.floor}) rank ${r.rank}/${r.total}`);
    return sendJson(res, 201, { ok: true, id, name: nm.name, score: v.value.score, ...r });
  }

  const adm = /^\/api\/admin\/scores\/(\d{1,18})$/.exec(pathname);
  if (adm && ADMIN_TOKEN) {
    if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'DELETE' });
    const rl = adminLimiter.hit(ip);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate_limited', retryAfter: rl.retryAfterSec });
    const given = crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest();
    const want = crypto.createHash('sha256').update('Bearer ' + ADMIN_TOKEN).digest();
    if (!crypto.timingSafeEqual(given, want)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!db.ready) return sendJson(res, 503, { error: 'leaderboard_unavailable' });
    const deleted = await db.deleteScore(adm[1]);
    console.log(`[leaderboard] admin delete #${adm[1]}: ${deleted ? 'deleted' : 'not found'}`);
    return sendJson(res, deleted ? 200 : 404, { ok: deleted, id: adm[1] });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  let pathname, url;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  if (pathname.startsWith('/api/') && analytics.handle(req, res, pathname, url)) return;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url).catch((err) => {
      console.error('[api] error:', err.message);
      if (!res.headersSent) sendJson(res, 503, { error: 'leaderboard_unavailable' });
      else res.destroy();
    });
    return;
  }

  if (pathname === '/health' || pathname === '/healthz') {
    const body = JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()),
      leaderboard: db.ready ? 'ok' : db.configured ? 'unavailable' : 'disabled' });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  if (pathname.includes('\0')) return sendText(res, 400, 'Bad Request');
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep)) return sendText(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not Found');
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      // HTML always revalidates; other assets are cached briefly and revalidated via ETag.
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gzip = COMPRESSIBLE.test(type) && st.size > 1024 &&
      /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) headers['Content-Encoding'] = 'gzip';
    else headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    if (gzip) stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Summit Climb server listening on port ${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => Promise.all([db.close(), analytics.close()]).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
