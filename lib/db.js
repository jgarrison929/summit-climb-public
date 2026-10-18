'use strict';
// Postgres access for the leaderboard. Everything degrades gracefully: if DATABASE_URL is unset or the
// database is unreachable, `ready` stays false and the API answers 503 while the game keeps working.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(12)  NOT NULL,
  score       BIGINT       NOT NULL CHECK (score >= 0),
  floor       INTEGER      NOT NULL CHECK (floor >= 0),
  max_combo   INTEGER      NOT NULL DEFAULT 0,
  combo_count INTEGER      NOT NULL DEFAULT 0,
  duration_ms INTEGER      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ip_hash     VARCHAR(64)  NOT NULL,
  nonce       VARCHAR(64)  NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS scores_rank_idx ON scores (score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS scores_created_idx ON scores (created_at);
`;

const TODAY_SQL = "created_at > now() - interval '24 hours'";

function sslFor(url) {
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  if (mode === 'require' || mode === 'verify') return { rejectUnauthorized: true };
  if (mode === 'no-verify' || mode === 'true') return { rejectUnauthorized: false };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  // Railway private network and local databases don't use TLS; Railway's public TCP proxy uses a
  // self-signed certificate.
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

function createDb(url, log = console) {
  const db = { ready: false, configured: !!url, lastError: null };
  if (!url) {
    db.deleteScore = async (id) => (await q('DELETE FROM scores WHERE id = $1', [id])).rowCount > 0;

  db.close = async () => {};
    return db;
  }
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  pool.on('error', (err) => { db.lastError = err.message; log.error('[db] idle client error:', err.message); });

  let stopped = false, timer = null, delay = 2000;
  async function init() {
    try {
      await pool.query(SCHEMA);
      db.ready = true; db.lastError = null;
      log.log('[db] leaderboard ready');
    } catch (err) {
      db.ready = false; db.lastError = err.message;
      log.error(`[db] init failed (${err.message}); retrying in ${delay / 1000}s`);
      if (!stopped) { timer = setTimeout(init, delay); timer.unref && timer.unref(); delay = Math.min(delay * 2, 30000); }
    }
  }
  db.init = init;

  // Wrap queries so connectivity failures flip `ready` off and trigger re-init.
  async function q(text, params) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|terminat|Connection|timeout/i.test(err.message) && db.ready) {
        db.ready = false; db.lastError = err.message; delay = 2000;
        if (!stopped) { timer = setTimeout(init, 1000); timer.unref && timer.unref(); }
      }
      throw err;
    }
  }

  /** Insert a score; returns the new id, or null if the run nonce was already used. */
  db.insertScore = async (s) => {
    const r = await q(
      `INSERT INTO scores (name, score, floor, max_combo, combo_count, duration_ms, ip_hash, nonce)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING id`,
      [s.name, s.score, s.floor, s.maxCombo, s.comboCount, s.durationMs, s.ipHash, s.nonce]);
    return r.rows.length ? String(r.rows[0].id) : null;
  };

  db.nonceUsed = async (nonce) => (await q('SELECT 1 FROM scores WHERE nonce = $1', [nonce])).rows.length > 0;

  /** Rank (1-based) of a score all-time and in the last 24 h. Ties share the better rank. */
  db.rankOf = async (score) => {
    const r = await q(
      `SELECT
         (SELECT count(*) FROM scores WHERE score > $1)::int + 1 AS rank,
         (SELECT count(*) FROM scores WHERE score > $1 AND ${TODAY_SQL})::int + 1 AS rank_today,
         (SELECT count(*) FROM scores)::int AS total`,
      [score]);
    return { rank: r.rows[0].rank, rankToday: r.rows[0].rank_today, total: r.rows[0].total };
  };

  db.top = async (limit, period) => {
    const where = period === 'today' ? `WHERE ${TODAY_SQL}` : '';
    const r = await q(
      `SELECT id, name, score, floor, created_at FROM scores ${where}
       ORDER BY score DESC, created_at ASC, id ASC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ id: String(x.id), name: x.name, score: Number(x.score), floor: x.floor, createdAt: x.created_at.toISOString() }));
  };

  db.deleteScore = async (id) => (await q('DELETE FROM scores WHERE id = $1', [id])).rowCount > 0;

  db.close = async () => { stopped = true; if (timer) clearTimeout(timer); await pool.end().catch(() => {}); };
  return db;
}

module.exports = { createDb, SCHEMA };
