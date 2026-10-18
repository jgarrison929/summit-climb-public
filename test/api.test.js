'use strict';
// End-to-end API tests against a real server process.
// The DB-backed tests only run when TEST_DATABASE_URL points at a THROWAWAY Postgres database
// (the `scores` table is truncated). Example:
//   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/summittest npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const lb = require('../lib/leaderboard');

const SECRET = 'api-test-secret-0123456789'; // gitleaks:allow (dummy test value)
const DB_URL = process.env.TEST_DATABASE_URL;

function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), RUN_SECRET: SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const ready = () => (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const h = await (await fetch(base + '/health')).json();
        if (!env.DATABASE_URL || h.leaderboard === 'ok') return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become ready:\n' + out);
  })();
  return { base, ready, stop: () => child.kill('SIGTERM'), log: () => out };
}

const post = (base, p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
// a token issued `ageMs` ago, signed with the server's secret (stands in for POST /api/run + real play time)
const oldToken = (ageMs) => lb.signToken(SECRET, Date.now() - ageMs).token;
const runBody = (o) => ({ name: 'TESTER', floor: 40, score: 1660, maxCombo: 12, durationMs: 60000, combos: [10, 12], ...o });

test('without a database: game + health still work, API says unavailable', async () => {
  const s = startServer({});
  try {
    await s.ready();
    const h = await (await fetch(s.base + '/health')).json();
    assert.equal(h.status, 'ok');
    assert.equal(h.leaderboard, 'disabled');
    const idx = await fetch(s.base + '/');
    assert.equal(idx.status, 200);
    assert.match(await idx.text(), /<canvas id="game"/);
    assert.equal((await fetch(s.base + '/api/scores')).status, 503);
    const run = await post(s.base, '/api/run', {});
    assert.equal(run.status, 200);
    const sub = await post(s.base, '/api/scores', runBody({ token: oldToken(61000) }));
    assert.equal(sub.status, 503);
  } finally { s.stop(); }
});

test('without a reachable database: still serves the game', async () => {
  const s = startServer({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' });
  try {
    // the leaderboard never becomes ready here; poll health directly instead
    let h;
    for (let i = 0; i < 50 && !h; i++) { try { h = await (await fetch(s.base + '/health')).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal(h.status, 'ok');
    assert.equal(h.leaderboard, 'unavailable');
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await fetch(s.base + '/api/scores')).status, 503);
  } finally { s.stop(); }
});

test('leaderboard API against Postgres', { skip: !DB_URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { Client } = require('pg');
  const ADMIN = 'admin-token-for-tests-0123456789';
  const s = startServer({ DATABASE_URL: DB_URL, ADMIN_TOKEN: ADMIN });
  try {
    await s.ready();
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query('TRUNCATE scores RESTART IDENTITY');
    await c.end();

    await t.test('run token endpoint', async () => {
      const r = await post(s.base, '/api/run', {});
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.ok(lb.verifyToken(SECRET, j.token));
      assert.equal(j.leaderboard, true);
      assert.equal((await fetch(s.base + '/api/run')).status, 405);
    });

    let firstToken;
    await t.test('valid submission accepted and ranked', async () => {
      firstToken = oldToken(61000);
      const r = await post(s.base, '/api/scores', runBody({ token: firstToken, name: ' first ' }), { 'X-Real-IP': '10.0.0.1' });
      assert.equal(r.status, 201, await r.clone().text());
      const j = await r.json();
      assert.equal(j.rank, 1); assert.equal(j.rankToday, 1); assert.equal(j.total, 1); assert.equal(j.name, 'FIRST');
      const r2 = await post(s.base, '/api/scores', runBody({ token: oldToken(120000), name: 'SECOND', floor: 100, score: 2500 + 1500, combos: [30], maxCombo: 30, durationMs: 110000 }), { 'X-Real-IP': '10.0.0.1' });
      const j2 = await r2.json();
      assert.equal(r2.status, 201); assert.equal(j2.rank, 1); assert.equal(j2.total, 2);
      const r3 = await post(s.base, '/api/scores', runBody({ token: oldToken(30000), name: 'THIRD', floor: 10, score: 250, combos: [], maxCombo: 0, durationMs: 25000 }), { 'X-Real-IP': '10.0.0.1' });
      assert.equal((await r3.json()).rank, 3);
    });

    await t.test('GET returns sorted list, limit capped, today filter', async () => {
      const r = await fetch(s.base + '/api/scores?limit=10');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control'), /max-age=\d+/);
      const j = await r.json();
      assert.deepEqual(j.scores.map((x) => x.name), ['SECOND', 'FIRST', 'THIRD']);
      assert.deepEqual(j.scores.map((x) => x.score), [4000, 1660, 250]);
      assert.ok(j.scores.every((x) => x.floor > 0 && x.createdAt && x.id && !('ip_hash' in x) && !('ipHash' in x)));
      assert.equal((await (await fetch(s.base + '/api/scores?limit=999')).json()).limit, 50);
      assert.equal((await (await fetch(s.base + '/api/scores?limit=2')).json()).scores.length, 2);
      const today = await (await fetch(s.base + '/api/scores?period=today')).json();
      assert.equal(today.period, 'today'); assert.equal(today.scores.length, 3);
    });

    await t.test('reused token rejected', async () => {
      const r = await post(s.base, '/api/scores', runBody({ token: firstToken, name: 'AGAIN' }), { 'X-Real-IP': '10.0.0.2' });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, 'token_used');
    });

    await t.test('forged tokens rejected', async () => {
      const forged = lb.signToken('not-the-server-secret-xx', Date.now() - 61000).token;
      for (const token of [forged, 'v1.abc.def', undefined, firstToken.slice(0, -3) + 'abc']) {
        const r = await post(s.base, '/api/scores', runBody({ token }), { 'X-Real-IP': '10.0.0.3' });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'invalid_token');
      }
    });

    await t.test('impossible score / floor / duration rejected', async () => {
      const bad = [
        runBody({ token: oldToken(61000), score: 999999 }),                                   // score != floor + combos
        runBody({ token: oldToken(61000), floor: 2000, score: 50000, combos: [], maxCombo: 0 }), // too fast
        runBody({ token: oldToken(5000) }),                                                     // claims 60 s on a 5 s token
        runBody({ token: oldToken(61000), combos: [100], score: 1000 + 10000, maxCombo: 100 }),  // combo > floor
      ];
      for (const b of bad) {
        const r = await post(s.base, '/api/scores', b, { 'X-Real-IP': '10.0.0.4' });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'implausible');
      }
    });

    await t.test('bad names rejected without burning the token', async () => {
      const token = oldToken(61000);
      for (const [name, err] of [['', 'name_required'], ['WAYTOOLONGNAME', 'name_too_long'], ['<b>hi</b>', 'name_charset'], ['FUCK', 'name_not_allowed']]) {
        const r = await post(s.base, '/api/scores', runBody({ token, name }), { 'X-Real-IP': '10.0.0.5' });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, err);
      }
      const ok = await post(s.base, '/api/scores', runBody({ token, name: 'NICE' }), { 'X-Real-IP': '10.0.0.5' });
      assert.equal(ok.status, 201);
    });

    await t.test('per-IP rate limit (10 per 10 min)', async () => {
      const codes = [];
      for (let i = 0; i < 12; i++) {
        const r = await post(s.base, '/api/scores', runBody({ token: 'junk' }), { 'X-Real-IP': '10.9.9.9' });
        codes.push(r.status);
      }
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(400));
      assert.deepEqual(codes.slice(10), [429, 429]);
      const other = await post(s.base, '/api/scores', runBody({ token: 'junk' }), { 'X-Real-IP': '10.9.9.10' });
      assert.equal(other.status, 400, 'other IPs unaffected');
    });

    await t.test('body size limit, bad json, cross-origin', async () => {
      const big = await post(s.base, '/api/scores', JSON.stringify({ name: 'X', pad: 'a'.repeat(20000) }), { 'X-Real-IP': '10.0.0.6' });
      assert.equal(big.status, 413);
      const badJson = await post(s.base, '/api/scores', '{nope', { 'X-Real-IP': '10.0.0.6' });
      assert.equal(badJson.status, 400);
      const xo = await post(s.base, '/api/scores', runBody({ token: oldToken(61000) }), { 'X-Real-IP': '10.0.0.6', Origin: 'https://evil.example' });
      assert.equal(xo.status, 403);
    });

    await t.test('stored rows: hashed IP only', async () => {
      const c2 = new Client({ connectionString: DB_URL });
      await c2.connect();
      const rows = (await c2.query('SELECT ip_hash, nonce FROM scores')).rows;
      await c2.end();
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => /^[0-9a-f]{32}$/.test(r.ip_hash) && !r.ip_hash.includes('10.0.0')));
    });

    await t.test('admin delete needs the admin token', async () => {
      const del = (id, auth) => fetch(`${s.base}/api/admin/scores/${id}`, { method: 'DELETE', headers: auth ? { Authorization: auth } : {} });
      assert.equal((await del(1)).status, 401);
      assert.equal((await del(1, 'Bearer wrong')).status, 401);
      assert.equal((await del(1, 'Bearer ' + ADMIN)).status, 200);
      assert.equal((await del(1, 'Bearer ' + ADMIN)).status, 404);
      const j = await (await fetch(s.base + '/api/scores')).json();
      assert.equal(j.scores.length, 3);
      assert.ok(!j.scores.some((x) => x.id === '1'));
    });
  } finally { s.stop(); }
});
