'use strict';
// Analytics endpoint tests against a real server process.
// DB-backed tests run only when TEST_DATABASE_URL points at a THROWAWAY Postgres database
// (the analytics_events table is truncated). Example:
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/evtest node --test <this file>
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { validateEvent } = require(process.env.ANALYTICS_MODULE || '../lib/analytics');

const SERVER = path.join(__dirname, '..', 'server.js');
const GAME_MODE = process.env.ANALYTICS_TEST_MODE || null; // a valid `mode` for this game, if any
const DB_URL = process.env.TEST_DATABASE_URL;
const TOKEN = 'test-stats-token-0123456789abcdef';

function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: String(port), RUN_SECRET: 'api-test-secret-0123456789', STATS_TOKEN: TOKEN, ...env }, // gitleaks:allow (dummy test value)
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/health')).ok && (!env.DATABASE_URL || /\[analytics\] ready/.test(out))) return;
      } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become ready:\n' + out);
  };
  return { base, ready, stop: () => child.kill('SIGTERM'), log: () => out };
}

const rid = () => require('crypto').randomBytes(8).toString('hex');
const ev = (o = {}) => ({ t: 'visit', v: 'visitor' + rid(), s: 'session' + rid(), mob: false, touch: false, ...o });
const post = (base, body, headers = {}) => fetch(base + '/api/events', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const stats = (base, q = '', token = TOKEN) => fetch(base + '/api/stats' + q, { headers: token ? { Authorization: 'Bearer ' + token } : {} });

test('validateEvent: accepts good payloads, rejects bad ones', () => {
  const opts = { modes: GAME_MODE ? [GAME_MODE] : [], extraTypes: [] };
  assert.equal(validateEvent(ev(), opts).ok, true);
  assert.equal(validateEvent(ev({ t: 'game_end', score: 120, floor: 12, dur: 5000 }), opts).ok, true);
  if (GAME_MODE) assert.equal(validateEvent(ev({ t: 'game_start', mode: GAME_MODE }), opts).ok, true);
  const bad = [null, [], 'x', ev({ t: 'nope' }), ev({ v: 'short' }), ev({ s: 'has spaces in it' }), ev({ email: 'a@b.c' }),
    ev({ score: -1 }), ev({ score: '5' }), ev({ dur: 1e12 }), ev({ mode: 'bogus' }), ev({ mob: 'yes' }), ev({ winner: '<script>' })];
  for (const b of bad) assert.equal(validateEvent(b, opts).ok, false, JSON.stringify(b));
});

test('without a database: validation, rate limit and stats auth still enforced', async () => {
  const s = startServer({ EVENTS_RATE_MAX: '3' });
  try {
    await s.ready();
    assert.equal((await post(s.base, ev())).status, 503); // valid but nowhere to store it
    assert.equal((await post(s.base, ev({ t: 'bogus' }))).status, 400);
    assert.equal((await post(s.base, '{not json')).status, 400);
    assert.equal((await post(s.base, ev({ junk: 'x'.repeat(3000) }))).status, 413);
    assert.equal((await post(s.base, ev(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(s.base + '/api/events')).status, 405);
    const v = 'ratelimit' + rid();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(s.base, ev({ v }))).status);
    assert.deepEqual(codes, [503, 503, 503, 429, 429]);
    assert.equal((await post(s.base, ev())).status, 503, 'other visitors are not limited');
    assert.equal((await stats(s.base, '', null)).status, 401);
    assert.equal((await stats(s.base, '', 'wrong-token-wrong-token-wrong')).status, 401);
    assert.equal((await stats(s.base)).status, 503);
  } finally { s.stop(); }
});

test('without STATS_TOKEN: stats endpoint is disabled', async () => {
  const s = startServer({ STATS_TOKEN: '' });
  try {
    await s.ready();
    assert.equal((await stats(s.base)).status, 404);
  } finally { s.stop(); }
});

test('with a database: events are stored and counted, internal traffic excluded', { skip: !DB_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const { Client } = require('pg');
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS analytics_events');
  await c.end();
  const s = startServer({ DATABASE_URL: DB_URL, EVENTS_RATE_MAX: '50' });
  try {
    await s.ready();
    const A = 'visitorA' + rid(), B = 'visitorB' + rid(), I = 'visitorI' + rid();
    const sa = 'sessA' + rid(), sb = 'sessB' + rid();
    const extra = GAME_MODE ? { mode: GAME_MODE } : {};
    for (const b of [
      ev({ v: A, s: sa }), ev({ v: A, s: sa, t: 'game_start', ...extra }), ev({ v: A, s: sa, t: 'game_end', score: 10, dur: 1000 }),
      ev({ v: B, s: sb, mob: true, touch: true }), ev({ v: B, s: sb, t: 'game_start', ...extra }),
      ev({ v: I, i: true }),
    ]) assert.equal((await post(s.base, b)).status, 204);
    assert.equal((await post(s.base, ev({ v: 'visitorH' + rid() }), { 'X-Internal-Traffic': '1' })).status, 204);
    assert.equal((await post(s.base, ev({ v: 'visitorU' + rid() }), { 'User-Agent': 'Mozilla/5.0 internal-playtest' })).status, 204);

    const r = await stats(s.base, '?days=7');
    assert.equal(r.status, 200, s.log());
    const st = await r.json();
    assert.equal(st.uniqueVisitors, 2);
    assert.equal(st.sessions, 2);
    assert.equal(st.gamesStarted, 2);
    assert.equal(st.gamesFinished, 1);
    assert.equal(st.mobileShare, 0.5);
    assert.equal(st.returningVisitors, 0);
    assert.equal(st.internalEventsExcluded, 3);
    assert.equal(st.perDay.length, 1);
    assert.equal(st.perDay[0].visitors, 2);
    if (GAME_MODE) assert.equal(st.gameStartsByMode[GAME_MODE], 2);
    assert.equal(typeof st.medianSessionSec, 'number');

    const all = await (await stats(s.base, '?days=7&include_internal=1')).json();
    assert.equal(all.uniqueVisitors, 5);

    // re-tag a visitor as internal
    const m = await fetch(s.base + '/api/stats/internal', { method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ visitor: B }) });
    assert.equal(m.status, 200);
    assert.equal((await m.json()).updated, 2);
    assert.equal((await (await stats(s.base)).json()).uniqueVisitors, 1);
    assert.equal((await fetch(s.base + '/api/stats/internal', { method: 'POST', body: '{}' })).status, 401);
  } finally { s.stop(); }
});
