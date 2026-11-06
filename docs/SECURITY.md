# Security and trust model

## What this is not

**Hostile is not end-to-end encrypted.** Transport is encrypted (WebRTC's DTLS for the tunnel, DTLS-SRTP
for media), but the host's PC sees everything:

- message text is stored in plain text in the database, a folder on the host's disk,
- audio and screen video are decrypted by the media server, which is what lets it route streams,
- whoever controls the server can read messages and could join or record media.

That is a deliberate trade for a small group of friends: the person hosting can read everything, the
same trust a server owner always has. Do not describe this to your friends as "encrypted so nobody can
read it" — describe it as "one of us hosts it, so only we can read it".

## Who gets in

- There is no login, no password and no invite. Someone holding the room code asks to join, and only the owner's
  session can answer. The ask routes take only what the gateway vouches for with its token for this run, so a local
  program without it is refused. A nickname is only ever rendered as text, also in the native notification. A picture
  gets the checks and limit of a profile upload and is held in memory until the host says yes. See "A person is their
  device" in `docs/DESIGN.md`.
- The owner's secret lives in `host/secrets.json` (owner-only file), held by the main process. It reaches the room server
  by message and is exchanged on loopback for the owner's session. The route refuses anything through the gateway and
  the tunnel refuses its path, comparison is in constant time, and it never reaches a renderer, a log or a command line.
- `HOSTILE_ENV=production` refuses to start outside the host app, and `JOIN_AUTO_ADMIT` and `OWNER_SECRET` are refused in
  production. Refresh tries are rate limited per address.
- Tokens and room codes are never logged (`apps/server/src/lib/logger.ts` redacts them,
  request logging never includes bodies or query strings, and a join ticket in a path is cut from it).

## Sessions

- A session is an opaque token that does not expire and is not rotated, because nothing could replace it: losing it
  loses the person. So an answer lost on its way costs one retry, and there is no reuse detection to trip.
- A guest's session is a cookie the page keeps in `localStorage`, in a tab and in the app alike, and script in that page
  can read it. See "A person is their device" in [DESIGN.md](DESIGN.md). Unsafe requests additionally require an
  `X-CSRF-Token` header (HMAC of the session id) and a recognized `Origin`. Credentialed cross-origin CORS is never enabled.
- The owner's session stays in the Electron main process, encrypted with the OS keychain (`safeStorage`); the owner's
  window holds only a short-lived access token in memory.
- Revocation is immediate for HTTP and for sockets: removing a person or a guest leaving revokes the session rows, and
  the realtime hub disconnects the affected sockets and re-checks every minute.

## Media authorization

- Join tokens are minted by the API only, after checking the person and the channel. They are scoped
  to a single room, limited to microphone and screen-share sources, have data publishing disabled and
  a short TTL. The LiveKit API secret never leaves the server (`pnpm check:bundle-secrets` verifies
  that build outputs contain no secrets). The hosted room's server bundle, `apps/desktop/dist/host`, may name the
  server's variables, as any server does. Real values and key blocks are still looked for in it.
- Who is in a room comes from LiveKit, not from client claims.
- **Residual access after removing a person**: LiveKit 1.13 has no token revocation and re-issues
  tokens to connected participants roughly every five minutes with at least ten minutes of validity.
  Removing a participant does not invalidate the token they already hold. The API therefore re-checks
  authorization on every `participant_joined` webhook and on every reconciliation pass (every 15
  seconds by default) and removes anyone who should not be there. A determined, already-authenticated
  attacker could re-join for up to one reconciliation pass at a time, about 15 seconds, until their token expires. Rotating
  `LIVEKIT_API_SECRET` and restarting LiveKit invalidates all outstanding tokens immediately if you
  need certainty.

## Content-Security-Policy and WebAssembly

The web client's policy is built in `apps/server/src/http/app.ts` (`webCsp`) and the desktop
renderer's in `apps/desktop/src/csp.ts`. Both now carry **`'wasm-unsafe-eval'`** in `script-src`.

That token permits one thing: compiling and instantiating WebAssembly. It does **not** permit
`eval()` or `new Function()` — that is `'unsafe-eval'`, which is deliberately still absent from every
policy here, and the desktop smoke test asserts both facts against the running renderer (WebAssembly
compiles, `eval` throws `EvalError`). The token is needed because both in-app noise suppressors,
RNNoise and FastEnhancer (the default), are compiled to WebAssembly and instantiated inside an
AudioWorklet; without it the browser refuses to compile the module, the suppressor cannot start, and
the app falls back to standard, the built-in suppressor.

Nothing else was loosened. The worklet module and the `.wasm` are part of the built client and are
served from the app's own origin, so `script-src 'self'` (the worklet module), `connect-src 'self'`
(the binary) and `worker-src 'self' blob:` were already sufficient for everything but the compile
step. No third-party origin is involved at runtime, here or anywhere else in the client.

## Desktop hardening

Context isolation on, sandbox on, Node integration off, `webSecurity` untouched, a restrictive
Content-Security-Policy derived from the room's own address, navigation and window-opening
blocked except for the app's own origin, external links handed to the OS browser only after
validation, permission requests limited to `media`, `speaker-selection`,
`clipboard-sanitized-write` and `fullscreen` (granted only to the app's own main frame, with video
capture refused inside a media request), and every IPC call validated including its sender. A
compromised renderer could therefore write to the clipboard and take the window full-screen, but
not read the clipboard or reach the camera. Electron fuses disable `RunAsNode`, `NODE_OPTIONS` and
inspector arguments, require loading from the asar archive, and verify that archive against the
hash embedded in the bundle.

## Reporting and hygiene

- Secrets live in `.env` (git-ignored). `.env.example` contains placeholders only.
- `HOSTILE_ENV=production` refuses to start outside the host app, and with development placeholders or a short secret.
- Remote link previews and arbitrary HTML rendering are intentionally absent: message text is rendered
  as React elements, never as HTML, and only `http(s)` links are clickable.
- The uploads are a member's own avatar and profile background, and images and videos sent in chat.
  In both, the type comes from the file's own bytes (PNG, JPEG, GIF or WebP, and for chat MP4, MOV or
  WebM; never SVG), size and pixel limits bound what other members' browsers decode, and uploads are
  rate limited per member. Profile files
  are stored in the database and served as sandboxed images at `/api/media/<id>`. Files sent in chat are
  on disk, kept as sent apart from location data. Neither URL needs a session, because an image tag cannot send a token: the
  random id is the capability, so anyone given a link can see that one file.
- Location data comes out of every upload before anyone can fetch it, chat files, avatars and banners
  alike (`lib/location-strip.ts`): EXIF GPS, XMP and IPTC places in images, and `©xyz`, `loci` and
  location keys in MP4 and MOV. It is overwritten in place at the same length, so no pixel or frame is
  touched, and a forward gets a file that is already clean. This parses the uploader's bytes, so every
  length is checked and every walk is bounded, and the log holds only a code, never a value. It does not
  reach files uploaded before it existed, WebM, a location track inside a video's media data (GoPro's
  GPMF, a dashcam's), maker notes, or a place written in a caption, and a file that does not parse as
  expected is stored as it came, with a warning in the log.

If you find a problem, the fastest fix on your own host is usually: Remove the affected people, then make a new code
(Settings, Hosting, Make a new code).

## Hosting from the app

`HOSTILE_ENV=production` runs only under `loadConfig(env, { hosting: true })`, an argument that only the app's server entry
passes. No environment variable reaches it. A server on its own has no code and so no lock, so it refuses to start, and
the project has no deployment files to lose by that. Development and test servers refuse anything but loopback. The
hosting rules are strict about everything else, and rate limits stay on.

Nothing but LiveKit's one UDP media port listens off loopback, and no mDNS responder runs, which the first-run spec checks with `lsof` across the
whole process tree. The gateway refuses to start unless its options say `roomTrustProxy: 'loopback'`: without it every
guest would share one address, and one guest's tries would use up the limits of all. Other programs on the PC are on
loopback as well, so the room server believes a stated address only with the token this run gave the gateway, by message
and never in the environment or on a command line. Without it a caller counts as the PC itself, one address with one budget.
Rate limits are proven per guest through the real host, and a spec shows a local program naming a new address for each try
still gets 429 once its one budget of refresh tries is spent. The bridge window cannot open a microphone: see [DESKTOP.md](DESKTOP.md). The policies of the owner's
window name 127.0.0.1 and the host's own ports, and only while hosting. Secrets are in owner-only files, and in no log or
command line.

A code and one click are all that stand between the internet and the room, and the code is the host's to replace: Settings, Hosting,
Make a new code. Anyone with the old one can then reach nothing.

## Guests through the tunnel

A guest's session cookie and room code live in `localStorage`, readable by script in the page, and one code serves the
whole room. See "A person is their device" and "The tunnel" in [DESIGN.md](DESIGN.md) for what that gives up and what the gateway enforces.
