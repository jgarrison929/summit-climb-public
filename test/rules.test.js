'use strict';
// Unit tests for the leaderboard rules (no database needed): node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const lb = require('../lib/leaderboard');

const SECRET = 'test-secret-0123456789abcdef'; // gitleaks:allow (dummy test value)

test('token round-trip, forgery and tampering', () => {
  const { token, nonce } = lb.signToken(SECRET, 1700000000000);
  assert.deepEqual(lb.verifyToken(SECRET, token), { nonce, issuedAt: 1700000000000 });
  assert.equal(lb.verifyToken('another-secret-xxxxxxxx', token), null, 'wrong secret');
  const [v, p, s] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ n: nonce, t: 1600000000000 })).toString('base64url');
  assert.equal(lb.verifyToken(SECRET, `${v}.${forgedPayload}.${s}`), null, 'payload swapped');
  assert.equal(lb.verifyToken(SECRET, `${v}.${p}.${s.slice(0, -2)}AA`), null, 'sig changed');
  for (const junk of [undefined, null, 42, '', 'a.b', 'v1..', 'v2.' + p + '.' + s, 'x'.repeat(400)]) {
    assert.equal(lb.verifyToken(SECRET, junk), null, String(junk));
  }
});

test('names: normalisation, charset, length, profanity', () => {
  assert.deepEqual(lb.normalizeName('  joshua  '), { name: 'JOSHUA' });
  assert.deepEqual(lb.normalizeName('a  b'), { name: 'A B' });
  assert.deepEqual(lb.normalizeName('ICE_KING-99!'), { name: 'ICE_KING-99!' });
  assert.equal(lb.normalizeName('').error, 'name_required');
  assert.equal(lb.normalizeName('   ').error, 'name_required');
  assert.equal(lb.normalizeName(123).error, 'name_required');
  assert.equal(lb.normalizeName('ABCDEFGHIJKLM').error, 'name_too_long');
  assert.equal(lb.normalizeName('<script>').error, 'name_charset');
  assert.equal(lb.normalizeName('ÖZIL').error, 'name_charset');
  assert.equal(lb.normalizeName('---').error, 'name_charset');
  assert.equal(lb.normalizeName("BOB');DROP").error, 'name_charset');
  for (const bad of ['FUCK', 'fuuuuck', 'SH1T', 'B1TCH', 'n1gg3r', 'ass', 'CUMLORD', 'xX_FCK_Xx', 'RAPEKING']) {
    assert.equal(lb.normalizeName(bad).error, 'name_not_allowed', bad);
  }
  for (const ok of ['CLASS', 'TITAN', 'SCUMBAG', 'GRAPE', 'THERAPIST', 'TORPEDO', 'SPICE', 'BASS', 'COMET']) {
    assert.ok(lb.normalizeName(ok).name, ok);
  }
});

const run = (o = {}) => ({ score: 0, floor: 0, maxCombo: 0, durationMs: 0, combos: [], ...o });

test('valid runs pass', () => {
  // floor 40 in 60 s, combos 10 and 12 -> 25*40 + 10*10*3 + 10*12*3 = 1000 + 300 + 360
  const r = lb.validateRun(run({ floor: 40, score: 1660, maxCombo: 12, durationMs: 60000, combos: [10, 12] }), 61000);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value, { score: 1660, floor: 40, maxCombo: 12, durationMs: 60000, comboCount: 2 });
  assert.ok(lb.validateRun(run({ floor: 3, score: 75, durationMs: 4000 }), 4000).ok, 'no combos, no maxCombo');
  // paused for an hour: token is much older than the play time - fine
  assert.ok(lb.validateRun(run({ floor: 3, score: 75, durationMs: 4000 }), 3600000).ok);
  // fastest physically possible climb (~6.1 floors/s) passes
  assert.ok(lb.validateRun(run({ floor: 610, score: 15250, durationMs: 100000 }), 100000).ok);
  // smallest legal combo (two 3-floor jumps)
  assert.ok(lb.validateRun(run({ floor: 6, score: 150 + 120, maxCombo: 6, durationMs: 5000, combos: [6] }), 5000).ok);
});

test('score formula: 25 x floor + sum of 10 x f x floor(sqrt(f))', () => {
  assert.equal(lb.HEIGHT_POINTS, 25);
  assert.equal(lb.MIN_COMBO_FLOORS, 6);
  const table = { 6: 120, 8: 160, 9: 270, 15: 450, 16: 640, 24: 960, 25: 1250, 99: 8910, 100: 10000 };
  for (const [f, pts] of Object.entries(table)) assert.equal(lb.comboBonus(Number(f)), pts, 'bonus ' + f);
  assert.equal(lb.scoreFor(40, [10, 12]), 1660);
  assert.equal(lb.scoreFor(7, []), 175);
  // the previous formula (10 x floor + sum of combo^2) is no longer accepted
  const old = lb.validateRun(run({ floor: 40, score: 400 + 100 + 144, maxCombo: 12, durationMs: 60000, combos: [10, 12] }), 61000);
  assert.equal(old.ok, false);
  assert.equal(old.detail, 'score does not match floor and combos');
});

test('impossible runs are rejected', () => {
  const cases = [
    ['score not matching', run({ floor: 40, score: 99999, durationMs: 60000 }), 61000],
    ['combos not matching score', run({ floor: 40, score: 1660, durationMs: 60000, combos: [10, 13] }), 61000, 'score does not match floor and combos'],
    ['floor too fast for time', run({ floor: 500, score: 12500, durationMs: 30000 }), 31000, 'climbed too fast'],
    ['duration longer than token age', run({ floor: 10, score: 250, durationMs: 120000 }), 30000, 'run longer than token age'],
    ['combo bigger than floor', run({ floor: 10, score: 250 + 800, durationMs: 20000, combos: [20] }), 20000, 'bad combo size'],
    ['combo below minimum', run({ floor: 10, score: 250 + 100, durationMs: 20000, combos: [5] }), 20000, 'bad combo size'],
    ['combos exceed floors climbed', run({ floor: 20, score: 500 + 20 * 800, maxCombo: 20, durationMs: 300000, combos: Array(20).fill(20) }), 300000, 'combos exceed floors climbed'],
    ['too many combos for run length', run({ floor: 100, score: 2500 + 24 * 120, maxCombo: 6, durationMs: 20000, combos: Array(24).fill(6) }), 20000, 'too many combos for run length'],
    ['maxCombo mismatch', run({ floor: 40, score: 1660, maxCombo: 30, durationMs: 60000, combos: [10, 12] }), 61000, 'maxCombo mismatch'],
    ['non-integer', run({ floor: 4.5, score: 112, durationMs: 9000 }), 9000],
    ['string numbers', run({ floor: '40', score: '1000', durationMs: 60000 }), 61000],
    ['zero score', run({ floor: 0, score: 0, durationMs: 9000 }), 9000],
    ['negative', run({ floor: -5, score: -125, durationMs: 9000 }), 9000],
    ['huge floor', run({ floor: 1e6, score: 2.5e7, durationMs: 6 * 3600000 }), 6 * 3600000],
    ['duration too long', run({ floor: 10, score: 250, durationMs: 7 * 3600000 }), 8 * 3600000],
    ['expired token', run({ floor: 10, score: 250, durationMs: 20000 }), 13 * 3600000],
    ['token from future', run({ floor: 1, score: 25, durationMs: 0 }), -5000],
    ['combos not array', run({ floor: 10, score: 250, durationMs: 20000, combos: 'x' }), 20000],
  ];
  for (const [label, body, age, detail] of cases) {
    const r = lb.validateRun(body, age);
    assert.equal(r.ok, false, label);
    if (detail) assert.equal(r.detail, detail, label);
  }
});

test('client ip and hashing', () => {
  assert.equal(lb.clientIp({ headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }, socket: {} }), '1.2.3.4');
  assert.equal(lb.clientIp({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }, socket: {} }), '5.6.7.8');
  assert.equal(lb.clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  const h = lb.hashIp(SECRET, '1.2.3.4');
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.notEqual(h, lb.hashIp('other-secret-xxxxxxxxx', '1.2.3.4'));
});

test('rate limiter: 10 per window per key', () => {
  const rl = new lb.RateLimiter(10, 600000);
  const t = 1e12;
  for (let i = 0; i < 10; i++) assert.ok(rl.hit('a', t + i).ok);
  const blocked = rl.hit('a', t + 20);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec > 0);
  assert.ok(rl.hit('b', t + 20).ok, 'other key unaffected');
  assert.ok(rl.hit('a', t + 600001).ok, 'window slides');
  clearInterval(rl.timer);
});
