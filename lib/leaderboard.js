'use strict';
// Leaderboard rules: run tokens, submission validation, name filter, IP hashing, rate limiting.
// Pure functions (no DB, no HTTP) so they can be unit-tested directly.
const crypto = require('crypto');

// ---------------------------------------------------------------- physics-derived limits
// From public/game.js: GRAV = 0.5 px/tick², MAX_VX = 10, jump speed = 10.4 + |vx| → max 20.4 px/tick,
// floors are >= 80 px apart, physics runs at 60 ticks/s and you can only land while falling.
// Best case is a full-speed jump that lands 5 floors (400 px) up: apex after 40.8 ticks, back down to
// +400 px after ~48.8 ticks → ≈ 0.102 floors/tick ≈ 6.1 floors/s. Every other jump height is slower.
// We allow 7.5 floors/s (+2 floors) so lag, rounding and frame pacing can never reject a real run.
const MAX_FLOORS_PER_SEC = 7.5;
const FLOOR_SLACK = 2;
// A combo needs >= 2 jumps of >= 3 floors. The quickest 3-floor jump (just reaching 240 px) takes ~31 ticks
// (0.52 s), so a combo is >= 6 floors and takes >= ~1.03 s. We allow 0.9 s.
const MIN_COMBO_FLOORS = 6;
const MIN_COMBO_SECONDS = 0.9;
// Scoring (must match public/game.js):
//   score = HEIGHT_POINTS x highest floor + sum over combos of comboBonus(floors)
//   comboBonus(f) = COMBO_UNIT x f x floor(sqrt(f))   (the multiplier grows with the square root of the combo)
const HEIGHT_POINTS = 25;
const COMBO_UNIT = 10;
function isqrt(n) { let r = Math.floor(Math.sqrt(n)); while (r * r > n) r--; while ((r + 1) * (r + 1) <= n) r++; return r; }
const comboMultiplier = (f) => isqrt(f);
const comboBonus = (f) => COMBO_UNIT * f * comboMultiplier(f);
function scoreFor(floor, combos) { let s = HEIGHT_POINTS * floor; for (const c of combos) s += comboBonus(c); return s; }
const RECLIMB_PER_COMBO = 10;

const LIMITS = {
  TOKEN_MAX_AGE_MS: 12 * 60 * 60 * 1000, // a run token is good for 12 h (long pauses are fine)
  MAX_DURATION_MS: 6 * 60 * 60 * 1000,   // 6 h of actual play
  CLOCK_SLACK_MS: 5000,                 // claimed play time may exceed token age by 5 s + 2 %
  CLOCK_SLACK_RATIO: 0.02,
  MAX_FLOOR: 50000,
  MAX_COMBOS: 2000,
  MAX_SCORE: 1e12,
  NAME_MAX: 12,
};

// ---------------------------------------------------------------- run tokens
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(secret, now = Date.now(), nonce = crypto.randomBytes(16).toString('hex')) {
  const payload = b64u(JSON.stringify({ n: nonce, t: now }));
  const sig = crypto.createHmac('sha256', secret).update('run.v1.' + payload).digest('base64url');
  return { token: `v1.${payload}.${sig}`, nonce, issuedAt: now };
}

function verifyToken(secret, token) {
  if (typeof token !== 'string' || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = crypto.createHmac('sha256', secret).update('run.v1.' + parts[1]).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p.n !== 'string' || !/^[0-9a-f]{32}$/.test(p.n) || !Number.isSafeInteger(p.t)) return null;
  return { nonce: p.n, issuedAt: p.t };
}

// ---------------------------------------------------------------- names
const NAME_RE = /^[A-Z0-9 _.\-!?]+$/;
// Basic, deliberately short list. Matched against a de-leeted, letters-only form of the name.
const BANNED_SUBSTRINGS = [
  'fuck', 'fuk', 'fck', 'phuck', 'shit', 'cunt', 'nigg', 'nigga', 'niga', 'faggot', 'fagot', 'bitch', 'biatch',
  'whore', 'slut', 'rape', 'nazi', 'hitler', 'kike', 'chink', 'gook', 'wetback', 'retard',
  'cock', 'dick', 'pussy', 'penis', 'vagina', 'porn', 'twat', 'wank', 'bastard', 'asshole', 'arsehole', 'dildo',
  'jizz', 'tranny', 'molest', 'pedo', 'kkk', 'heil', 'cum',
];
// Short words only rejected when they are the whole name (avoids "CLASS", "TITAN", "SCUMBAG"...).
const BANNED_WHOLE = new Set(['ass', 'arse', 'tit', 'tits', 'fag', 'fags', 'sex', 'anal', 'anus', 'homo', 'coon', 'hoe', 'hoes', 'spic', 'spick']);
const LEET = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '!': 'i', $: 's', '@': 'a' };
// These hide inside ordinary words (SCUM, GRAPE, TORPEDO); only flag them at the start of the name.
const PREFIX_ONLY = new Set(['cum', 'rape', 'pedo']);

function isProfane(name) {
  const lower = name.toLowerCase();
  const leet = lower.replace(/[0-9!$@]/g, (c) => LEET[c] || c);
  const letters = leet.replace(/[^a-z]/g, '');
  const dedup = letters.replace(/(.)\1+/g, '$1');
  for (const form of [letters, dedup]) {
    if (BANNED_WHOLE.has(form)) return true;
    for (const w of BANNED_SUBSTRINGS) {
      if (PREFIX_ONLY.has(w) ? form.startsWith(w) : form.includes(w)) return true;
    }
  }
  return false;
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return { error: 'name_required' };
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
  if (name.length < 1) return { error: 'name_required' };
  if (name.length > LIMITS.NAME_MAX) return { error: 'name_too_long' };
  if (!NAME_RE.test(name) || !/[A-Z0-9]/.test(name)) return { error: 'name_charset' };
  if (isProfane(name)) return { error: 'name_not_allowed' };
  return { name };
}

// ---------------------------------------------------------------- submission validation
const isInt = (v) => Number.isSafeInteger(v);

/**
 * Validate a score submission (everything except token signature/reuse and the name).
 * @param {object} b submitted body: { score, floor, maxCombo, durationMs, combos: number[] }
 * @param {number} tokenAgeMs  now - token.issuedAt
 * @returns {{ok: true, value: object} | {ok: false, error: string, detail?: string}}
 */
function validateRun(b, tokenAgeMs) {
  const bad = (error, detail) => ({ ok: false, error, detail });
  if (!b || typeof b !== 'object') return bad('bad_body');
  const { score, floor, durationMs } = b;
  const combos = b.combos === undefined ? [] : b.combos;
  if (!isInt(score) || !isInt(floor) || !isInt(durationMs)) return bad('bad_fields', 'score, floor and durationMs must be integers');
  if (!Array.isArray(combos) || combos.length > LIMITS.MAX_COMBOS) return bad('bad_fields', 'combos must be an array of at most ' + LIMITS.MAX_COMBOS);
  if (floor < 1 || floor > LIMITS.MAX_FLOOR) return bad('implausible', 'floor out of range');
  if (score < HEIGHT_POINTS || score > LIMITS.MAX_SCORE) return bad('implausible', 'score out of range');
  if (durationMs < 0 || durationMs > LIMITS.MAX_DURATION_MS) return bad('implausible', 'duration out of range');

  // Token age vs claimed play time: game time can't run faster than the wall clock.
  if (!(tokenAgeMs >= 0)) return bad('invalid_token', 'token from the future');
  if (tokenAgeMs > LIMITS.TOKEN_MAX_AGE_MS) return bad('token_expired');
  if (durationMs > tokenAgeMs * (1 + LIMITS.CLOCK_SLACK_RATIO) + LIMITS.CLOCK_SLACK_MS) return bad('implausible', 'run longer than token age');

  // Floor vs time: max climb rate from the physics.
  const sec = durationMs / 1000;
  if (floor > MAX_FLOORS_PER_SEC * sec + FLOOR_SLACK) return bad('implausible', 'climbed too fast');

  // Score breakdown: score = 25*floor + Σ comboBonus(combo), with each combo a legal size.
  let sum = 0, bonus = 0, max = 0;
  for (const c of combos) {
    if (!isInt(c) || c < MIN_COMBO_FLOORS || c > floor) return bad('implausible', 'bad combo size');
    sum += c; bonus += comboBonus(c); if (c > max) max = c;
  }
  if (score !== HEIGHT_POINTS * floor + bonus) return bad('implausible', 'score does not match floor and combos');
  if (b.maxCombo !== undefined && b.maxCombo !== null && b.maxCombo !== max) return bad('implausible', 'maxCombo mismatch');
  if (sum > floor + RECLIMB_PER_COMBO * combos.length) return bad('implausible', 'combos exceed floors climbed');
  if (sum > MAX_FLOORS_PER_SEC * sec + FLOOR_SLACK) return bad('implausible', 'combos too fast');
  if (combos.length > sec / MIN_COMBO_SECONDS + 1) return bad('implausible', 'too many combos for run length');

  return { ok: true, value: { score, floor, maxCombo: max, durationMs, comboCount: combos.length } };
}

// ---------------------------------------------------------------- IPs
function clientIp(req) {
  // Railway's edge sets X-Real-IP to the connecting client. Fall back to the first X-Forwarded-For hop,
  // then the socket address (local runs).
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function hashIp(secret, ip) {
  return crypto.createHmac('sha256', 'ip-salt:' + secret).update(String(ip)).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------- in-memory sliding-window rate limiter
class RateLimiter {
  constructor(max, windowMs, maxKeys = 50000) {
    this.max = max; this.windowMs = windowMs; this.maxKeys = maxKeys;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60000));
    if (this.timer.unref) this.timer.unref();
  }
  /** Records a hit; returns { ok, retryAfterSec }. */
  hit(key, now = Date.now()) {
    const cut = now - this.windowMs;
    let arr = this.hits.get(key);
    if (arr) { while (arr.length && arr[0] <= cut) arr.shift(); }
    else {
      if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
      arr = []; this.hits.set(key, arr);
    }
    if (arr.length >= this.max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + this.windowMs - now) / 1000)) };
    arr.push(now);
    return { ok: true };
  }
  sweep(now = Date.now()) {
    const cut = now - this.windowMs;
    for (const [k, arr] of this.hits) {
      while (arr.length && arr[0] <= cut) arr.shift();
      if (!arr.length) this.hits.delete(k);
    }
  }
}

module.exports = {
  LIMITS, MAX_FLOORS_PER_SEC, FLOOR_SLACK, MIN_COMBO_FLOORS, MIN_COMBO_SECONDS, RECLIMB_PER_COMBO,
  HEIGHT_POINTS, COMBO_UNIT, comboMultiplier, comboBonus, scoreFor,
  signToken, verifyToken, normalizeName, isProfane, validateRun, clientIp, hashIp, RateLimiter,
};
