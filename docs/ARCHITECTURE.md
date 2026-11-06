# Architecture

Hostile is a voice, screen-sharing and text chat application for a small group (3–10 people). It is
deliberately one application with one community, not a platform.

This page describes the application as it stands: a client talking to a server over ordinary HTTP and
WebSocket, with PostgreSQL inside it (PGlite: Postgres compiled to WebAssembly, in a folder). [DESIGN.md](DESIGN.md) says how it will run from one person's PC,
what that changes, and what is not built yet.

## Shape of the system

```
  Desktop client (Electron)        Browser client
  ┌───────────────────────┐       ┌───────────────┐
  │ main process          │       │               │
  │  • window, CSP        │       │               │
  │  • OS-encrypted creds │       │               │
  │  • screen source pick │       │               │
  │  • global shortcuts   │       │               │
  │ ───────────────────── │       │               │
  │ renderer = same React app that the browser runs │
  └───────────┬───────────┘       └───────┬───────┘
              │  HTTPS + WSS (app data)   │
              ▼                           ▼
        ┌──────────────────────────────────────┐
        │ API: Express + Socket.IO (Node 24)    │
        │  • authentication, authorization      │
        │  • channels, messages, read state     │
        │  • asks to join, members, owner actions    │
        │  • mints LiveKit join tokens          │
        │  • verifies LiveKit webhooks          │
        └──────┬───────────────────────┬────────┘
               │ SQL                   │ server API + webhooks
               ▼                       ▼
        ┌──────────────┐        ┌──────────────────────┐
        │ PGlite       │        │ LiveKit (SFU)        │
        │ durable data │        │ audio, screen video  │◄──── WebRTC ────► clients
        └──────────────┘        └──────────────────────┘
```

Responsibilities are kept apart on purpose:

- **PGlite** stores everything durable: people, sessions, channels, messages, read
  state, except the bytes of files sent in chat, which are files on disk. Nothing ephemeral lives
  there.
- **The API** is the only thing that authorizes actions. Clients never talk to the database, and a
  client can never mint its own media token.
- **Socket.IO** distributes application events (new messages, edits, typing, presence, voice
  participation). It never carries audio or video.
- **LiveKit** transports media. Audio and screen video go client → SFU → client over WebRTC; they
  never pass through Express or Socket.IO.

## Packages

| Path              | What it is                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Contracts only: zod schemas, DTOs, Socket.IO event types, the desktop bridge interface, limits, brand. Imported as TypeScript source by every app. |
| `apps/server`     | API, realtime hub, media integration, Prisma schema and migrations, CLI tools.                                                                     |
| `apps/web`        | The React application. Runs in the browser and, unchanged, inside Electron.                                                                        |
| `apps/desktop`    | Electron main process, preload bridge, packaging configuration. Contains no product UI.                                                            |
| `scripts`         | Cross-platform Node scripts: doctor, setup, dev orchestration, tests, packaging.                                                                   |
| `e2e`             | Playwright suites that run against a real stack with real media.                                                                                   |

## Data model and ordering

`apps/server/prisma/schema.prisma` is the reference. Two design decisions matter more than the rest:

**Per-channel change counter.** Each channel row has `changeCounter`. Every message create, edit and
delete takes the next value _inside the same transaction_, while holding that row's lock. The
message stores `seq` (creation order) and `changeSeq` (latest change). Because the counter is taken
under a row lock, values are gap-free in commit order within a channel. That gives two exact
guarantees:

- history pages are stable (`WHERE channelId = ? AND seq < ? ORDER BY seq DESC`),
- a client that has seen every change up to `N` can ask for `changes?since=N` and receive precisely
  what it missed — which is how reconnects are reconciled. A recovered socket is never treated as
  proof that nothing was missed.

**Idempotent sends.** The client generates a `clientNonce` (UUID) per message. A unique constraint on
`(authorId, clientNonce)` means a retry — automatic or manual — can never create a second message.
The API returns the original message with `duplicate: true`.

Deletion policy: users are disabled, never deleted (their messages keep an author); channels are
archived, not dropped; messages are soft-deleted with their content erased, so other clients can
learn about the deletion during reconciliation.

## Attachments

Images and videos sent in chat are files in `UPLOADS_DIR`, with one `message_attachments` row each.
Profile images are kept in the database so that a copy of it covers them; a 200 MB video there would
bloat every copy and buffer in memory on its way in and out. Text and voice channels share this, as
they share the rest of chat.

Sending takes two steps. `POST /api/channels/:id/attachments` streams one file to a temp file, and
returns its id; `POST /api/channels/:id/messages` then names the ids, and its transaction claims
them. The claim is one `UPDATE` whose conditions say the row is this author's, in this channel and on
no message, and the send fails unless it took every row. An attachment can therefore reach only one
message however sends race, and a retry with the same `clientNonce` returns the original message
rather than finding its own attachments taken, because the message insert comes first and fails first.

- **What a file is** is decided from its bytes, never from the Content-Type or the name. The first
  4 KB settle the type before anything is written, so a wrong type costs no disk, and that type's size
  limit applies from then on. Images are then walked on disk a window at a time, for the same pixel and
  damage checks as profile images (`lib/image-sniff.ts`), and also for what they would cost every
  member's browser to draw: up to 128 MiB of pixels always passes, past that each byte of file pays for
  160 bytes of pixels, and one pass through an animation can be at most 4 gigapixels (`decodeRefusal`).
  Avatars and banners keep their own 4096 px limit and do not go through this. Videos only have their
  container's header read (`lib/video-sniff.ts`). Nothing is transcoded, and SVG and HTML can never pass.
- **Location data comes out** after that and before the rename (`lib/location-strip.ts`), by overwriting
  it at the same length, so no byte moves, no offset needs correcting, and a 200 MB video costs a few small
  reads and writes. Walkers plan a list of edits from reads alone, and the list is written at the end, so one
  walker serves a file on disk and the buffer of an avatar or a banner. Its limits, and what a file that
  will not parse does, are in that file. A forward links or copies a file that is already clean.
- **On disk** a file is named by its id and nothing else; a client's file name goes only into the
  database and a header. A temp file is the id plus `.part`, and the rename happens when it is whole.
  The row goes in first: a crash between the two leaves a row with no file, which is a 404 that the
  sweep clears, not a file that nothing knows about.
- **Serving** is public by unguessable id, like profile images, because an `<img>` or `<video>` cannot
  send a bearer token. `res.sendFile` handles Range, which video seeking needs. Every answer carries
  `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, since a file can be valid as
  two things at once.
- **Removal** is by deleting the message: its rows go in the same transaction and the files are unlinked
  after the commit. Uploads never put on a message are swept after 24 hours, and stray temp files at
  startup. The sweep deletes rows with one statement that says which it took, so a send racing it
  cannot lose a file it just claimed. Archiving a channel or removing a person deletes no message.
- **A slow upload** needs more than Node's `requestTimeout` of five minutes, and that setting covers
  the whole server. So it is off, and `http/request-deadline.ts` gives every request its own deadline
  of the same five minutes, whichever route it is for and including Socket.IO's. Only the upload route
  changes its own, after authentication and the CSRF check: two minutes without a byte ends it, and so
  do two hours in all. `headersTimeout` is untouched.
- **In the client** a message with files is a pending message like any other (`features/chat/store.ts`),
  with a `files` list of plain data beside its text. That list is saved across a reload, and the `File`
  objects and their previews sit in a map beside it, because they cannot be. Files upload one at a time
  over `XMLHttpRequest`, for the progress `fetch` cannot give, and the message goes out when the last has
  an id. Two messages upload at once and the rest wait in the order they were sent, marked as waiting,
  because over HTTP/1.1 a browser gives a site six connections for everything it does;
  a message keeps its place until its files are up, and a request, with its stall timer, only exists
  once it has one. A failed upload stops and waits for the member, unlike a text send, because repeating one costs
  minutes of transfer and a place in the hourly limit; once every file is up, the message retries like
  any other under its nonce. After a reload what never reached the server is gone, so the row fails with
  no Retry. What a message looks like is worked out before a byte arrives, from `attachment-rules.ts`:
  a video stands alone for the sake of its controls, images group in a grid, and each row's height is
  reserved with `aspect-ratio`. The server records a photo turned by its EXIF orientation at the size it
  is drawn, so that holds for those too. What it cannot know takes its real shape when it loads, and the
  list follows: a photo from before it did this, and a turned WebP in Safari, since WebKit obeys a WebP's
  orientation and Chromium does not.
- **A file that will not load** is not taken at the browser's word, because `<img>` and `<video>` say
  the same thing for a dropped connection as for a file that is gone (`media-recovery.ts`). A HEAD asks
  the server, past the cache: a 404 is final, anything else that is not a success keeps the file's box
  with a "try again" in it, and that comes back on a tap, when the network or the socket does, when the
  page is looked at again, or within 15 seconds. A video's `error.code` is read first: a decode failure
  needs no question, and a network error is never put down to the browser. Only "the server has it and
  this browser failed twice" says it cannot be played.
- **A `<video>` exists only near the screen**, within 800 px of the list's edge, or while it is playing.
  Its box is reserved either way. Each one is a player with a connection and a decoder behind it, which
  a detached element holds until garbage collection, so it gives them up as it goes. A pending row's
  preview does the same, and a tray holds ten at most.
- **Nothing dropped on the app is left to the browser** (`lib/drop-guard.ts`). The guard is installed
  once in `main.tsx`, not with the chat's drop zone, because a voice channel with its chat hidden has
  no chat mounted. A link let go into a text box still goes in as text.

## Replies and forwards

Both are ordinary messages with something extra on the row, and both go through the same counter,
nonce and rate limit as a send.

**A reply** names another message in `replyToId` (a self-relation, set to null if that row is ever
really deleted). The original has to be in the same channel, and a soft-deleted one counts: someone
who spent a minute writing an answer should not lose it because the message just went away. Its
`MessageDTO.replyTo` is a quote of the original (id, seq, its `changeSeq`, author, an excerpt cut on the
server at `LIMITS.replyExcerptMax`, how many files and of what kind, whether it is deleted), and never a
name, which clients take from the member list so that it stays current.

The server does not touch a reply when its original changes: a quote is read fresh with every page, and
an edit of one message must not take change numbers for every message quoting it. So clients keep what
they already hold up to date. Whatever way an edit or delete reaches a window, live or through
`changes?since`, `sync.ts` patches every quote of it in that window, wherever the original itself is,
and the quote's own `changeSeq` stops an older state undoing a newer one, because events can arrive out
of order. The store does the same for a reply being written and for pending rows.

**A jump** to a quote scrolls to the original if the window holds it. If not, it asks history for a page
before `seq + 30` and `applyJumpPage` replaces the window with it. That window has `hasNewer: true`, which
is what already stops a window marking anything read and keeps new messages out of it, and what shows
"Jump to present". The list holds still after landing even if it landed near the bottom of the page, or
the existing rule that reaching the bottom of such a window means catching up would bring the reader
straight back. Every load that replaces a window takes a number, and one that lands after a newer one
started is dropped. So is a jump's page once that jump is no longer wanted: another has taken over, or the
reader pressed "Newest messages", or left the channel, which is when a waiting jump is forgotten. An older
page has to land on the row it was asked for, or it would leave a hole.

**A forward** is a copy, and not a pointer, because the other way a deleted original would take its
copies with it, and an edit would change what someone else chose to pass on. `POST
/api/messages/:id/forward` makes a new message in the target channel, authored by the forwarder, with the
text as it stands, and five columns saying where it came from: the original's id (a self-relation, set to
null if that row goes), its author, its channel, that channel's name at that moment, and when it was
written. Only the first of those is a foreign key: the rest are a record of what was true then. A forward
of a forward keeps the first origin. It cannot be edited, by anyone, and whoever forwarded it or the owner
can delete it. Deleting one erases those columns along with its text. Unlike a send, it says nothing of having
read the target: the forwarder's mark moves up to it only if nothing from anyone else sits unseen below it.
Clients let go of the way back as soon as they hear the original was deleted, in whichever window holds a forward.

Its files are its own: new rows with new random ids, each a hard link to the original's file, so a 200 MB
video costs no disk and either message can delete its own name for the bytes without touching the other's
(`duplicateFiles` in `media/attachments.ts`). The links are made before the transaction, because a row
must never exist without its file, and removed again if it fails. A disk that cannot do hard links, or a
file that has run out of them (`EXDEV`, `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`, `EMLINK`), gets a real copy through a temp name, under the same disk reserve as an upload. A file
gone by then fails the forward with a 404. A process that dies between the links and the transaction leaves
files with no row, which cost nothing while the original lives and are not swept.

**On the client**, nothing here is per row. Up to 300 rows can be mounted, so a row carries no listener,
timer or store subscription for any of this. The list has one set of handlers for right-clicks, long
presses and swipes, and finds the row with `closest('[data-message-id]')`. The hover bar exists only on
the row that is hovered or has focus, placed there by a portal from one component, so the pointer crossing
the list redraws nothing but that. A swipe writes the row's `transform` directly, with the rules for what a
finger means in `swipe.ts`, apart from the page, and one icon serves the whole list. The right-click menu is
the existing popup system with one more kind, and what is being edited is a store value the list reads, so
starting an edit from that menu redraws only the rows concerned.

## Sessions and credentials

One session model, two deliveries:

- **Browser, and a guest in the app**: an opaque session token, delivered as a cookie that does not expire. Through the
  tunnel the page keeps that cookie itself, per host fingerprint, in `localStorage` (see "A person is their device" in
  [DESIGN.md](DESIGN.md)). State-changing requests must carry an
  `X-CSRF-Token` header whose value is an HMAC of the session id, and an `Origin` header the server
  recognizes. Cross-origin credentialed CORS is never enabled.
- **The host's own window**: the long-lived token stays in the Electron main process, encrypted with
  `safeStorage` (OS keychain / DPAPI). The renderer only ever holds a short-lived access token in
  memory and asks the main process for a new one. The renderer never sees the long-lived token.

Both are the same `sessions` row in the database, so revocation is uniform: removing a person or a guest leaving revokes
sessions, and the realtime hub disconnects their sockets (and sweeps every minute as a backstop). Tokens are not rotated
and do not expire, because nothing could replace a lost one.

`GET /api/auth/sessions` lists a member's own live sessions, and
`DELETE /api/auth/sessions/:id` ends one of the others. No screen uses them at present. It answers 404 for someone else's, the same
as for one that does not exist, and refuses the session making the request, because signing out here
has its own route that also clears the cookie. No token or hash of one is ever in the list. The
device's name is worked out in the browser from the stored user agent, so it is a best guess.

`GET /api/admin/channels/archived` lists archived channels for Settings, Channels, and
`POST /api/admin/channels/:id/restore` brings one back with its messages, at the end of the list,
and announces it with `channel:upserted` like any other change to a channel.

## Voice and screen sharing

- The client asks the API for a join token. The API checks the person and the channel, then mints a
  LiveKit token scoped to one room, with publish sources limited to microphone and screen share, and
  a short TTL. The LiveKit API secret exists only on the server.
- Participant identity is the user's opaque id. One identity per user means a second window replaces
  the first (LiveKit reports `DUPLICATE_IDENTITY`), which the client explains instead of leaving two
  ghosts behind.
- Who is in a voice channel comes from LiveKit (webhooks plus a periodic `listParticipants`
  reconciliation), never from client claims. Mute/deafen icons are self-reported over Socket.IO and
  are treated as presentation only. So is `watching`, the list of screen shares a member has on
  screen, which the same `voice:self-state` report carries; the API keeps only ids of people in the
  same room. LiveKit cannot supply it: it does not tell a publisher who has a track on screen.
- LiveKit 1.13 cannot revoke an already-issued token, and it re-issues tokens to connected
  participants every five minutes. Removing a participant therefore does not lock them out for good:
  the API re-checks authorization on every `participant_joined` webhook and on every reconciliation
  pass, and removes anyone who should not be there. The residual window is documented in
  [LIMITATIONS.md](LIMITATIONS.md).
- The call lives in a controller outside React (`apps/web/src/features/voice/controller.ts`), so
  browsing text channels, opening settings or re-rendering never disconnects it.
- Noise suppression on the way out has four settings: off, **standard** (built in: the capture's own
  `noiseSuppression` constraint, which the browser or the desktop app's Chromium carries out),
  **enhanced** (RNNoise) and **strong** (FastEnhancer Base, the default for a new profile). Both in-app
  suppressors are compiled to WebAssembly and run in an AudioWorklet as a LiveKit audio
  `TrackProcessor` (`apps/web/src/features/voice/suppressor.ts`). The graph is capture track →
  [80 Hz high-pass, FastEnhancer only] → worklet → `MediaStreamAudioDestinationNode`, and that
  destination's track is what LiveKit sends. It runs in an `AudioContext` the app creates at 48 kHz,
  because both models are trained for that rate and the context LiveKit provides follows the output
  device (44.1 kHz on many machines). With an in-app suppressor on, the built-in suppressor and
  the platform's voice isolation are turned off: two suppressors in series sound underwater. If a
  worklet or its WebAssembly cannot be loaded, or FastEnhancer keeps falling behind real time, the
  session falls back to standard for that mode only and keeps the stored choice. A mode the person
  chose says so once in a toast; strong as an unchosen default changes without one, and says why in
  Settings → Voice and in Diagnostics. The preference records whether the mode was chosen
  (`noiseModeChosen` in `apps/web/src/features/voice/audio-processing.ts`), so the default is worked
  out again on each start and a saved mode, older ones included, is kept. Where the browser has no
  WebAssembly or no AudioWorklet, the default is standard and nothing is tried. See
  [LIMITATIONS.md](LIMITATIONS.md) for what each is and is not good at.
- Call sounds (join, leave, mute, unmute, deafen, undeafen, screen share started or stopped, someone
  joined a stream you are in) are recordings bundled with the client
  (`apps/web/src/features/voice/sounds/`), played through Web Audio by
  `apps/web/src/features/voice/sounds.ts` on the listener's machine only; nothing about them crosses
  the network. The controller
  derives them from LiveKit room events, except "joined a stream", which comes from the `watching`
  lists in the API's voice snapshot (`apps/web/src/features/voice/cue-rules.ts`). LiveKit unwinds and
  replays every participant around a full reconnect, so the cues follow sets the controller re-takes
  from the room whenever it settles, not the raw events.
- Stream ducking lowers screen-share audio while someone else talks. It is decided by each client from
  what that client receives (`apps/web/src/features/voice/ducking.ts`): a level meter on every remote
  microphone, with LiveKit's slower active-speaker list as the fallback. The client's own microphone
  is never measured, so your own voice cannot lower what you hear, and nothing crosses the network. It
  only runs while it is switched on and a stream with audio is in the call.

## Third-party code and licences

[ASSETS.md](ASSETS.md) audits everything that ships, with each licence. Dependencies are ordinary npm
packages under permissive licences, and their own notices travel with them in `node_modules`. One of them ships compiled code from other projects inside a single file, so
its provenance is recorded here rather than left to be discovered in a minified bundle:

| Component                          | Version  | Licence      | Where it runs                                       |
| ---------------------------------- | -------- | ------------ | --------------------------------------------------- |
| `@sapphi-red/web-noise-suppressor` | 0.4.0    | MIT          | the RNNoise worklet wrapper and loader              |
| RNNoise (Xiph.Org / Mozilla)       | —        | BSD-3-Clause | the enhanced suppression, as WebAssembly            |
| `@shiguredo/rnnoise-wasm`          | 2022.2.0 | Apache-2.0   | the Emscripten build of RNNoise inside that worklet |
| `fastenhancer-web`                 | 0.1.1    | MIT          | the strong suppression: C engine, worklet, weights  |
| FastEnhancer (Sunghwan Ahn et al.) | —        | MIT          | the model and its 48 kHz weights inside that build  |

`fastenhancer-web` credits `kdrkdrkdr/fastenhancer.c.wasm` as its reference implementation; that
repository declares no licence. The package's own engine is published under MIT.

Call sounds are from Zulip's notification sounds by Stefan Mertens and "Interface Sounds" by Kenney,
both CC0, listed file by file in `apps/web/src/features/voice/sounds/LICENSE.txt`. Display-name fonts are the `@fontsource` packages of
Unbounded, Playfair Display, Pacifico, Caveat, Press Start 2P, JetBrains Mono, Comfortaa and Russo One,
all under the SIL Open Font License, which each package carries. `motion` (MIT) drives the interface's
spring animations. Animated effects were written for this project in plain CSS after studying
uiverse.io, magicui.design and reactbits.dev; no code was copied from them.

The `.wasm` files, the worklet modules and FastEnhancer's weights (shipped as JavaScript modules) are
bundled by Vite and served from the application's own
origin. Nothing is fetched from a CDN or any other third party at runtime, here or anywhere else in
the client: that is a hard rule, because a network that blocks other hosts cannot be relied on to reach
anything except their own server.

## Client/desktop boundary

The React app talks to a single `Platform` interface (`apps/web/src/platform`). The web
implementation uses cookies and same-origin requests; the desktop implementation calls the preload
bridge. The bridge's exact shape is declared once in `packages/shared/src/desktop-bridge.ts` and is
narrow by design: the owner's session, capture-source listing, media permission status,
shortcuts, power events and `openExternal`. There is no generic filesystem, shell or network
primitive, and every call is validated in the main process, including the sender's origin.

Two kinds of shortcut sit either side of this boundary. The ones that work while the window has focus
are entirely in the React app (`features/shortcuts`), on web and desktop alike, and are stored with the
person's other voice preferences. Global ones go through the bridge and exist only on desktop.

## What is deliberately not here

No public communities, no bots, no direct messages, no mobile client, no recording, no link
previews, no file types beyond images and videos, no automatic updates, no role hierarchy beyond
owner/member. See
[LIMITATIONS.md](LIMITATIONS.md) for the full list.
