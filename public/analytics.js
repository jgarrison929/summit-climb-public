// First-party, privacy-friendly analytics client. No cookies, no third parties, no PII.
// - visitor id: random, stored in localStorage ('an_vid'); session id: random, per tab (sessionStorage).
// - open the game once with ?internal=1 to tag this browser as internal (?internal=0 clears it).
// - automated browsers: send header `X-Internal-Traffic: 1` or include `internal-playtest` in the UA.
(function () {
  'use strict';
  function rid() {
    var a = new Uint8Array(12);
    try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 12; i++) a[i] = Math.floor(Math.random() * 256); }
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function store(kind, key, make) {
    try {
      var s = window[kind], v = s.getItem(key);
      if (!v || !/^[A-Za-z0-9_-]{8,40}$/.test(v)) { v = make(); s.setItem(key, v); }
      return v;
    } catch (e) { return make(); }
  }
  var internal = false;
  try {
    var q = new URLSearchParams(location.search).get('internal');
    if (q === '1') localStorage.setItem('an_internal', '1');
    else if (q === '0') localStorage.removeItem('an_internal');
    internal = localStorage.getItem('an_internal') === '1';
  } catch (e) { /* ignore */ }
  var vid = store('localStorage', 'an_vid', rid);
  var sid = store('sessionStorage', 'an_sid', rid);
  var touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  var mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
    (touch && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var current = null; // { start, mode }

  function send(t, extra) {
    try {
      var body = { t: t, v: vid, s: sid, mob: !!mobile, touch: !!touch };
      if (internal) body.i = true;
      for (var k in extra) if (extra[k] !== undefined && extra[k] !== null) body[k] = extra[k];
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }).then(function (r) { return r.text(); }).catch(function () {});
    } catch (e) { /* analytics must never break the game */ }
  }
  var api = {
    track: send,
    gameStart: function (extra) { current = { start: Date.now() }; send('game_start', extra || {}); },
    gameEnd: function (extra) {
      if (!current) return; // only once per started game
      var e = extra || {}; if (typeof e.dur !== 'number') e.dur = Date.now() - current.start; current = null;
      send('game_end', e);
    },
  };
  window.analytics = api;
  send('visit', {});
})();
