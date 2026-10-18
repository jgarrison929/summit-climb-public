'use strict';
// First-party, privacy-friendly player analytics.
//   POST /api/events          anonymous gameplay events (no cookies, no IPs stored, no PII)
//   GET  /api/stats?days=7    aggregate stats, requires `Authorization: Bearer $STATS_TOKEN`
//   POST /api/stats/internal  mark a visitor id's events as internal (same token)
// Storage: one Postgres table (`analytics_events`), created on startup. Without DATABASE_URL the
// endpoints still validate/rate-limit but answer 503; nothing else in the app depends on this module.
const crypto = require('crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  type        VARCHAR(32) NOT NULL,
  visitor     VARCHAR(40) NOT NULL,
  session     VARCHAR(40) NOT NULL,
  internal    BOOLEAN     NOT NULL DEFAULT false,
  mobile      BOOLEAN,
  touch       BOOLEAN,
  mode        VARCHAR(16),
  score       INTEGER,
  floor       INTEGER,
  winner      VARCHAR(16),
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS analytics_events_ts_idx ON analytics_events (ts);
CREATE INDEX IF NOT EXISTS analytics_events_visitor_idx ON analytics_events (visitor, ts);
`;

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const WINNER_RE = /^[A-Za-z0-9 _.-]{1,16}$/;
const BASE_TYPES = ['visit', 'game_start', 'game_end'];
const MAX_BODY = 2048;
// User agents of automated/test browsers: always tagged internal.
const INTERNAL_UA_RE = /internal-playtest|HeadlessChrome|Playwright|Puppeteer/i;

class Limiter {
  constructor(max, windowMs) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60000));
    if (this.timer.unref) this.timer.unref();
  }
  hit(key, now = Date.now()) {
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, n: 0 }; this.hits.set(key, e); }
    e.n++;
    return { ok: e.n <= this.max, retryAfterSec: Math.max(1, Math.ceil((e.start + this.windowMs - now) / 1000)) };
  }
  sweep(now = Date.now()) { for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k); }
}

function intOrNull(v, min, max) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
  const n = Math.round(v);
  if (n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

/** Validate a raw event body. Returns { ok, value } or { ok:false, error }. */
function validateEvent(body, opts) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_body' };
  const types = BASE_TYPES.concat(opts.extraTypes || []);
  const { t, v, s } = body;
  if (typeof t !== 'string' || !types.includes(t)) return { ok: false, error: 'bad_type' };
  if (typeof v !== 'string' || !ID_RE.test(v)) return { ok: false, error: 'bad_visitor' };
  if (typeof s !== 'string' || !ID_RE.test(s)) return { ok: false, error: 'bad_session' };
  const allowed = new Set(['t', 'v', 's', 'i', 'mob', 'touch', 'mode', 'score', 'floor', 'winner', 'dur']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: 'unknown_field' };
  for (const k of ['i', 'mob', 'touch']) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') return { ok: false, error: 'bad_' + k };
  }
  let mode = null;
  if (body.mode !== undefined) {
    if (typeof body.mode !== 'string' || !(opts.modes || []).includes(body.mode)) return { ok: false, error: 'bad_mode' };
    mode = body.mode;
  }
  const score = intOrNull(body.score, 0, 2e9); if (!score.ok) return { ok: false, error: 'bad_score' };
  const floor = intOrNull(body.floor, 0, 1e7); if (!floor.ok) return { ok: false, error: 'bad_floor' };
  const dur = intOrNull(body.dur, 0, 24 * 3600 * 1000); if (!dur.ok) return { ok: false, error: 'bad_dur' };
  let winner = null;
  if (body.winner !== undefined) {
    if (typeof body.winner !== 'string' || !WINNER_RE.test(body.winner)) return { ok: false, error: 'bad_winner' };
    winner = body.winner;
  }
  return {
    ok: true,
    value: {
      type: t, visitor: v, session: s, internal: body.i === true,
      mobile: typeof body.mob === 'boolean' ? body.mob : null,
      touch: typeof body.touch === 'boolean' ? body.touch : null,
      mode, score: score.value, floor: floor.value, winner, durationMs: dur.value,
    },
  };
}

function isInternalRequest(req) {
  const h = String(req.headers['x-internal-traffic'] || '').trim().toLowerCase();
  if (h === '1' || h === 'true' || h === 'yes') return true;
  return INTERNAL_UA_RE.test(String(req.headers['user-agent'] || ''));
}

function sslFor(url) {
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  if (mode === 'require' || mode === 'verify') return { rejectUnauthorized: true };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

function clientKey(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sendJson(res, status, obj, extra = {}) {
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return reject(Object.assign(new Error('too large'), { status: 413 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function tokenOk(req, token) {
  if (!token) return false;
  const given = crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest();
  const want = crypto.createHash('sha256').update('Bearer ' + token).digest();
  return crypto.timingSafeEqual(given, want);
}

/**
 * @param {object} o
 * @param {string} o.databaseUrl
 * @param {string} o.statsToken     STATS_TOKEN (>= 24 chars, else stats are disabled)
 * @param {string[]} o.modes        allowed `mode` values
 * @param {string[]} o.extraTypes   event types beyond visit/game_start/game_end
 * @param {string} [o.onlineType]   event type counted as "online matches" in stats
 */
function createAnalytics(o = {}) {
  const log = o.log || console;
  const opts = { modes: o.modes || [], extraTypes: o.extraTypes || [] };
  const statsToken = o.statsToken && o.statsToken.length >= 24 ? o.statsToken : '';
  const perVisitor = new Limiter(Number(process.env.EVENTS_RATE_MAX) || 120, 10 * 60 * 1000);
  const perIp = new Limiter(Number(process.env.EVENTS_IP_RATE_MAX) || 600, 10 * 60 * 1000);
  const statsLimiter = new Limiter(60, 10 * 60 * 1000);
  const a = { ready: false, configured: !!o.databaseUrl };
  let pool = null, timer = null, stopped = false, delay = 2000;

  if (o.databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: o.databaseUrl, ssl: sslFor(o.databaseUrl), max: 3,
      idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 9000 });
    pool.on('error', (err) => log.error('[analytics] idle client error:', err.message));
  }

  a.init = async function init() {
    if (!pool) return;
    try { await pool.query(SCHEMA); a.ready = true; log.log('[analytics] ready'); }
    catch (err) {
      a.ready = false;
      log.error(`[analytics] init failed (${err.message}); retrying in ${delay / 1000}s`);
      if (!stopped) { timer = setTimeout(a.init, delay); timer.unref && timer.unref(); delay = Math.min(delay * 2, 60000); }
    }
  };

  a.stats = async function stats(days, includeInternal) {
    const r = await pool.query(`
      WITH ev AS (
        SELECT * FROM analytics_events
        WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $1::int - 1)
          AND ($2::boolean OR NOT internal)
      ),
      sess AS (
        SELECT session, min(ts) AS t0, max(ts) AS t1, bool_or(mobile) AS mobile
        FROM ev GROUP BY session
      ),
      vis AS (
        SELECT visitor, min(ts) AS first_in_window, count(DISTINCT (ts AT TIME ZONE 'UTC')::date) AS active_days
        FROM ev GROUP BY visitor
      ),
      ret AS (
        SELECT count(*)::int AS n FROM vis
        WHERE active_days > 1 OR EXISTS (
          SELECT 1 FROM analytics_events p WHERE p.visitor = vis.visitor AND p.ts < vis.first_in_window
            AND ($2::boolean OR NOT p.internal))
      )
      SELECT
        (SELECT count(DISTINCT visitor)::int FROM ev) AS visitors,
        (SELECT count(*)::int FROM sess) AS sessions,
        (SELECT count(*)::int FROM ev WHERE type = 'game_start') AS games_started,
        (SELECT count(*)::int FROM ev WHERE type = 'game_end') AS games_finished,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t1 - t0)) FROM sess) AS median_session_sec,
        (SELECT avg(CASE WHEN mobile THEN 1.0 ELSE 0.0 END) FROM sess WHERE mobile IS NOT NULL) AS mobile_share,
        (SELECT n FROM ret) AS returning_visitors,
        (SELECT count(*)::int FROM ev WHERE type = $3) AS online_matches,
        (SELECT count(*)::int FROM analytics_events
          WHERE internal AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $1::int - 1)) AS internal_events
    `, [days, includeInternal, o.onlineType || '__none__']);
    const daily = await pool.query(`
      SELECT to_char((ts AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
             count(DISTINCT visitor)::int AS visitors, count(DISTINCT session)::int AS sessions,
             count(*) FILTER (WHERE type = 'game_start')::int AS games_started,
             count(*) FILTER (WHERE type = 'game_end')::int AS games_finished
      FROM analytics_events
      WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $1::int - 1)
        AND ($2::boolean OR NOT internal)
      GROUP BY 1 ORDER BY 1`, [days, includeInternal]);
    const modes = await pool.query(`
      SELECT mode, count(*)::int AS n FROM analytics_events
      WHERE type = 'game_start' AND mode IS NOT NULL
        AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $1::int - 1)
        AND ($2::boolean OR NOT internal)
      GROUP BY mode ORDER BY n DESC`, [days, includeInternal]);
    const x = r.rows[0];
    const out = {
      days, timezone: 'UTC', includeInternal,
      uniqueVisitors: x.visitors,
      sessions: x.sessions,
      gamesStarted: x.games_started,
      gamesFinished: x.games_finished,
      medianSessionSec: x.median_session_sec == null ? null : Math.round(Number(x.median_session_sec)),
      mobileShare: x.mobile_share == null ? null : Math.round(Number(x.mobile_share) * 1000) / 1000,
      returningVisitors: x.returning_visitors,
      gameStartsByMode: Object.fromEntries(modes.rows.map((m) => [m.mode, m.n])),
      perDay: daily.rows.map((d) => ({ date: d.day, visitors: d.visitors, sessions: d.sessions,
        gamesStarted: d.games_started, gamesFinished: d.games_finished })),
      internalEventsExcluded: includeInternal ? 0 : x.internal_events,
    };
    if (o.onlineType) out.onlineMatches = x.online_matches;
    return out;
  };

  /** Returns true if the request was handled. */
  a.handle = function handle(req, res, pathname, url) {
    if (pathname === '/api/events') { run(postEvent(req, res)); return true; }
    if (pathname === '/api/stats') { run(getStats(req, res, url)); return true; }
    if (pathname === '/api/stats/internal') { run(markInternal(req, res)); return true; }
    return false;
    function run(p) {
      p.catch((err) => {
        log.error('[analytics] error:', err.message);
        if (!res.headersSent) sendJson(res, 503, { error: 'analytics_unavailable' }); else res.destroy();
      });
    }
  };

  async function postEvent(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'forbidden' }); } catch { return sendJson(res, 403, { error: 'forbidden' }); } }
    let body;
    try { body = await readBody(req, MAX_BODY); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'body_too_large' : 'bad_json' }); }
    const v = validateEvent(body, opts);
    if (!v.ok) return sendJson(res, 400, { error: v.error });
    const ipRl = perIp.hit(clientKey(req)); // in-memory only; IPs are never stored
    const rl = perVisitor.hit(v.value.visitor);
    if (!rl.ok || !ipRl.ok) {
      const ra = String(rl.ok ? ipRl.retryAfterSec : rl.retryAfterSec);
      return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': ra });
    }
    if (!a.ready) return sendJson(res, 503, { error: 'analytics_unavailable' });
    const e = v.value;
    const internal = e.internal || isInternalRequest(req);
    await pool.query(
      `INSERT INTO analytics_events (type, visitor, session, internal, mobile, touch, mode, score, floor, winner, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.type, e.visitor, e.session, internal, e.mobile, e.touch, e.mode, e.score, e.floor, e.winner, e.durationMs]);
    return sendJson(res, 204, null);
  }

  function authStats(req, res) {
    if (!statsToken) { sendJson(res, 404, { error: 'not_found' }); return false; }
    const rl = statsLimiter.hit(clientKey(req));
    if (!rl.ok) { sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rl.retryAfterSec) }); return false; }
    if (!tokenOk(req, statsToken)) { sendJson(res, 401, { error: 'unauthorized' }); return false; }
    if (!a.ready) { sendJson(res, 503, { error: 'analytics_unavailable' }); return false; }
    return true;
  }

  async function getStats(req, res, url) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    if (!authStats(req, res)) return;
    let days = parseInt(url.searchParams.get('days') || '7', 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    days = Math.min(days, 365);
    const inc = /^(1|true|yes)$/i.test(url.searchParams.get('include_internal') || '');
    return sendJson(res, 200, await a.stats(days, inc));
  }

  // Body: {"visitor":"<id>", "internal": true|false} -> re-tags all of that visitor's events.
  async function markInternal(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (!authStats(req, res)) return;
    let body;
    try { body = await readBody(req, MAX_BODY); }
    catch (e) { return sendJson(res, e.status || 400, { error: 'bad_json' }); }
    if (!body || typeof body.visitor !== 'string' || !ID_RE.test(body.visitor)) return sendJson(res, 400, { error: 'bad_visitor' });
    const flag = body.internal !== false;
    const r = await pool.query('UPDATE analytics_events SET internal = $2 WHERE visitor = $1', [body.visitor, flag]);
    return sendJson(res, 200, { ok: true, visitor: body.visitor, internal: flag, updated: r.rowCount });
  }

  a.close = async () => { stopped = true; if (timer) clearTimeout(timer); if (pool) await pool.end().catch(() => {}); };
  return a;
}

module.exports = { createAnalytics, validateEvent, isInternalRequest, SCHEMA };
