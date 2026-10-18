# Summit Climb

A browser vertical-climbing game with a global leaderboard that is built to resist cheating. Run, build
momentum, bounce off the walls and chain multi-floor combo jumps to stay ahead of the rising lava.

**Play it live:** https://summit-climb-production.up.railway.app

<p>
  <img src="docs/screenshots/title.png" alt="Summit Climb title screen with the leaderboard" width="320">
  <img src="docs/screenshots/combo.png" alt="Summit Climb gameplay: a combo popup, the lava pace meter and the combo meter" width="320">
</p>

## Security design

The game runs entirely in the browser, so the server can never prove that a run really happened. The
leaderboard is designed around that fact: every score has to pass a chain of server-side checks, the
server stores as little about players as possible, and the remaining limits are documented below.

### Signed, single-use run tokens

- When a run starts, the game calls `POST /api/run` and gets a token `v1.<payload>.<HMAC-SHA256>`. The
  payload holds the issue time and a random 128-bit nonce. The signature uses `RUN_SECRET` and is checked
  with a constant-time comparison.
- A score must carry a valid token. Tampering with the payload (for example, back-dating the issue time)
  breaks the signature.
- Each nonce can be stored only once (a `UNIQUE` column), so a token can't be reused. A token that is
  rejected because of a bad name is not used up, so the player can pick another name.
- Tokens expire after 12 hours.

### Server-side score validation (`lib/leaderboard.js`)

The server checks that the submitted numbers are something the game's physics can actually produce:

- **Time.** The claimed play time can't exceed the token's age (+5 s / 2 % slack). Play time is capped at 6 h.
- **Climb rate.** The fastest possible climb is a full-speed jump of 5 floors every ~49 ticks, about
  6.1 floors/s. The server allows `floor ≤ 7.5 × seconds + 2`.
- **Score arithmetic.** The server recomputes the score from the floor and the list of combos and requires
  an exact match: `score = 25 × floor + Σ 10 × f × ⌊√f⌋` over each combo of `f` floors.
- **Combo plausibility.** Each combo is between 6 floors (two 3-floor jumps) and `floor`. `maxCombo` must
  equal the largest combo. The combo total can't exceed `floor + 10 × combos` (after a fall of at most
  about one screen, you can re-climb at most ~8 floors) or the climb-rate limit. There can be at most one
  combo per 0.9 s of play.
- **Caps.** Floor ≤ 50,000. At most 2,000 combos. Request bodies ≤ 16 KB. Fields must be integers.
- **Names.** 1–12 characters after trimming and upper-casing, using `A–Z 0–9 space _ - . ! ?` only, with
  at least one letter or digit. A basic profanity filter checks a de-leeted, letters-only form of the name.
- Rejections return only a generic error code (`implausible`, `invalid_token`, ...). The exact reason goes
  to the server log, so the API doesn't coach cheaters.

### Salted IP hashes and privacy

- The client IP comes from `X-Real-IP` set by the hosting proxy (falling back to the first
  `X-Forwarded-For` hop, then the socket address). It is used in memory for rate limiting and is stored
  only as a salted HMAC hash (`ip_hash`), never in plain text. The hash is never returned by the API.
- Analytics are first-party and anonymous: no cookies, no third parties, no IPs stored, and a random
  visitor id that the browser creates.

### Rate limits and request hygiene

- Per IP, per 10 minutes: 120 run tokens, 10 score submissions and 30 admin requests. Analytics events are
  limited to 120 per visitor and 600 per IP per 10 minutes, and the stats endpoints to 60 per IP. All
  limits are kept in memory and answered with `429` and `Retry-After`.
- Requests that send a cross-site `Origin` header are refused (`403`).
- The admin and stats tokens are compared in constant time, must be at least 24 characters, and when a
  token is not set its endpoints answer `404`, as if they did not exist.
- Static files are served only from `public/` (path traversal is blocked), with `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: no-referrer`.

### Parameterized SQL

Every query uses `pg` placeholders (`$1, $2, ...`). No user input is ever concatenated into SQL. Names are
also restricted to a small character set before they reach the database.

### Honest limits of the anti-cheat

These checks make cheating slow and bounded, but they can't prevent it:

- A determined cheater can read `game.js`, request a real token, wait the right amount of time and submit
  a made-up run that stays within every limit. A score that is physically possible but never played can't
  be told apart from a real one.
- The in-memory rate limits reset when the server restarts and are per instance. Someone with many IP
  addresses gets more attempts.
- The profanity filter is a short list and won't catch everything.

Because of this, the leaderboard has a moderation endpoint (`DELETE /api/admin/scores/:id`) for removing
bad entries.

## How to play

Climb as high as you can before the lava catches you.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Run left / right | ← → or A / D | ◀ ▶ buttons |
| Jump (hold to keep jumping) | Space, ↑ or W | JUMP button |
| Pause / resume | P or Esc | II button / tap |
| Mute | M | ♫ button |
| Start / restart | Enter (or tap) | Tap |

- **Momentum.** You speed up as you run, and **faster running means a much higher jump**. At full speed
  you can clear about 5 floors in one jump.
- **Walls.** Hitting a side wall bounces you back at the same speed. Zig-zagging between the walls is how
  you get huge jumps.
- **Floors and camps.** Every floor is numbered. Every 25th floor is a wide **camp ledge** with a pennant
  flag. Platforms get narrower and further apart as you climb.
- **Zones.** The scenery changes every 75 floors: Foothills, Canyon, Quarry, Blossom, Glacier, Foundry,
  Aurora, Sunspire, Stratos.
- **The lava.** The screen starts scrolling when you reach floor 10 or after 12 seconds, whichever comes
  first. The **lava meter** at the top left fills up, and every 40 seconds the lava speeds up to the next
  pace (up to pace 7) with a **LAVA RISING** ribbon. Once you climb above 40 % of the screen height, the
  camera eases up after you. If you fall off the bottom, the run is over.
- **Combos.** Each jump of **3 or more floors** starts or extends a combo and refills the combo timer bar
  (2.5 seconds). A smaller jump or an empty timer ends the combo. A combo counts once it has at least two
  of these jumps. The praise word depends on the combo's size: Step up!, Climbing!, Sure-footed!,
  Ridge runner!, Sky high!, Peak form!, Cloudbreaker!, Thin air!, Stratosphere!, Summit legend!
- **Score** = `25 × highest floor` + a combo bonus of `10 × f × ⌊√f⌋` for each combo of `f` floors. The
  multiplier `⌊√f⌋` grows with the square root of the combo, so a 9-floor combo is worth ×3 and a 25-floor
  combo is worth ×5.
- **Leaderboards.** The title and game-over screens show a board with three tabs: **ALL-TIME** and
  **TODAY** (global, top 10) and **THIS DEVICE** (your local top 5 in `localStorage`). Switch with ← / →
  or by clicking or tapping a tab. If your score makes the global top 10 (all-time or today) or your device
  top 5, you enter a name (the last one is remembered) and the score is submitted. The game-over screen
  then shows your global rank. When you're offline or the leaderboard is down, the game still works and
  scores are kept on the device.

## Server and API

`server.js` serves `./public` (content types, ETag/304, gzip, `no-cache` HTML) plus these endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /health` (also `/healthz`) | Always `200 {"status":"ok","uptime":<seconds since the process started>,"leaderboard":"ok" \| "unavailable" \| "disabled"}`, including when the database is down. |
| `POST /api/run` | Starts a run and returns `{"token","issuedAt","leaderboard":bool}`. The game calls this when a run starts. |
| `POST /api/scores` | Body: `{"token","name","score","floor","maxCombo","durationMs","combos":[floors of each combo]}`. Returns `201 {"ok":true,"id","name","score","rank","rankToday","total"}`. Errors: `400 {"error": "invalid_token" \| "implausible" \| "token_expired" \| "name_required" \| "name_too_long" \| "name_charset" \| "name_not_allowed" \| ...}`, `403 forbidden` (cross-site), `409 token_used`, `413 body_too_large`, `429 rate_limited` (with `Retry-After`) or `503 leaderboard_unavailable`. |
| `GET /api/scores?limit=10&period=all\|today` | Top scores: `{"period","limit","scores":[{"id","name","score","floor","createdAt"}]}`. `limit` is 1–50 (default 10). `today` means the last 24 hours. Cached for 10 s (`Cache-Control: public, max-age=10`). |
| `POST /api/events` | Anonymous gameplay event from the game's analytics client. Body: `{"t":"visit"\|"game_start"\|"game_end","v":<visitor id>,"s":<session id>, ...}` with optional `mob`, `touch`, `score`, `floor` and `dur`. Unknown fields are rejected. Returns `204`, or `400`, `403`, `413`, `429` or `503`. |
| `GET /api/stats?days=7&include_internal=0` | Aggregate analytics (visitors, sessions, games started and finished, median session length, mobile share, returning visitors, per-day counts). Requires `Authorization: Bearer $STATS_TOKEN` and answers `404` when `STATS_TOKEN` is not set. `days` is 1–365. |
| `POST /api/stats/internal` | Body: `{"visitor":"<id>","internal":true\|false}`. Re-tags one visitor id's events as internal traffic (for example, your own test devices), so they are left out of the stats. Same `STATS_TOKEN` auth and `404` behavior as `/api/stats`. |
| `DELETE /api/admin/scores/:id` | Moderation. Requires `Authorization: Bearer $ADMIN_TOKEN` and only exists when `ADMIN_TOKEN` is set. |

Data model:

- `scores`: `id, name, score, floor, max_combo, combo_count, duration_ms, created_at, ip_hash, nonce (unique)`.
- `analytics_events`: `id, ts, type, visitor, session, internal, mobile, touch, mode, score, floor, winner, duration_ms`.

Both tables are created on startup if they are missing.

## Tech stack

- **Client:** vanilla JavaScript and an HTML5 canvas, no framework or build step. Fixed 60 Hz physics with
  interpolated rendering, procedural art, and sound synthesized with the Web Audio API. There are no image,
  sound or font files: the game uses system fonts.
- **Server:** Node.js (20+) using the built-in `http` module.
- **Data:** PostgreSQL through `pg`, the only runtime dependency. The database is optional for local play.
- **Tests:** `node:test`, covering the scoring and anti-cheat rules, the HTTP API and analytics.
- **Hosting:** Railway (`railway.json` sets the health check and restart policy).

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start            # http://localhost:3000 (without DATABASE_URL the game works and the global board shows "unavailable")
PORT=8080 npm start  # custom port

# with a local Postgres (the tables are created on startup)
DATABASE_URL=postgres://user:pass@localhost:5432/summitclimb RUN_SECRET=$(openssl rand -hex 32) npm start
```

See `.env.example` for every setting.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | Port to listen on (default 3000). |
| `DATABASE_URL` | for the leaderboard | Postgres connection string. Unset means the leaderboard and analytics storage are disabled. |
| `RUN_SECRET` | in production | HMAC key (at least 16 chars) used to sign run tokens and salt IP hashes. Without it a random per-process key is used, so tokens stop working after a restart. |
| `ADMIN_TOKEN` | no | Enables the moderation endpoint (at least 24 chars). |
| `STATS_TOKEN` | no | Enables `/api/stats` and `/api/stats/internal` (at least 24 chars). |
| `DATABASE_SSL` | no | `disable`, `require` or `no-verify`. |

### Tests

```bash
npm test                                                  # rule unit tests + API tests that don't need a database
TEST_DATABASE_URL=postgres://...throwaway-db... npm test  # adds the database suites (they TRUNCATE the tables)
```

## Project layout

```
public/index.html    page shell, touch controls, name-entry form
public/style.css     layout, responsive scaling, touch buttons
public/game.js       the whole game: physics (fixed 60 Hz), rendering, audio synth, UI, leaderboard client
public/analytics.js  first-party anonymous analytics client
server.js            static file server, /health, leaderboard API
lib/leaderboard.js   run tokens, score and name validation, IP hashing, rate limiter (pure, unit-tested)
lib/db.js            Postgres pool, schema bootstrap, queries (degrades gracefully when the DB is down)
lib/analytics.js     /api/events and /api/stats
test/                node:test suites (npm test)
docs/screenshots/    README images
railway.json         deploy settings (health check, restart policy)
```

## How it was built

I built Summit Climb by directing AI agents (Grok Bots), not by writing the code by hand. I set the goals,
wrote the specs, reviewed the builds and playtests, and decided what shipped. The agents wrote the code,
tests and docs.

## License

MIT. See [LICENSE](LICENSE).
