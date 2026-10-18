/* Summit Climb. Vanilla JS + canvas, procedural art, WebAudio synth sound.
   All art and audio here is original. */
'use strict';
(() => {
  // ---------------------------------------------------------------- constants
  const W = 480, H = 640;
  const WALL = 36, PL = WALL, PR = W - WALL, PW = PR - PL;
  const STEP = 1 / 60;
  const PH = 16;                       // platform thickness
  const HERO_W = 26, HERO_H = 34;
  const ACC = 0.38, TURN = 0.95, FRICTION = 0.45, AIR_ACC = 0.3, MAX_VX = 10;
  const GRAV = 0.5, MAX_FALL = 15, JUMP_BASE = 10.4, JUMP_SCALE = 1.0;
  const COMBO_TICKS = 150;             // 2.5 s combo window
  const COMBO_MIN_JUMP = 3;            // a jump must gain 3+ floors to count toward a combo
  const COMBO_MIN_JUMPS = 2;           // a combo scores once it has 2+ such jumps
  const LEVEL_TICKS = 2400;            // the lava speeds up every 40 s
  const SPEEDS = [0, 0.6, 1.0, 1.4, 1.85, 2.3, 2.8, 3.3];
  const MAX_LEVEL = SPEEDS.length - 1;
  const SCROLL_START_FLOOR = 10;       // scrolling starts at floor 10...
  const SCROLL_START_TICKS = 720;      // ...or after 12 s of play, whichever comes first
  const CAM_FOLLOW_LINE = 0.4;         // camera follows once you climb above 40% of the screen height
  const CAM_FOLLOW_RATE = 0.08;
  const MILESTONE_EVERY = 25;          // every 25th floor is a flagged camp ledge
  const THEME_EVERY = 75;              // a new zone every 75 floors
  // Score (must match lib/leaderboard.js): HEIGHT_POINTS x floor + sum of COMBO_UNIT x f x floor(sqrt(f))
  const HEIGHT_POINTS = 25, COMBO_UNIT = 10;
  const HS_KEY = 'summitclimb.highscores.v1', NAME_KEY = 'summitclimb.name', MUTE_KEY = 'summitclimb.muted';
  const FONT = "'Trebuchet MS', 'Segoe UI', Verdana, 'DejaVu Sans', sans-serif";

  // Zones, in climbing order (a new one every THEME_EVERY floors).
  const THEMES = [
    { name: 'FOOTHILLS', bgTop: '#06210f', bgBot: '#18542d', brick: '#2f7743', wall: '#449456', wallDark: '#1c4a28', plat: '#71c44e', platTop: '#b0ea70', platEdge: '#2f6b1e', deco: 'leaves',  snow: '#c8ff9a' },
    { name: 'CANYON',    bgTop: '#2a1608', bgBot: '#5e3818', brick: '#85552a', wall: '#946035', wallDark: '#4a2c12', plat: '#b77d40', platTop: '#e0a96b', platEdge: '#5e3a17', deco: 'grain',   snow: '#ffd9a0' },
    { name: 'QUARRY',    bgTop: '#17171c', bgBot: '#3d3d49', brick: '#62626f', wall: '#80808d', wallDark: '#383842', plat: '#a2a2ad', platTop: '#d2d2db', platEdge: '#55555f', deco: 'bricks',  snow: '#e0e0ea' },
    { name: 'BLOSSOM',   bgTop: '#3a0d2e', bgBot: '#7d2b61', brick: '#ad4a88', wall: '#d873ad', wallDark: '#7a2a5e', plat: '#ff92c9', platTop: '#ffffff', platEdge: '#c2407e', deco: 'stripes', snow: '#ffd1ec' },
    { name: 'GLACIER',   bgTop: '#0b1f3a', bgBot: '#1f5584', brick: '#4b7fb0', wall: '#6d9cc8', wallDark: '#28496c', plat: '#bfe9ff', platTop: '#ffffff', platEdge: '#4f9ccc', deco: 'icicle',  snow: '#ffffff' },
    { name: 'FOUNDRY',   bgTop: '#0c1216', bgBot: '#26363f', brick: '#45606c', wall: '#62808d', wallDark: '#283840', plat: '#a3b9c4', platTop: '#eaf4f8', platEdge: '#4a5d66', deco: 'rivets',  snow: '#bfe3f0' },
    { name: 'AURORA',    bgTop: '#07021a', bgBot: '#1c0b40', brick: '#352270', wall: '#33206a', wallDark: '#120830', plat: '#1d0c44', platTop: '#ff3df2', platEdge: '#3df2ff', deco: 'neon',    snow: '#ff9df8' },
    { name: 'SUNSPIRE',  bgTop: '#2a1e04', bgBot: '#5e450e', brick: '#937020', wall: '#b88f2c', wallDark: '#5a420c', plat: '#eab932', platTop: '#fff3ad', platEdge: '#9a7410', deco: 'sparkle', snow: '#fff2a8' },
    { name: 'STRATOS',   bgTop: '#2f6fc9', bgBot: '#9dd2ff', brick: '#c4e2ff', wall: '#e3f1ff', wallDark: '#93bce3', plat: '#ffffff', platTop: '#ffffff', platEdge: '#a9c9ea', deco: 'cloud',   snow: '#ffffff' },
  ];

  // Combo praise ladder: [combo floors below which this word is used, word, gradient, size]
  const COMBO_WORDS = [
    [10, 'Step up!', ['#ffffff', '#9fe7ff'], 40],
    [18, 'Climbing!', ['#fff3a0', '#ffb703'], 42],
    [28, 'Sure-footed!', ['#c6ff9a', '#3fbf3f'], 40],
    [40, 'Ridge runner!', ['#a8e6ff', '#2f8cff'], 40],
    [55, 'Sky high!', ['#ffd1f0', '#ff4fa8'], 50],
    [75, 'Peak form!', ['#ffe8a0', '#ff7b00'], 50],
    [105, 'Cloudbreaker!', ['#ffb0b0', '#e01b24'], 42],
    [150, 'Thin air!', ['#e8c6ff', '#8a2be2'], 52],
    [210, 'Stratosphere!', ['#b9fff4', '#00b3a4'], 42],
    [Infinity, 'Summit legend!', ['#ffffff', '#ff2bd6'], 44],
  ];
  const isqrt = (n) => { let r = Math.floor(Math.sqrt(n)); while (r * r > n) r--; while ((r + 1) * (r + 1) <= n) r++; return r; };
  const comboBonus = (f) => COMBO_UNIT * f * isqrt(f);

  // ---------------------------------------------------------------- helpers
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const hash = (n) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  // ---------------------------------------------------------------- canvas / layout
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  let viewScale = 1;
  let isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || false;

  function resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const portrait = vh > vw * 1.05;
    document.body.classList.toggle('touch', isTouch);
    const reserve = isTouch && portrait ? Math.min(150, Math.max(110, vh * 0.2)) : 0;
    const scale = Math.max(0.2, Math.min(vw / W, (vh - reserve) / H));
    const cw = Math.floor(W * scale), ch = Math.floor(H * scale);
    stage.style.width = cw + 'px';
    stage.style.height = ch + 'px';
    stage.style.left = Math.floor((vw - cw) / 2) + 'px';
    stage.style.top = Math.max(0, Math.floor((vh - reserve - ch) / 2)) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    viewScale = canvas.width / W;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));

  function rr(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(str, x, y, o = {}) {
    const size = o.size || 20;
    ctx.font = `${o.weight || 'bold'} ${size}px ${FONT}`;
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.base || 'alphabetic';
    const sw = o.sw === undefined ? Math.max(3, size / 6) : o.sw;
    if (sw > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = sw;
      ctx.strokeStyle = o.stroke || 'rgba(5,10,25,0.9)';
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = o.color || '#fff';
    ctx.fillText(str, x, y);
  }
  function starPath(x, y, r, rot, points = 5) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = rot + (i * Math.PI) / points;
      const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  // ---------------------------------------------------------------- audio (WebAudio synth only)
  let actx = null, master = null, sfxGain = null, musicGain = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* ignore */ }

  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { actx = new AC(); } catch (e) { actx = null; return; }
    master = actx.createGain(); master.gain.value = muted ? 0 : 0.7; master.connect(actx.destination);
    sfxGain = actx.createGain(); sfxGain.gain.value = 0.9; sfxGain.connect(master);
    musicGain = actx.createGain(); musicGain.gain.value = 0.32; musicGain.connect(master);
    noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.5), actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (state === 'playing') music.start();
  }
  function tone(freq, dur, o = {}) {
    if (!actx) return;
    const t0 = o.at !== undefined ? o.at : actx.currentTime + (o.delay || 0);
    const osc = actx.createOscillator(), g = actx.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
    const vol = o.vol || 0.15;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(o.dest || sfxGain);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }
  function noise(dur, o = {}) {
    if (!actx || !noiseBuf) return;
    const t0 = o.at !== undefined ? o.at : actx.currentTime + (o.delay || 0);
    const src = actx.createBufferSource(); src.buffer = noiseBuf;
    const f = actx.createBiquadFilter(); f.type = o.type || 'lowpass'; f.frequency.value = o.freq || 800;
    const g = actx.createGain();
    g.gain.setValueAtTime(o.vol || 0.15, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(o.dest || sfxGain);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const sfx = {
    jump(sp) { const f = 240 + sp * 26; tone(f, 0.16, { type: 'square', vol: 0.1, slide: f * 2.3 }); },
    land(impact) {
      noise(0.08, { vol: Math.min(0.22, 0.04 + impact * 0.012), freq: 520 });
      tone(120, 0.07, { type: 'sine', vol: 0.14, slide: 60 });
    },
    bounce() { tone(680, 0.07, { type: 'triangle', vol: 0.13, slide: 1150 }); },
    comboStep(n) {
      const sc = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
      tone(midi(72 + sc[Math.min(n, sc.length - 1)]), 0.14, { type: 'triangle', vol: 0.14 });
    },
    comboEnd(f) {
      const base = 60 + Math.min(12, Math.floor(f / 15));
      [0, 4, 7, 12, 16].forEach((s, i) => tone(midi(base + s), 0.2, { type: 'square', vol: 0.08, delay: i * 0.065 }));
      if (f >= 25) [24, 28, 31].forEach((s, i) => tone(midi(base + s), 0.25, { type: 'triangle', vol: 0.08, delay: 0.35 + i * 0.06 }));
    },
    lavaRise() {
      noise(0.9, { vol: 0.16, freq: 140 });
      [0, 3, 7, 10].forEach((s, i) => tone(midi(45 + s), 0.3, { type: 'sawtooth', vol: 0.06, delay: 0.1 + i * 0.16, slide: midi(47 + s) }));
    },
    milestone() { [0, 4, 7, 12, 7, 12, 16].forEach((s, i) => tone(midi(67 + s), 0.16, { type: 'square', vol: 0.08, delay: i * 0.09 })); },
    gameOver() { [0, -3, -7, -12, -15].forEach((s, i) => tone(midi(64 + s), 0.32, { type: 'sawtooth', vol: 0.08, delay: i * 0.17 })); },
    start() { [0, 7, 12, 19].forEach((s, i) => tone(midi(64 + s), 0.12, { type: 'square', vol: 0.08, delay: i * 0.07 })); },
    blip() { tone(900, 0.05, { type: 'square', vol: 0.06 }); },
  };
  const music = {
    on: false, next: 0, step: 0, timer: null,
    start() {
      if (!actx) return;
      this.on = true; this.next = actx.currentTime + 0.08; this.step = 0;
      if (!this.timer) this.timer = setInterval(() => this.tick(), 25);
    },
    stop() { this.on = false; },
    tick() {
      if (!this.on || !actx) return;
      const bpm = 132 + Math.max(0, level - 1) * 6;
      const sp = 60 / bpm / 2;
      if (this.next < actx.currentTime - 0.2) this.next = actx.currentTime + 0.05;
      while (this.next < actx.currentTime + 0.15) { this.play(this.step, this.next); this.next += sp; this.step++; }
    },
    play(step, t) {
      const bar = Math.floor(step / 8) % 8, s = step % 8;
      const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]];
      const ch = prog[bar];
      const arp = [0, 1, 2, 1, 2, 1, 0, 1];
      tone(midi(ch[arp[s]] + 12 + (s === 4 ? 12 : 0)), 0.1, { type: 'square', vol: 0.045, at: t, dest: musicGain });
      if (s === 0 || s === 3 || s === 4 || s === 6) tone(midi(ch[0] - 12), 0.18, { type: 'triangle', vol: 0.16, at: t, dest: musicGain });
      if (s % 2 === 1) noise(0.03, { vol: 0.035, freq: 7000, type: 'highpass', at: t, dest: musicGain });
      if (s === 0 || s === 4) noise(0.06, { vol: 0.08, freq: 180, at: t, dest: musicGain });
    },
  };
  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, actx.currentTime, 0.02);
    flash = { text: muted ? 'SOUND OFF' : 'SOUND ON', t: 0 };
  }

  // ---------------------------------------------------------------- input
  const keys = Object.create(null);
  const touch = { left: false, right: false, jump: false };
  const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], JUMP = ['Space', 'ArrowUp', 'KeyW'];
  const held = (list) => list.some((k) => keys[k]);
  const input = {
    get left() { return held(LEFT) || touch.left; },
    get right() { return held(RIGHT) || touch.right; },
    get jump() { return held(JUMP) || touch.jump; },
  };
  let jumpBuffer = 0;

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const c = e.code;
    if (LEFT.includes(c) || RIGHT.includes(c) || JUMP.includes(c) || c === 'ArrowDown') e.preventDefault();
    ensureAudio();
    keys[c] = true;
    if (e.repeat) return;
    if ((state === 'title' || (state === 'gameover' && !naming)) && (LEFT.includes(c) || RIGHT.includes(c))) cycleView(LEFT.includes(c) ? -1 : 1);
    if (JUMP.includes(c)) jumpBuffer = 8;
    if (c === 'KeyM') toggleMute();
    else if (c === 'KeyP' || c === 'Escape') togglePause();
    else if (c === 'Enter' || c === 'NumpadEnter') confirm();
    else if (c === 'Space' && state === 'title') startGame();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; touch.left = touch.right = touch.jump = false; autoPause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !isTouch) { isTouch = true; resize(); }
    ensureAudio();
    if ((state === 'title' || (state === 'gameover' && !naming)) && tabRects.length) {
      const r = canvas.getBoundingClientRect();
      const lx = ((e.clientX - r.left) / r.width) * W, ly = ((e.clientY - r.top) / r.height) * H;
      const hit = tabRects.find((t) => lx >= t.x - 4 && lx <= t.x + t.w + 4 && ly >= t.y - 6 && ly <= t.y + t.h + 6);
      if (hit) { setView(hit.view); return; }
    }
    if (state === 'paused') togglePause();
    else confirm();
  });
  function bindBtn(id, prop) {
    const el = document.getElementById(id);
    const on = (e) => {
      e.preventDefault(); ensureAudio();
      if (prop === 'jump' && (state === 'title' || state === 'gameover')) { confirm(); }
      touch[prop] = true; el.classList.add('active');
      if (prop === 'jump') jumpBuffer = 8;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    const off = () => { touch[prop] = false; el.classList.remove('active'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindBtn('btnLeft', 'left');
  bindBtn('btnRight', 'right');
  bindBtn('btnJump', 'jump');
  document.getElementById('btnPause').addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); togglePause(); });
  document.getElementById('btnMute').addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); toggleMute(); });
  window.addEventListener('touchstart', () => { if (!isTouch) { isTouch = true; resize(); } }, { passive: true });

  // ---------------------------------------------------------------- high scores
  function loadHS() {
    try {
      const a = JSON.parse(localStorage.getItem(HS_KEY) || '[]');
      return Array.isArray(a) ? a.filter((e) => e && typeof e.score === 'number').slice(0, 5) : [];
    } catch (e) { return []; }
  }
  function saveHS(a) { try { localStorage.setItem(HS_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } }
  function qualifiesHS(s) { const a = loadHS(); return s > 0 && (a.length < 5 || s > a[a.length - 1].score); }
  function addHS(name, st) {
    const a = loadHS();
    const e = { name, score: st.total, floor: st.floor, combo: st.best, date: Date.now() };
    a.push(e);
    a.sort((x, y) => y.score - x.score);
    const top = a.slice(0, 5);
    saveHS(top);
    return top.indexOf(e);
  }
  let hsCache = loadHS();

  // ---------------------------------------------------------------- global leaderboard (server API)
  // Everything here fails soft: offline / no database just means the device board is shown instead.
  const BOARD_N = 10;
  const VIEWS = ['all', 'today', 'device'];
  const VIEW_LABEL = { all: 'ALL-TIME', today: 'TODAY', device: 'THIS DEVICE' };
  const board = { all: null, today: null, status: 'loading', fetchedAt: 0, inflight: false };
  let boardView = 'all', boardTouched = false, tabRects = [];
  const run = { id: 0, token: null, state: 'none' };
  let sub = { state: 'idle', rank: 0, rankToday: 0, total: 0, id: null, msg: '' };

  function api(path, opts = {}, timeoutMs = 7000) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
    return fetch(path, { cache: 'no-store', ...opts, signal: ctl && ctl.signal })
      .then(async (r) => { let j = null; try { j = await r.json(); } catch (e) { /* ignore */ } return { status: r.status, ok: r.ok, body: j || {} }; })
      .finally(() => clearTimeout(t));
  }
  function fetchBoards() {
    if (board.inflight || typeof fetch !== 'function') return;
    board.inflight = true;
    const get = (period) => api(`/api/scores?limit=${BOARD_N}&period=${period}`).then((r) => {
      if (!r.ok || !Array.isArray(r.body.scores)) throw new Error('unavailable');
      return r.body.scores;
    });
    Promise.all([get('all'), get('today')]).then(([a, t]) => {
      board.all = a; board.today = t; board.status = 'ok';
    }).catch(() => {
      board.status = 'error';
      if (!boardTouched && boardView !== 'device') boardView = 'device';
    }).finally(() => { board.inflight = false; board.fetchedAt = performance.now(); });
  }
  function requestRunToken() {
    const id = ++run.id;
    run.token = null; run.state = 'pending';
    if (typeof fetch !== 'function') { run.state = 'error'; return; }
    api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => {
        if (id !== run.id) return;
        if (r.ok && typeof r.body.token === 'string') { run.token = r.body.token; run.state = r.body.leaderboard ? 'ok' : 'nodb'; }
        else run.state = 'error';
      })
      .catch(() => { if (id === run.id) run.state = 'error'; });
  }
  function qualifiesGlobal(s) {
    if (s <= 0) return false;
    if (board.status !== 'ok' || !board.all || !board.today) return true; // unknown: let the server decide
    const beats = (list) => list.length < BOARD_N || s > list[list.length - 1].score;
    return beats(board.all) || beats(board.today);
  }
  function setView(v) {
    if (boardView !== v) sfx.blip();
    boardView = v; boardTouched = true;
    if (v !== 'device' && board.status !== 'ok' && !board.inflight) fetchBoards();
  }
  function cycleView(d) { setView(VIEWS[(VIEWS.indexOf(boardView) + d + VIEWS.length) % VIEWS.length]); }
  function boardFocusAfterRun() {
    if (boardTouched) return;
    if (finalStats && finalStats.global && board.status === 'ok') {
      const a = board.all || [];
      boardView = a.length < BOARD_N || finalStats.total > a[a.length - 1].score ? 'all' : 'today';
    } else if (finalStats && finalStats.local) boardView = 'device';
  }
  const NAME_ERRORS = {
    name_required: 'Please enter a name',
    name_too_long: 'Max 12 characters',
    name_charset: 'Letters, numbers and _ - . ! ? only',
    name_not_allowed: 'That name is not allowed - try another',
  };
  function submitGlobal(name, st) {
    if (!st.token || st.total <= 0) return;
    sub.state = 'sending'; sub.msg = 'Submitting to global leaderboard...';
    const body = { token: st.token, name, score: st.total, floor: st.floor, maxCombo: st.best, durationMs: st.durationMs, combos: st.comboList };
    api('/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000)
      .then((r) => {
        if (finalStats !== st) return; // a new run started meanwhile
        if (r.ok) {
          sub = { state: 'ok', rank: r.body.rank, rankToday: r.body.rankToday, total: r.body.total, id: r.body.id, msg: '' };
          if (!boardTouched) boardView = r.body.rank <= BOARD_N || r.body.rankToday > BOARD_N ? 'all' : 'today';
          board.inflight = false; fetchBoards();
          sfx.blip();
        } else if (NAME_ERRORS[r.body.error]) {
          sub.state = 'idle'; sub.msg = '';
          naming = true; showNameEntry(NAME_ERRORS[r.body.error]);
        } else {
          sub.state = 'error';
          sub.msg = r.status === 429 ? 'Too many submissions - try again later'
            : r.status === 503 ? 'Global leaderboard offline - saved on this device'
              : r.body.error === 'token_used' ? 'Score already submitted'
                : 'Score not accepted by the global leaderboard';
        }
      })
      .catch(() => { if (finalStats === st) { sub.state = 'error'; sub.msg = 'Offline - score saved on this device'; } });
  }
  fetchBoards();

  const nameEntry = document.getElementById('nameEntry');
  const nameInput = document.getElementById('nameInput');
  const nameLabel = document.querySelector('#nameForm label');
  const NAME_LABEL = nameLabel ? nameLabel.textContent : '';
  document.getElementById('nameForm').addEventListener('submit', (e) => { e.preventDefault(); submitName(); });
  nameInput.addEventListener('keydown', (e) => e.stopPropagation());
  nameInput.addEventListener('input', () => {
    const clean = nameInput.value.toUpperCase().replace(/[^A-Z0-9 _.\-!?]/g, '').slice(0, 12);
    if (clean !== nameInput.value) nameInput.value = clean;
  });
  function showNameEntry(err) {
    nameShown = true;
    nameEntry.classList.remove('hidden');
    if (nameLabel) { nameLabel.textContent = err || NAME_LABEL; nameLabel.classList.toggle('error', !!err); }
    let last = nameInput.value;
    if (!err) { try { last = localStorage.getItem(NAME_KEY) || ''; } catch (e) { /* ignore */ } }
    nameInput.value = last;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
  }
  function submitName() {
    if (!naming) return;
    const name = (nameInput.value.replace(/\s+/g, ' ').trim() || 'PLAYER').toUpperCase().slice(0, 12);
    if (!/[A-Z0-9]/.test(name)) { showNameEntry(NAME_ERRORS.name_charset); return; }
    try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* ignore */ }
    if (finalStats.local && !finalStats.localSaved) {
      lastEntry = addHS(name, finalStats);
      finalStats.localSaved = true;
      hsCache = loadHS();
    }
    submitGlobal(name, finalStats);
    naming = false; nameShown = false;
    nameEntry.classList.add('hidden');
    nameInput.blur();
    restartLock = 25;
    sfx.blip();
  }

  // ---------------------------------------------------------------- game state
  let state = 'title';
  let plats = [], drawStart = 0, camY = 0, prevCamY = 0;
  let hero = null;
  let highest = 0, comboScore = 0, combosCount = 0, bestCombo = 0, comboList = [];
  const combo = { active: false, floors: 0, jumps: 0, timer: 0 };
  let scrolling = false, level = 0, levelTimer = 0, ticks = 0;
  let popups = [], banners = [], particles = [], floaters = [];
  let shake = 0, goTimer = 0, finalStats = null, naming = false, nameShown = false, lastEntry = -1, restartLock = 0;
  let titleT = 0, flash = null;
  const snow = [];
  const bgCur = {}, BG_KEYS = ['bgTop', 'bgBot', 'brick', 'wall', 'wallDark', 'snow'];
  for (const k of BG_KEYS) bgCur[k] = hexToRgb(THEMES[0][k]);
  for (let i = 0; i < 70; i++) snow.push({ x: Math.random() * W, y: Math.random() * H, r: rand(0.8, 2.6), s: rand(0.3, 1.2), ph: Math.random() * 6.28 });

  function genFloor(i) {
    const prev = plats[i - 1];
    if (i === 0) { plats[0] = { floor: 0, y: 0, x: PL, w: PW, theme: 0 }; return; }
    const gap = 80 + Math.min(16, Math.floor(i / 50) * 2);
    const y = prev.y - gap;
    let x, w;
    const camp = i % MILESTONE_EVERY === 0;
    if (camp) w = Math.round(PW * 0.62); // camp ledge: wide, but never wall to wall
    else {
      const base = Math.max(58, 150 - i * 0.3);
      w = Math.round(clamp(base + rand(-25, 25), 52, 190));
    }
    const minSpread = camp ? 0 : Math.min(180, 40 + i * 0.4);
    let tries = 0;
    do { x = PL + Math.random() * (PW - w); tries++; }
    while (prev.w < PW && Math.abs(x + w / 2 - (prev.x + prev.w / 2)) < minSpread && tries < 14);
    x = Math.round(x);
    plats[i] = { floor: i, y, x, w, camp, theme: Math.floor(i / THEME_EVERY) % THEMES.length };
  }
  function ensurePlatforms() {
    if (plats.length === 0) genFloor(0);
    while (plats[plats.length - 1].y > camY - 240) genFloor(plats.length);
    while (drawStart < plats.length - 1 && plats[drawStart].y - camY > H + 120) drawStart++;
  }
  function newHero() {
    return { x: W / 2, y: 0, px: W / 2, py: 0, vx: 0, vy: 0, onGround: true, plat: 0, lastFloor: 0, coyote: 0,
      angle: 0, spin: 0, sqx: 1, sqy: 1, facing: 1, run: 0, blink: 0 };
  }
  function resetWorld() {
    plats = []; drawStart = 0;
    camY = -H + 56; prevCamY = camY;
    ensurePlatforms();
    hero = newHero();
    highest = 0; comboScore = 0; combosCount = 0; bestCombo = 0; comboList = [];
    combo.active = false; combo.floors = 0; combo.jumps = 0; combo.timer = 0;
    scrolling = false; level = 0; levelTimer = 0; ticks = 0;
    popups = []; banners = []; particles = []; floaters = [];
    shake = 0; goTimer = 0; finalStats = null; naming = false; nameShown = false; lastEntry = -1;
    for (const k of BG_KEYS) bgCur[k] = hexToRgb(THEMES[0][k]);
  }
  const score = () => highest * HEIGHT_POINTS + comboScore;

  function startGame() {
    resetWorld();
    requestRunToken();
    state = 'playing';
    jumpBuffer = 0;
    nameEntry.classList.add('hidden');
    sfx.start();
    music.start();
    if (window.analytics) window.analytics.gameStart();
  }
  function confirm() {
    if (state === 'title') startGame();
    else if (state === 'gameover' && canRestart()) startGame();
    else if (state === 'paused') togglePause();
  }
  const canRestart = () => state === 'gameover' && !naming && goTimer > 50 && restartLock <= 0;
  function togglePause() {
    if (state === 'playing') { state = 'paused'; music.stop(); for (const k in keys) keys[k] = false; }
    else if (state === 'paused') { state = 'playing'; music.start(); }
  }
  function autoPause() { if (state === 'playing') togglePause(); }

  // ---------------------------------------------------------------- simulation
  const overlaps = (h, p) => h.x + HERO_W / 2 - 5 > p.x && h.x - HERO_W / 2 + 5 < p.x + p.w;

  function doJump() {
    const h = hero;
    const sp = Math.abs(h.vx);
    h.vy = -(JUMP_BASE + sp * JUMP_SCALE);
    h.onGround = false; h.coyote = 0; jumpBuffer = 0;
    h.sqx = 0.78; h.sqy = 1.25;
    h.angle = 0; h.spin = 0;
    if (combo.active && sp >= 7) {
      const air = (2 * -h.vy) / GRAV;
      const turns = Math.max(1, Math.round(air / 50));
      h.spin = (h.vx >= 0 ? 1 : -1) * (turns * Math.PI * 2) / air;
    }
    for (let i = 0; i < 6; i++) particles.push({ x: h.x + rand(-8, 8), y: h.y, vx: rand(-1.2, 1.2), vy: rand(-1.2, -0.2), g: 0.02, life: 22, max: 22, size: rand(2, 4), color: '#ffffff', type: 'dust' });
    sfx.jump(sp);
  }

  function land(p) {
    const h = hero;
    const impact = h.vy;
    h.y = p.y; h.vy = 0; h.onGround = true; h.plat = p.floor;
    h.spin = 0;
    h.angle = ((h.angle % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    h.sqx = 1 + Math.min(0.35, impact * 0.022); h.sqy = 1 - Math.min(0.3, impact * 0.018);
    const diff = p.floor - h.lastFloor;
    h.lastFloor = p.floor;
    if (diff >= COMBO_MIN_JUMP) {
      if (!combo.active) { combo.active = true; combo.floors = 0; combo.jumps = 0; }
      combo.floors += diff; combo.jumps++; combo.timer = COMBO_TICKS;
      sfx.comboStep(combo.jumps);
      floaters.push({ x: h.x, y: h.y - HERO_H - 6, text: '+' + diff, life: 50, max: 50, color: combo.jumps >= COMBO_MIN_JUMPS ? '#ffd23f' : '#bfe9ff' });
      if (combo.jumps >= COMBO_MIN_JUMPS) for (let i = 0; i < 6; i++) particles.push(starParticle(h.x, h.y - 10, 3));
    } else if (combo.active) {
      endCombo();
    }
    if (p.floor > highest) {
      const old = highest; highest = p.floor;
      if (Math.floor(highest / THEME_EVERY) > Math.floor(old / THEME_EVERY)) {
        const th = THEMES[Math.floor(highest / THEME_EVERY) % THEMES.length];
        banners.push({ text: th.name, sub: 'NOW ENTERING \u00B7 FLOOR ' + Math.floor(highest / THEME_EVERY) * THEME_EVERY, color: ['#ffffff', '#7fd3ff'], t: 0, life: 170, y: H * 0.6 });
        sfx.milestone();
      } else if (Math.floor(highest / MILESTONE_EVERY) > Math.floor(old / MILESTONE_EVERY)) {
        floaters.push({ x: W / 2, y: h.y - HERO_H - 30, text: 'CAMP ' + Math.floor(highest / MILESTONE_EVERY) * MILESTONE_EVERY, life: 80, max: 80, color: '#9dff7a' });
        sfx.milestone();
      }
      if (!scrolling && highest >= SCROLL_START_FLOOR) startScrolling();
    }
    const n = Math.min(10, 3 + Math.floor(impact / 2));
    for (let i = 0; i < n; i++) particles.push({ x: h.x + rand(-10, 10), y: h.y - 1, vx: rand(-2, 2), vy: rand(-1.6, -0.3), g: 0.06, life: 24, max: 24, size: rand(2, 4), color: bgCur.snow ? rgb(bgCur.snow) : '#fff', type: 'dust' });
    sfx.land(impact);
  }

  function starParticle(x, y, spd) {
    const a = Math.random() * Math.PI * 2, s = rand(1, spd);
    const colors = ['#ffd23f', '#ff6b9a', '#7fd3ff', '#9dff7a', '#ffffff'];
    return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, g: 0.08, life: 45, max: 45, size: rand(3, 6), color: colors[(Math.random() * colors.length) | 0], type: 'star', rot: Math.random() * 6, vr: rand(-0.2, 0.2) };
  }

  function startScrolling() {
    scrolling = true; level = 1; levelTimer = 0;
    banners.push({ text: 'THE LAVA STIRS', sub: 'KEEP CLIMBING!', color: ['#fff3a0', '#ff7b00'], t: 0, life: 130, y: 160, style: 'ribbon' });
  }

  function comboWord(f) { for (const c of COMBO_WORDS) if (f < c[0]) return c; return COMBO_WORDS[COMBO_WORDS.length - 1]; }

  function endCombo() {
    if (!combo.active) return;
    const f = combo.floors, j = combo.jumps;
    combo.active = false; combo.timer = 0; combo.floors = 0; combo.jumps = 0;
    if (j >= COMBO_MIN_JUMPS) {
      const pts = comboBonus(f);
      comboScore += pts; combosCount++; comboList.push(f);
      if (f > bestCombo) bestCombo = f;
      const w = comboWord(f);
      popups = [{ text: w[1], sub: `${f} FLOORS \u00D7${isqrt(f)}  +${pts}`, color: w[2], size: w[3], t: 0, life: 110 }];
      for (let i = 0; i < Math.min(40, 12 + f); i++) particles.push(starParticle(hero.x, hero.y - HERO_H / 2, 6));
      shake = Math.min(8, 2 + f / 10);
      sfx.comboEnd(f);
    }
  }

  function updateHero() {
    const h = hero;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (h.onGround) {
      if (dir !== 0) {
        if (h.vx !== 0 && Math.sign(h.vx) !== dir) h.vx += dir * TURN;
        else h.vx += dir * ACC;
      } else {
        h.vx -= Math.sign(h.vx) * Math.min(Math.abs(h.vx), FRICTION);
      }
    } else if (dir !== 0) {
      h.vx += dir * AIR_ACC;
    }
    h.vx = clamp(h.vx, -MAX_VX, MAX_VX);
    if (dir !== 0) h.facing = dir;
    else if (Math.abs(h.vx) > 0.5) h.facing = Math.sign(h.vx);

    if (h.onGround) {
      const p = plats[h.plat];
      if (!p || !overlaps(h, p)) { h.onGround = false; h.coyote = 6; }
    } else if (h.coyote > 0) h.coyote--;

    if (jumpBuffer > 0) jumpBuffer--;
    if ((jumpBuffer > 0 || input.jump) && (h.onGround || h.coyote > 0)) doJump();

    const oldY = h.y;
    h.x += h.vx;
    if (h.onGround) { h.y = plats[h.plat].y; h.vy = 0; }
    else { h.vy = Math.min(h.vy + GRAV, MAX_FALL); h.y += h.vy; }

    // side walls: bounce, reversing horizontal speed
    const half = HERO_W / 2;
    if (h.x - half < PL || h.x + half > PR) {
      const leftSide = h.x - half < PL;
      h.x = leftSide ? PL + half : PR - half;
      if ((leftSide && h.vx < 0) || (!leftSide && h.vx > 0)) {
        if (Math.abs(h.vx) > 1.5) {
          h.vx = -h.vx;
          h.facing = Math.sign(h.vx);
          sfx.bounce();
          for (let i = 0; i < 5; i++) particles.push({ x: leftSide ? PL : PR, y: h.y - HERO_H / 2 + rand(-8, 8), vx: (leftSide ? 1 : -1) * rand(0.5, 2.5), vy: rand(-1.5, 1.5), g: 0.03, life: 18, max: 18, size: rand(1.5, 3), color: '#ffffff', type: 'spark' });
        } else h.vx = 0;
      }
    }

    // landing (only while falling, one-way platforms)
    if (!h.onGround && h.vy >= 0) {
      let best = null;
      for (let i = drawStart; i < plats.length; i++) {
        const p = plats[i];
        if (oldY <= p.y + 0.01 && h.y >= p.y && overlaps(h, p) && (!best || p.y < best.y)) best = p;
      }
      if (best) land(best);
    }

    // animation
    if (h.onGround) {
      h.run += Math.abs(h.vx) * 0.09;
      h.angle *= 0.55;
      if (Math.abs(h.angle) < 0.01) h.angle = 0;
    } else {
      h.angle += h.spin;
      if (h.spin && ticks % 2 === 0) particles.push({ x: h.x + rand(-6, 6), y: h.y - HERO_H / 2 + rand(-6, 6), vx: 0, vy: 0, g: 0, life: 20, max: 20, size: rand(2, 4), color: '#ffd23f', type: 'star', rot: 0, vr: 0.1 });
    }
    h.sqx = lerp(h.sqx, 1, 0.2); h.sqy = lerp(h.sqy, 1, 0.2);
  }

  function updateCamera() {
    if (scrolling) {
      levelTimer++;
      if (levelTimer >= LEVEL_TICKS) {
        levelTimer = 0;
        if (level < MAX_LEVEL) {
          level++;
          banners.push({ text: 'LAVA RISING', sub: 'PACE ' + level + ' OF ' + MAX_LEVEL, color: ['#ffe08a', '#ff3b1f'], t: 0, life: 150, y: 160, style: 'ribbon' });
          sfx.lavaRise();
        }
      }
      camY -= SPEEDS[level];
    }
    // climbing above the follow line: the camera eases up after you
    const target = hero.y - HERO_H - H * CAM_FOLLOW_LINE;
    if (target < camY) camY += (target - camY) * CAM_FOLLOW_RATE;
  }

  function updateFx() {
    for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life--; if (p.rot !== undefined) p.rot += p.vr; }
    particles = particles.filter((p) => p.life > 0);
    if (particles.length > 400) particles.splice(0, particles.length - 400);
    for (const f of floaters) { f.y -= 0.7; f.life--; }
    floaters = floaters.filter((f) => f.life > 0);
    for (const p of popups) p.t++;
    popups = popups.filter((p) => p.t < p.life);
    for (const b of banners) b.t++;
    banners = banners.filter((b) => b.t < b.life);
    shake *= 0.86; if (shake < 0.1) shake = 0;
  }

  function updateSnow() {
    const dCam = prevCamY - camY;
    for (const f of snow) {
      f.y += f.s + dCam * (0.35 + f.r * 0.15);
      f.x += Math.sin(titleT * 0.02 + f.ph) * 0.35;
      if (f.y > H + 4) { f.y = -4; f.x = Math.random() * W; }
      if (f.x < -4) f.x = W + 4; else if (f.x > W + 4) f.x = -4;
    }
  }

  function updateBgColors() {
    let floor = 0;
    for (let i = drawStart; i < plats.length; i++) { if (plats[i].y - camY < H / 2) { floor = i; break; } }
    const th = THEMES[Math.floor(floor / THEME_EVERY) % THEMES.length];
    for (const k of BG_KEYS) {
      const t = hexToRgb(th[k]);
      for (let c = 0; c < 3; c++) bgCur[k][c] = lerp(bgCur[k][c], t[c], 0.03);
    }
  }

  function gameOver() {
    endCombo();
    state = 'gameover';
    goTimer = 0;
    music.stop();
    sfx.gameOver();
    finalStats = { floor: highest, floorPts: highest * HEIGHT_POINTS, comboPts: comboScore, best: bestCombo, combos: combosCount, total: score(), time: ticks / 60,
      durationMs: Math.round((ticks * 1000) / 60), comboList: comboList.slice(), run: run.id, token: run.token };
    if (window.analytics) window.analytics.gameEnd({ score: finalStats.total, floor: finalStats.floor, dur: finalStats.durationMs });
    finalStats.local = qualifiesHS(finalStats.total);
    finalStats.global = !!run.token && qualifiesGlobal(finalStats.total);
    naming = finalStats.local || finalStats.global;
    nameShown = false;
    lastEntry = -1;
    restartLock = 0;
    sub = { state: run.token ? 'idle' : 'notoken', rank: 0, rankToday: 0, total: 0, id: null, msg: '' };
    if (!naming && finalStats.total > 0 && !run.token && run.state === 'error') sub.msg = 'Global leaderboard offline';
    boardFocusAfterRun();
  }

  function step() {
    titleT++;
    if ((state === 'title' || state === 'gameover') && !board.inflight && performance.now() - board.fetchedAt > 60000) fetchBoards();
    if (flash) { flash.t++; if (flash.t > 70) flash = null; }
    if (state === 'paused') return;
    prevCamY = camY;
    hero.px = hero.x; hero.py = hero.y;
    if (state === 'title') {
      if (hero.vx === 0) hero.vx = 1.4;
      hero.x += hero.vx;
      if (hero.x < PL + 30 || hero.x > PR - 30) { hero.vx = -hero.vx; hero.x = clamp(hero.x, PL + 30, PR - 30); }
      hero.facing = Math.sign(hero.vx);
      hero.run += Math.abs(hero.vx) * 0.09;
      updateFx();
    } else if (state === 'playing') {
      ticks++;
      if (!scrolling && ticks >= SCROLL_START_TICKS) startScrolling();
      updateHero();
      updateCamera();
      if (combo.active) { combo.timer--; if (combo.timer <= 0) endCombo(); }
      ensurePlatforms();
      updateFx();
      if (hero.y - HERO_H > camY + H + 8) gameOver();
    } else if (state === 'gameover') {
      goTimer++;
      if (restartLock > 0) restartLock--;
      hero.vy = Math.min(hero.vy + GRAV, MAX_FALL); hero.y += hero.vy;
      updateFx();
      if (naming && !nameShown && goTimer > 45) showNameEntry();
    }
    updateBgColors();
    updateSnow();
  }

  // ---------------------------------------------------------------- rendering
  function drawBackground(cam) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(bgCur.bgTop)); g.addColorStop(1, rgb(bgCur.bgBot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // far brick wall (parallax 0.5)
    const par = cam * 0.5, bh = 24, bw = 48;
    ctx.strokeStyle = rgb(bgCur.brick, 0.35); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = Math.floor(par / bh); r * bh - par < H; r++) {
      const y = Math.round(r * bh - par) + 0.5;
      ctx.moveTo(PL, y); ctx.lineTo(PR, y);
      const off = (r & 1) ? bw / 2 : 0;
      for (let x = PL - off; x < PR; x += bw) { if (x > PL) { ctx.moveTo(Math.round(x) + 0.5, y); ctx.lineTo(Math.round(x) + 0.5, y + bh); } }
    }
    ctx.stroke();

    // arched windows (parallax 0.5)
    const sp = 300;
    for (let k = Math.floor((par - 100) / sp); k * sp - par < H + 100; k++) {
      const y = k * sp - par + 60;
      const x = PL + 30 + hash(k) * (PW - 110);
      drawWindow(x, y, k);
    }
    // soft vignette near walls
    const v = ctx.createLinearGradient(PL, 0, PR, 0);
    v.addColorStop(0, 'rgba(0,0,0,0.35)'); v.addColorStop(0.15, 'rgba(0,0,0,0)');
    v.addColorStop(0.85, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = v; ctx.fillRect(PL, 0, PW, H);
  }

  function drawWindow(x, y, k) {
    const w = 48, h = 70;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y + h); ctx.lineTo(x, y + w / 2); ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#061028'); g.addColorStop(1, '#1b2d5a');
    ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 5; i++) {
      const sx = x + hash(k * 7 + i) * w, sy = y + hash(k * 13 + i) * h;
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(titleT * 0.03 + i + k));
      ctx.fillRect(sx, sy, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
    if (hash(k * 3.3) > 0.55) { ctx.fillStyle = '#fff6c8'; ctx.beginPath(); ctx.arc(x + w * 0.65, y + 22, 8, 0, 7); ctx.fill(); ctx.fillStyle = '#061028'; ctx.beginPath(); ctx.arc(x + w * 0.65 + 4, y + 19, 7, 0, 7); ctx.fill(); }
    ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = rgb(bgCur.wallDark, 0.9); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = rgb(bgCur.brick, 0.8);
    ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.moveTo(x, y + h * 0.55); ctx.lineTo(x + w, y + h * 0.55); ctx.stroke();
    ctx.fillStyle = rgb(bgCur.wallDark); ctx.fillRect(x - 5, y + h, w + 10, 6);
    ctx.restore();
  }

  function drawWalls(cam) {
    for (let side = 0; side < 2; side++) {
      const x0 = side === 0 ? 0 : PR;
      const g = ctx.createLinearGradient(x0, 0, x0 + WALL, 0);
      if (side === 0) { g.addColorStop(0, rgb(bgCur.wallDark)); g.addColorStop(0.75, rgb(bgCur.wall)); g.addColorStop(1, rgb(bgCur.wallDark)); }
      else { g.addColorStop(0, rgb(bgCur.wallDark)); g.addColorStop(0.25, rgb(bgCur.wall)); g.addColorStop(1, rgb(bgCur.wallDark)); }
      ctx.fillStyle = g; ctx.fillRect(x0, 0, WALL, H);
      const bh = 28;
      ctx.strokeStyle = rgb(bgCur.wallDark, 0.8); ctx.lineWidth = 2;
      ctx.beginPath();
      for (let r = Math.floor(cam / bh); r * bh - cam < H; r++) {
        const y = Math.round(r * bh - cam);
        ctx.moveTo(x0, y); ctx.lineTo(x0 + WALL, y);
        const xm = x0 + ((r & 1) ? WALL * 0.35 : WALL * 0.75);
        ctx.moveTo(xm, y); ctx.lineTo(xm, y + bh);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = Math.floor(cam / bh); r * bh - cam < H; r++) { const y = Math.round(r * bh - cam) + 2.5; ctx.moveTo(x0 + 2, y); ctx.lineTo(x0 + WALL - 2, y); }
      ctx.stroke();
    }
    // shadows cast onto the tower interior + bright inner edges
    let s = ctx.createLinearGradient(PL, 0, PL + 16, 0);
    s.addColorStop(0, 'rgba(0,0,0,0.4)'); s.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = s; ctx.fillRect(PL, 0, 16, H);
    s = ctx.createLinearGradient(PR - 16, 0, PR, 0);
    s.addColorStop(0, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = s; ctx.fillRect(PR - 16, 0, 16, H);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(PL - 2, 0, 2, H); ctx.fillRect(PR, 0, 2, H);
  }

  function drawPlatform(p, y) {
    const th = THEMES[p.theme];
    const x = p.x, w = p.w;
    if (p.floor === 0) {
      const g = ctx.createLinearGradient(0, y, 0, H);
      g.addColorStop(0, th.platEdge); g.addColorStop(1, rgb(bgCur.wallDark));
      ctx.fillStyle = g; ctx.fillRect(x, y, w, H - y + 60);
      ctx.fillStyle = th.plat; ctx.fillRect(x, y, w, PH);
      ctx.fillStyle = th.platTop; ctx.fillRect(x, y, w, 5);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 2; ctx.beginPath();
      for (let r = 0; r < 4; r++) { const yy = y + PH + r * 22; ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); for (let xx = x + ((r & 1) ? 20 : 44); xx < x + w; xx += 48) { ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 22); } }
      ctx.stroke();
      return;
    }
    const camp = p.camp;
    // drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(x + 3, y + 5, w, PH, 6); ctx.fill();
    // body
    rr(x, y, w, PH, 6); ctx.fillStyle = th.plat; ctx.fill();
    ctx.save(); rr(x, y, w, PH, 6); ctx.clip();
    switch (th.deco) {
      case 'grain':
        ctx.strokeStyle = 'rgba(70,35,10,0.45)'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(x, y + 9.5); ctx.lineTo(x + w, y + 9.5);
        for (let i = 30 + (p.floor % 3) * 7; i < w; i += 38) { ctx.moveTo(x + i + 0.5, y + 4); ctx.lineTo(x + i + 0.5, y + PH); }
        ctx.stroke(); break;
      case 'bricks':
        ctx.strokeStyle = 'rgba(40,40,50,0.5)'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(x, y + 10.5); ctx.lineTo(x + w, y + 10.5);
        for (let i = 12; i < w; i += 24) { ctx.moveTo(x + i + 0.5, y + 4); ctx.lineTo(x + i + 0.5, y + 10.5); ctx.moveTo(x + i + 12.5, y + 10.5); ctx.lineTo(x + i + 12.5, y + PH); }
        ctx.stroke(); break;
      case 'rivets':
        ctx.fillStyle = 'rgba(40,55,62,0.35)'; ctx.fillRect(x, y + 8, w, 3);
        ctx.fillStyle = th.platEdge;
        for (let i = 8; i < w - 4; i += 26) { ctx.beginPath(); ctx.arc(x + i, y + 10, 2, 0, 7); ctx.fill(); }
        break;
      case 'stripes':
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (let i = -PH; i < w + PH; i += 16) { ctx.beginPath(); ctx.moveTo(x + i, y + PH); ctx.lineTo(x + i + 7, y + PH); ctx.lineTo(x + i + 7 + PH, y); ctx.lineTo(x + i + PH, y); ctx.fill(); }
        break;
      case 'neon':
        ctx.fillStyle = 'rgba(61,242,255,0.12)'; ctx.fillRect(x, y, w, PH);
        break;
      case 'sparkle':
        ctx.fillStyle = 'rgba(160,110,0,0.3)'; ctx.fillRect(x, y + 10, w, 2);
        break;
      default: break;
    }
    ctx.restore();
    ctx.fillStyle = th.platTop; rr(x + 1, y, w - 2, 5, 3); ctx.fill();
    ctx.fillStyle = th.platEdge; ctx.fillRect(x + 4, y + PH - 3, w - 8, 3);

    // outer decorations
    switch (th.deco) {
      case 'icicle':
        ctx.fillStyle = 'rgba(225,247,255,0.92)';
        for (let i = 6; i < w - 8; i += 11) {
          const len = 4 + ((p.floor * 7 + i * 13) % 10);
          ctx.beginPath(); ctx.moveTo(x + i, y + PH - 2); ctx.lineTo(x + i + 7, y + PH - 2); ctx.lineTo(x + i + 3.5, y + PH - 2 + len); ctx.fill();
        }
        ctx.fillStyle = '#ffffff';
        for (let i = 4; i < w - 4; i += 18) { ctx.beginPath(); ctx.ellipse(x + i + 5, y + 1, 7 + ((p.floor + i) % 4), 3.2, 0, 0, Math.PI * 2); ctx.fill(); }
        break;
      case 'leaves':
        ctx.strokeStyle = '#2f6b1e'; ctx.lineWidth = 2;
        for (let i = 10; i < w - 6; i += 34) {
          const len = 8 + ((p.floor * 5 + i) % 14);
          ctx.beginPath(); ctx.moveTo(x + i, y + PH); ctx.quadraticCurveTo(x + i + 4, y + PH + len / 2, x + i, y + PH + len); ctx.stroke();
          ctx.fillStyle = '#4fae3a'; ctx.beginPath(); ctx.ellipse(x + i + 3, y + PH + len, 4, 2.5, 0.6, 0, 7); ctx.fill();
        }
        ctx.fillStyle = '#8fdc55';
        for (let i = 6; i < w - 4; i += 20) { ctx.beginPath(); ctx.ellipse(x + i, y + 1, 6, 3, -0.3, 0, 7); ctx.fill(); }
        break;
      case 'neon':
        ctx.save(); ctx.shadowColor = th.platTop; ctx.shadowBlur = 12; ctx.strokeStyle = th.platTop; ctx.lineWidth = 2;
        rr(x + 1, y + 1, w - 2, PH - 2, 6); ctx.stroke();
        ctx.shadowColor = th.platEdge; ctx.strokeStyle = th.platEdge; ctx.beginPath(); ctx.moveTo(x + 6, y + PH - 4); ctx.lineTo(x + w - 6, y + PH - 4); ctx.stroke();
        ctx.restore(); break;
      case 'sparkle':
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < Math.max(2, w / 40); i++) {
          const sx = x + 6 + hash(p.floor * 17 + i) * (w - 12), sy = y + 3 + hash(p.floor * 23 + i) * 8;
          const a = Math.max(0, Math.sin(titleT * 0.08 + i * 2 + p.floor));
          ctx.globalAlpha = a; starPath(sx, sy, 3.5, titleT * 0.02, 4); ctx.fill();
        }
        ctx.globalAlpha = 1; break;
      case 'cloud':
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < w; i += 16) {
          const r = 6 + ((p.floor * 3 + i) % 5);
          ctx.beginPath(); ctx.arc(x + i + 6, y + 3, r, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(x + i + 10, y + PH - 2, r * 0.8, 0, 7); ctx.fill();
        }
        break;
      default: break;
    }

    if (camp) {
      // camp ledge: striped edge + a flag pole with a pennant carrying the floor number
      const zone = p.floor % THEME_EVERY === 0;
      ctx.save(); rr(x, y, w, PH, 6); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = -PH; i < w; i += 22) { ctx.beginPath(); ctx.moveTo(x + i, y + PH); ctx.lineTo(x + i + 8, y + PH); ctx.lineTo(x + i + 8 + PH, y + 5); ctx.lineTo(x + i + PH, y + 5); ctx.fill(); }
      ctx.restore();
      const left = (p.floor / MILESTONE_EVERY) % 2 === 0;
      const px = left ? x + 14 : x + w - 14, top = y - 46;
      ctx.fillStyle = '#3b2a1a'; ctx.fillRect(px - 1.5, top, 3, 46);
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(px, top, 3, 0, 7); ctx.fill();
      const dir = left ? 1 : -1, fw = zone ? 62 : 50, fh = 22, wave = Math.sin(titleT * 0.12 + p.floor) * 3;
      ctx.beginPath();
      ctx.moveTo(px, top + 2);
      ctx.quadraticCurveTo(px + dir * fw * 0.5, top + 2 + wave, px + dir * fw, top + fh / 2 + 2);
      ctx.quadraticCurveTo(px + dir * fw * 0.5, top + fh + 2 - wave, px, top + fh + 2);
      ctx.closePath();
      ctx.fillStyle = zone ? '#e63946' : '#2a9d8f'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke();
      text(String(p.floor), px + dir * fw * 0.42, top + fh / 2 + 3, { size: zone ? 13 : 12, color: '#ffffff', sw: 2.5, base: 'middle' });
    } else {
      ctx.globalAlpha = 0.75;
      text(String(p.floor), x + 7, y + 13.5, { size: 9, align: 'left', color: th.deco === 'neon' ? '#3df2ff' : th.platEdge, sw: 0 });
      ctx.globalAlpha = 1;
    }
  }

  function drawPlatforms(cam) {
    for (let i = drawStart; i < plats.length; i++) {
      const p = plats[i];
      const sy = p.y - cam;
      if (sy > H + 40) continue;
      if (sy < -70) break;
      drawPlatform(p, Math.round(sy));
    }
  }

  function drawHero(x, y, h) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(h.sqx, h.sqy);
    ctx.translate(0, -HERO_H / 2);
    ctx.rotate(h.angle);
    const f = h.facing || 1;
    const air = !h.onGround && state !== 'title';
    const runAmt = air ? 0 : Math.min(1, Math.abs(h.vx) / 3);
    const ph = h.run;
    const bob = air ? 0 : Math.abs(Math.sin(ph)) * 1.5 * runAmt;
    ctx.translate(0, -bob);

    // backpack (on the side away from where the climber faces), with a rope coil
    const bx = -f * 11;
    ctx.fillStyle = '#6a4c93'; rr(bx - 6, -6, 12, 17, 4); ctx.fill();
    ctx.fillStyle = '#4a2f73'; rr(bx - 6, 4, 12, 4, 2); ctx.fill();
    ctx.strokeStyle = '#e9c46a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(bx, -8, 5, 3, 0, 0, 7); ctx.stroke();

    // boots
    ctx.fillStyle = '#5c3d2e';
    if (air) {
      ctx.beginPath(); ctx.ellipse(-6, 13, 5.5, 3.5, -0.3, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(6, 11, 5.5, 3.5, 0.3, 0, 7); ctx.fill();
    } else {
      const a = Math.sin(ph) * 6 * runAmt, b = -a;
      ctx.beginPath(); ctx.ellipse(-5 + a * f, 15 - Math.max(0, Math.cos(ph)) * 3 * runAmt, 6, 3.5, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(5 + b * f, 15 - Math.max(0, -Math.cos(ph)) * 3 * runAmt, 6, 3.5, 0, 0, 7); ctx.fill();
    }
    // trousers
    ctx.fillStyle = '#264653'; rr(-7, 7, 14, 7, 3); ctx.fill();
    // body (shell jacket)
    const bg = ctx.createLinearGradient(0, -4, 0, 12);
    bg.addColorStop(0, '#43c6ac'); bg.addColorStop(1, '#1d7a6a');
    ctx.fillStyle = bg; rr(-10, -4, 20, 15, 6); ctx.fill();
    ctx.fillStyle = '#e9c46a'; ctx.fillRect(-10, 2, 20, 2.5); // chest strap
    // arms / gloves
    const swing = air ? 0 : Math.sin(ph) * 5 * runAmt;
    ctx.fillStyle = '#f4a261';
    if (air) {
      ctx.beginPath(); ctx.arc(-12, -9, 3.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(12, -9, 3.6, 0, 7); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(-12 + swing * f * 0.4, 4 - swing * 0.3, 3.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(12 - swing * f * 0.4, 4 + swing * 0.3, 3.6, 0, 7); ctx.fill();
    }
    // head
    ctx.fillStyle = '#e8b48a'; ctx.beginPath(); ctx.arc(0, -13, 9.5, 0, Math.PI * 2); ctx.fill();
    // eyes
    const blink = titleT % 200 < 6;
    const ex = f * 3;
    if (blink) {
      ctx.strokeStyle = '#1b1b2f'; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.moveTo(ex - 5, -13); ctx.lineTo(ex - 2, -13); ctx.moveTo(ex + 2, -13); ctx.lineTo(ex + 5, -13); ctx.stroke();
    } else {
      ctx.fillStyle = '#1b1b2f';
      const py = air ? (h.vy < 0 ? -1 : 1) : 0;
      ctx.beginPath(); ctx.arc(ex - 3 + f * 0.8, -13 + py, 1.7, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + 3 + f * 0.8, -13 + py, 1.7, 0, 7); ctx.fill();
    }
    // mouth
    ctx.strokeStyle = '#7a2e1f'; ctx.lineWidth = 1.4; ctx.beginPath();
    if (air && h.vy < 0) { ctx.arc(ex, -8, 1.6, 0, 7); }
    else { ctx.moveTo(ex - 2.5, -8.5); ctx.lineTo(ex + 2.5, -8.5); }
    ctx.stroke();
    // climbing helmet with a headlamp
    ctx.fillStyle = '#f77f00';
    ctx.beginPath(); ctx.ellipse(0, -16, 11, 9, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.ellipse(-3, -21, 4, 2, -0.4, 0, 7); ctx.fill();
    ctx.fillStyle = '#d62828'; ctx.fillRect(-11.5, -17, 23, 2.5); // brim
    ctx.strokeStyle = '#1b1b2f'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-9, -15); ctx.quadraticCurveTo(0, -3, 9, -15); ctx.stroke(); // chin strap
    const lx = f * 7;
    ctx.fillStyle = '#fff6b0'; ctx.beginPath(); ctx.arc(lx, -19, 2.6, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,246,176,0.18)';
    ctx.beginPath(); ctx.moveTo(lx, -19); ctx.lineTo(lx + f * 26, -27); ctx.lineTo(lx + f * 26, -11); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawParticles(cam) {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const y = p.y - cam;
      if (p.type === 'star') { starPath(p.x, y, p.size * (0.5 + a * 0.5), p.rot || 0); ctx.fill(); }
      else if (p.type === 'spark') { ctx.fillRect(p.x - p.size / 2, y - p.size / 2, p.size, p.size); }
      else { ctx.beginPath(); ctx.arc(p.x, y, p.size * (1.6 - a * 0.6), 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    for (const f of floaters) {
      ctx.globalAlpha = clamp(f.life / 25, 0, 1);
      text(f.text, f.x, f.y - cam, { size: 16, color: f.color, sw: 4 });
    }
    ctx.globalAlpha = 1;
  }

  // heat haze along the bottom edge: falling below the screen ends the run
  function drawLava() {
    const hgt = 14 + level * 4 + Math.sin(titleT * 0.08) * 3;
    const lg = ctx.createLinearGradient(0, H - hgt * 2.2, 0, H);
    lg.addColorStop(0, 'rgba(255,80,0,0)'); lg.addColorStop(0.6, 'rgba(255,80,0,0.28)'); lg.addColorStop(1, 'rgba(255,200,60,0.65)');
    ctx.fillStyle = lg; ctx.fillRect(0, H - hgt * 2.2, W, hgt * 2.2);
    ctx.fillStyle = 'rgba(255,120,20,0.85)';
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, H - hgt * 0.45 - Math.sin(titleT * 0.09 + x * 0.05) * 3);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }

  function drawSnow() {
    ctx.fillStyle = rgb(bgCur.snow, 0.75);
    for (const f of snow) { ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
  }

  function drawHUD() {
    // lava pace meter: fills toward the next speed-up, one ember per pace level
    const mx = 14, my = 18, mw = 96, mh = 18;
    const warn = scrolling && level < MAX_LEVEL && levelTimer > LEVEL_TICKS - 180;
    const jig = warn ? Math.sin(titleT * 1.3) * 1.2 : 0;
    ctx.save(); ctx.translate(jig, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; rr(mx - 3, my - 3, mw + 6, mh + 6, 9); ctx.fill();
    const frac = !scrolling ? 0 : level >= MAX_LEVEL ? 1 : levelTimer / LEVEL_TICKS;
    if (frac > 0) {
      const lw = Math.max(6, mw * frac);
      const lg = ctx.createLinearGradient(mx, 0, mx + mw, 0);
      lg.addColorStop(0, '#7a0c02'); lg.addColorStop(0.55, '#ff4d00'); lg.addColorStop(1, '#ffd23f');
      ctx.save(); rr(mx, my, mw, mh, 7); ctx.clip();
      ctx.fillStyle = lg; ctx.fillRect(mx, my, lw, mh);
      ctx.fillStyle = 'rgba(255,240,170,0.75)';
      for (let i = 0; i < 5; i++) {
        const bx2 = mx + ((i * 23 + titleT * (0.6 + i * 0.15)) % Math.max(8, lw));
        const by2 = my + mh - ((titleT * 0.5 + i * 7) % mh);
        ctx.beginPath(); ctx.arc(bx2, by2, 1.6 + (i % 2), 0, 7); ctx.fill();
      }
      ctx.restore();
    }
    ctx.strokeStyle = warn && titleT % 20 < 10 ? '#ffb3a8' : 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; rr(mx, my, mw, mh, 7); ctx.stroke();
    ctx.restore();
    for (let i = 1; i <= MAX_LEVEL; i++) {
      const on = i <= level, ex2 = mx + 6 + (i - 1) * 14, ey2 = my + mh + 12;
      ctx.fillStyle = on ? `hsl(${45 - ((i - 1) / (MAX_LEVEL - 1)) * 45},100%,${55 + Math.sin(titleT * 0.2 + i) * 6}%)` : 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.moveTo(ex2, ey2 - 7); ctx.quadraticCurveTo(ex2 + 5, ey2 - 1, ex2, ey2 + 3); ctx.quadraticCurveTo(ex2 - 5, ey2 - 1, ex2, ey2 - 7); ctx.fill();
    }
    text(scrolling ? 'LAVA \u00B7 PACE ' + level : 'LAVA \u00B7 DORMANT', mx + mw / 2, my + mh + 30, { size: 10, color: '#ffcf9e', sw: 3 });

    // combo meter
    const bx = 16, by = 84, bw = 16, bh = 190;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; rr(bx - 3, by - 3, bw + 6, bh + 6, 8); ctx.fill();
    const frac2 = combo.active ? combo.timer / COMBO_TICKS : 0;
    if (frac2 > 0) {
      const fh = bh * frac2;
      const cg = ctx.createLinearGradient(0, by + bh, 0, by);
      cg.addColorStop(0, '#ff3b3b'); cg.addColorStop(0.5, '#ffd23f'); cg.addColorStop(1, '#7dff6b');
      ctx.fillStyle = cg; rr(bx, by + bh - fh, bw, fh, 5); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; rr(bx, by, bw, bh, 5); ctx.stroke();
    text('COMBO', bx + bw / 2, by + bh + 18, { size: 9, color: '#cfe9ff', sw: 3 });
    if (combo.active) {
      const pulse = 1 + Math.max(0, 1 - (COMBO_TICKS - combo.timer) / 10) * 0.4;
      ctx.save(); ctx.translate(bx + bw + 10, by + 22); ctx.scale(pulse, pulse);
      text(String(combo.floors), 0, 0, { size: 26, align: 'left', color: combo.jumps >= COMBO_MIN_JUMPS ? '#ffd23f' : '#bfe9ff', sw: 5 });
      ctx.restore();
      text('x' + combo.jumps, bx + bw + 11, by + 40, { size: 12, align: 'left', color: '#ffffff', sw: 3 });
    }

    // floor + score
    text('FLOOR', W - 14, 22, { size: 11, align: 'right', color: '#cfe9ff', sw: 3 });
    text(String(highest), W - 14, 52, { size: 32, align: 'right', color: '#ffffff', sw: 6 });
    text('SCORE', W - 14, 74, { size: 11, align: 'right', color: '#cfe9ff', sw: 3 });
    text(String(score()), W - 14, 98, { size: 22, align: 'right', color: '#ffd23f', sw: 5 });
    if (muted) text('MUTED (M)', W - 14, H - 12, { size: 10, align: 'right', color: '#ff9b9b', sw: 3 });
  }

  function gradText(str, x, y, size, colors, sw = 8) {
    const g = ctx.createLinearGradient(0, y - size * 0.8, 0, y);
    g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
    text(str, x, y, { size, color: g, sw, stroke: '#140a2a' });
  }

  function drawPopups() {
    for (const p of popups) {
      const t = p.t;
      const a = t < p.life - 25 ? 1 : (p.life - t) / 25;
      const s = t < 8 ? 0.3 + (t / 8) * 1.0 : t < 16 ? 1.3 - ((t - 8) / 8) * 0.3 : 1;
      ctx.save();
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.translate(W / 2, H * 0.36 - t * 0.2);
      ctx.rotate(Math.sin(t * 0.12) * 0.05);
      ctx.scale(s, s);
      gradText(p.text, 0, 0, p.size, p.color, 9);
      text(p.sub, 0, 30, { size: 18, color: '#ffffff', sw: 5 });
      ctx.restore();
    }
    for (const b of banners) {
      const t = b.t;
      if (b.style === 'ribbon') {
        // drops in from the top as a full-width heat ribbon, then lifts away
        const k2 = t < 16 ? easeOut(t / 16) : t > b.life - 16 ? easeOut((b.life - t) / 16) : 1;
        const ry = lerp(-60, b.y, k2);
        ctx.save();
        ctx.globalAlpha = clamp(k2, 0, 1);
        const rg = ctx.createLinearGradient(0, ry - 28, 0, ry + 22);
        rg.addColorStop(0, 'rgba(120,18,0,0.9)'); rg.addColorStop(1, 'rgba(255,90,0,0.85)');
        ctx.fillStyle = rg; ctx.fillRect(0, ry - 28, W, 50);
        ctx.fillStyle = '#ffd23f';
        for (let i = 0; i < W; i += 24) { ctx.beginPath(); ctx.moveTo(i, ry + 22); ctx.lineTo(i + 12, ry + 30 + Math.sin(titleT * 0.3 + i) * 3); ctx.lineTo(i + 24, ry + 22); ctx.fill(); }
        text(b.text, W / 2, ry + 2, { size: 28, color: '#fff7d6', sw: 6, stroke: '#4a0a00', weight: 'italic 900' });
        if (b.sub) text(b.sub, W / 2, ry + 17, { size: 11, color: '#ffe8b0', sw: 3, stroke: '#4a0a00' });
        ctx.restore();
        continue;
      }
      let x;
      if (t < 18) x = lerp(W + 220, W / 2, easeOut(t / 18));
      else if (t > b.life - 18) x = lerp(W / 2, -220, 1 - easeOut((b.life - t) / 18));
      else x = W / 2;
      const s = 1 + Math.sin(t * 0.3) * 0.04;
      ctx.save(); ctx.translate(x, b.y); ctx.scale(s, s);
      gradText(b.text, 0, 0, 46, b.color, 9);
      if (b.sub) text(b.sub, 0, 30, { size: 20, color: '#ffffff', sw: 5 });
      ctx.restore();
    }
    if (flash) {
      ctx.globalAlpha = clamp((70 - flash.t) / 20, 0, 1);
      text(flash.text, W / 2, H - 40, { size: 16, color: '#ffffff', sw: 4 });
      ctx.globalAlpha = 1;
    }
  }

  function drawLogo(cx, y) {
    const bob = Math.sin(titleT * 0.04) * 3;
    ctx.save();
    ctx.translate(cx, y + bob);
    // mountain range behind the words
    ctx.fillStyle = 'rgba(38,70,83,0.85)';
    ctx.beginPath(); ctx.moveTo(-190, 40);
    [[-140, -20], [-95, 10], [-40, -78], [10, -10], [60, -50], [120, 5], [165, -30], [200, 40]].forEach(([px, py]) => ctx.lineTo(px, py));
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.moveTo(-56, -56); ctx.lineTo(-40, -78); ctx.lineTo(-24, -56); ctx.lineTo(-34, -60); ctx.lineTo(-40, -54); ctx.lineTo(-47, -61); ctx.closePath(); ctx.fill();
    const lines = [['SUMMIT', 70, 0], ['CLIMB', 76, 72]];
    for (const [word, size, dy] of lines) {
      ctx.font = `900 ${size}px ${FONT}`;
      const wdt = ctx.measureText(word).width;
      const g = ctx.createLinearGradient(0, dy - size * 0.75, 0, dy);
      g.addColorStop(0, '#fff6d6'); g.addColorStop(0.45, '#ffc46b'); g.addColorStop(1, '#e85d04');
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      ctx.lineWidth = 12; ctx.strokeStyle = '#0a1a3a'; ctx.strokeText(word, 0, dy);
      ctx.lineWidth = 4; ctx.strokeStyle = '#fff1d6'; ctx.strokeText(word, 0, dy);
      ctx.fillStyle = g; ctx.fillText(word, 0, dy);
      // snow cap
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < wdt - 6; i += 12) {
        const ix = -wdt / 2 + 6 + i;
        ctx.beginPath(); ctx.ellipse(ix, dy - size * 0.72, 7 + hash(i * 3 + dy) * 3, 4, 0, 0, 7); ctx.fill();
      }
    }
    // sparkle
    const sa = Math.abs(Math.sin(titleT * 0.05));
    ctx.globalAlpha = sa; ctx.fillStyle = '#ffffff';
    starPath(100, -40, 9 * sa + 2, titleT * 0.03, 4); ctx.fill();
    starPath(-118, 52, 7 * (1 - sa) + 2, -titleT * 0.03, 4); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Leaderboard block: tabs (ALL-TIME / TODAY / THIS DEVICE) + up to 10 rows.
  function drawBoard(x0, x1, yTabs, yRows, stepY, offY, inGameOver) {
    // tabs
    const tabs = [['all', 88], ['today', 66], ['device', 106]];
    const gap = 8, th = 20;
    let tx = W / 2 - (tabs.reduce((a, t) => a + t[1], 0) + gap * (tabs.length - 1)) / 2;
    tabRects = [];
    for (const [v, tw] of tabs) {
      const on = boardView === v;
      rr(tx, yTabs, tw, th, 10);
      ctx.fillStyle = on ? '#ffd23f' : 'rgba(127,211,255,0.12)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = on ? '#fff3b0' : 'rgba(127,211,255,0.55)'; ctx.stroke();
      text(VIEW_LABEL[v], tx + tw / 2, yTabs + th / 2 + 1, { size: 11, color: on ? '#2a1a00' : '#cfe9ff', sw: 0, base: 'middle' });
      tabRects.push({ view: v, x: tx, y: yTabs + offY, w: tw, h: th });
      tx += tw + gap;
    }
    // rows
    const global = boardView !== 'device';
    const list = global ? (board[boardView] || []) : hsCache;
    const msg = (a, b) => {
      text(a, W / 2, yRows + 30, { size: 14, color: '#cfe9ff', sw: 3 });
      if (b) text(b, W / 2, yRows + 52, { size: 12, color: '#9fd3ff', sw: 3, weight: 'normal' });
    };
    if (global && board.status === 'loading' && !board[boardView]) return msg('Loading leaderboard...');
    if (global && board.status === 'error' && !board[boardView]) return msg('Global leaderboard unavailable', isTouch ? 'Tap THIS DEVICE for your local scores' : 'Press \u25C0 \u25B6 for your local scores');
    if (list.length === 0) return msg(boardView === 'today' ? 'No scores today - be the first!' : 'No scores yet - be the first!');
    for (let i = 0; i < list.length && i < BOARD_N; i++) {
      const e = list[i], y = yRows + i * stepY;
      const mine = global ? (sub.id && e.id === sub.id && inGameOver) : (inGameOver && i === lastEntry);
      if (mine) {
        ctx.fillStyle = `rgba(255,210,63,${0.25 + 0.15 * Math.sin(titleT * 0.15)})`;
        rr(x0 - 8, y - stepY + 4, x1 - x0 + 16, stepY, 6); ctx.fill();
      }
      const col = i === 0 ? '#ffd23f' : i < 3 ? '#fff3c4' : '#ffffff';
      const sz = stepY < 19 ? 14 : 15;
      text(`${i + 1}.`, x0 + 18, y, { size: sz, align: 'right', color: col, sw: 3 });
      text(String(e.name || 'PLAYER').slice(0, 12), x0 + 26, y, { size: sz, align: 'left', color: col, sw: 3 });
      text(`fl ${e.floor || 0}`, x0 + 196, y, { size: 12, align: 'left', color: '#9fd3ff', sw: 3 });
      text(String(e.score), x1, y, { size: sz, align: 'right', color: col, sw: 3 });
    }
  }

  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(6,16,36,0.82)'; rr(x, y, w, h, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(127,211,255,0.7)'; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawTitle() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(3,10,25,0.55)'); g.addColorStop(0.85, 'rgba(3,10,25,0.35)'); g.addColorStop(1, 'rgba(3,10,25,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    drawLogo(W / 2, 112);
    text('climb as high as you can', W / 2, 218, { size: 14, color: '#bfe9ff', sw: 3, weight: 'italic bold' });
    const blink = 0.55 + 0.45 * Math.sin(titleT * 0.12);
    ctx.globalAlpha = blink;
    text(isTouch ? 'TAP TO START' : 'PRESS ENTER TO START', W / 2, 252, { size: 24, color: '#ffd23f', sw: 6 });
    ctx.globalAlpha = 1;

    panel(56, 264, 368, 92);
    const lines = isTouch
      ? [['MOVE', '\u25C0 \u25B6 buttons'], ['JUMP', 'JUMP button (hold to keep jumping)'], ['TIP', 'Run fast = jump higher!'], ['COMBO', 'Chain jumps of 3+ floors'], ['', 'II pause  \u00B7  \u266B sound']]
      : [['MOVE', '\u2190 \u2192  or  A D'], ['JUMP', 'SPACE / \u2191 / W'], ['TIP', 'Run fast = big jumps. Bounce off walls!'], ['COMBO', 'Chain jumps of 3+ floors!'], ['', 'P / Esc pause  \u00B7  M mute']];
    lines.forEach(([k, v], i) => {
      const y = 282 + i * 16;
      if (k) text(k, 72, y, { size: 12, align: 'left', color: '#7fd3ff', sw: 0 });
      text(v, k ? 130 : W / 2, y, { size: 13, align: k ? 'left' : 'center', color: '#ffffff', sw: 0, weight: k ? 'bold' : 'normal' });
    });

    panel(56, 364, 368, 256);
    text('LEADERBOARD', W / 2, 386, { size: 16, color: '#ffd23f', sw: 4 });
    drawBoard(80, 400, 396, 434, 18, 0, false);
    text('Original art \u00B7 synthesized sound', W / 2, H - 10, { size: 9, color: 'rgba(255,255,255,0.75)', sw: 3 });
  }

  function drawPause() {
    ctx.fillStyle = 'rgba(3,10,25,0.6)'; ctx.fillRect(0, 0, W, H);
    gradText('PAUSED', W / 2, H / 2 - 10, 56, ['#ffffff', '#7fd3ff'], 10);
    text(isTouch ? 'Tap to resume' : 'Press P / Esc / Enter to resume', W / 2, H / 2 + 30, { size: 16, color: '#ffffff', sw: 4 });
    text('M toggles sound', W / 2, H / 2 + 54, { size: 12, color: '#cfe9ff', sw: 3 });
  }

  function drawGameOver() {
    const a = Math.min(1, goTimer / 30);
    ctx.fillStyle = `rgba(3,8,20,${0.62 * a})`; ctx.fillRect(0, 0, W, H);
    if (goTimer < 12 || !finalStats) return;
    const k = easeOut((goTimer - 12) / 20);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.translate(0, (1 - k) * -30);
    panel(40, 52, 400, 540);
    gradText('GAME OVER', W / 2, 102, 44, ['#ffe08a', '#ff4b3e'], 10);
    const st = finalStats;
    const mm = Math.floor(st.time / 60), ss = Math.floor(st.time % 60);
    const rows = [
      ['Highest floor', String(st.floor)],
      ['Height points (floor \u00D7 25)', String(st.floorPts)],
      ['Combo bonus (10 \u00D7 floors \u00D7 \u230A\u221Afloors\u230B)', String(st.comboPts)],
      ['Best combo', st.best ? st.best + ' floors' : '-'],
      ['Combos landed', String(st.combos)],
      ['Time', `${mm}:${String(ss).padStart(2, '0')}`],
    ];
    rows.forEach(([l, v], i) => {
      const y = 134 + i * 21;
      text(l, 70, y, { size: 13, align: 'left', color: '#cfe9ff', sw: 0, weight: 'normal' });
      text(v, 410, y, { size: 14, align: 'right', color: '#ffffff', sw: 0 });
    });
    ctx.strokeStyle = 'rgba(127,211,255,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(66, 250); ctx.lineTo(414, 250); ctx.stroke();
    const shown = Math.round(st.total * easeOut(clamp((goTimer - 20) / 50, 0, 1)));
    text('TOTAL', 70, 284, { size: 22, align: 'left', color: '#ffffff', sw: 4 });
    text(String(shown), 410, 286, { size: 32, align: 'right', color: '#ffd23f', sw: 6 });
    if (naming) {
      const p = 1 + Math.sin(titleT * 0.2) * 0.05;
      ctx.save(); ctx.translate(W / 2, 330); ctx.scale(p, p);
      text(st.global && !st.local ? '\u2605 GLOBAL TOP 10! \u2605' : st.global ? '\u2605 NEW HIGH SCORE \u2605' : '\u2605 NEW DEVICE HIGH SCORE \u2605', 0, 0, { size: 18, color: '#ffd23f', sw: 4 });
      ctx.restore();
    } else {
      // rank / submit status line
      if (sub.state === 'ok') {
        const pulse = 1 + Math.max(0, Math.sin(titleT * 0.12)) * 0.04;
        ctx.save(); ctx.translate(W / 2, 318); ctx.scale(pulse, pulse);
        gradText(`GLOBAL RANK #${sub.rank}`, 0, 0, 22, ['#fff3a0', '#ffb703'], 6);
        ctx.restore();
        text(`of ${sub.total} score${sub.total === 1 ? '' : 's'} \u00B7 today #${sub.rankToday}`, W / 2, 337, { size: 12, color: '#cfe9ff', sw: 3 });
      } else if (sub.msg) {
        text(sub.msg, W / 2, 326, { size: 13, color: sub.state === 'sending' ? '#cfe9ff' : '#ffb3a8', sw: 3 });
      } else {
        text('LEADERBOARD', W / 2, 326, { size: 16, color: '#ffd23f', sw: 4 });
      }
      drawBoard(76, 404, 348, 386, 17.5, (1 - k) * -30, true);
    }
    if (canRestart()) {
      ctx.globalAlpha = k * (0.55 + 0.45 * Math.sin(titleT * 0.12));
      text(isTouch ? 'TAP TO PLAY AGAIN' : 'PRESS ENTER OR TAP TO PLAY AGAIN', W / 2, 576, { size: 17, color: '#ffffff', sw: 4 });
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function render(alpha) {
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    const live = state === 'playing' || state === 'gameover';
    const cam = live ? lerp(prevCamY, camY, alpha) : camY;
    const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.save();
    ctx.translate(sx, sy);
    drawBackground(cam);
    drawPlatforms(cam);
    const hx = live || state === 'title' ? lerp(hero.px, hero.x, alpha) : hero.x;
    const hy = live ? lerp(hero.py, hero.y, alpha) : hero.y;
    drawParticles(cam);
    if (hy - cam < H + 60) drawHero(hx, hy - cam, hero);
    drawWalls(cam);
    drawSnow();
    if (live && scrolling) drawLava();
    ctx.restore();
    if (state !== 'title' && !(state === 'gameover' && !naming)) tabRects = [];
    if (state === 'title') drawTitle();
    else {
      drawHUD();
      drawPopups();
      if (state === 'paused') drawPause();
      if (state === 'gameover') drawGameOver();
    }
    if (state === 'title' && flash) drawPopups();
  }

  // ---------------------------------------------------------------- main loop (fixed 60 Hz physics)
  let acc = 0, last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 8) { step(); acc -= STEP; n++; }
    if (n >= 8) acc = 0;
    render(acc / STEP);
    requestAnimationFrame(frame);
  }

  // test / debug hook (read-only snapshot)
  window.__summit = {
    debug() {
      return { state, floor: highest, score: score(), comboActive: combo.active, comboFloors: combo.floors, comboJumps: combo.jumps,
        combosCount, bestCombo, comboScore, x: hero.x, y: hero.y, vx: hero.vx, vy: hero.vy, onGround: hero.onGround,
        level, scrolling, naming, canRestart: canRestart(), muted, comboList: comboList.slice(),
        board: { view: boardView, status: board.status, all: board.all && board.all.length, today: board.today && board.today.length },
        run: { state: run.state, hasToken: !!run.token }, submit: { ...sub } };
    },
  };

  resize();
  resetWorld();
  requestAnimationFrame(frame);
})();
