# Design: the same app with no server in the middle

Hostile is a free Discord-style app with no rented server. One person hosts from their own PC in an
Electron app, the app gives a code, and friends paste it into the app or a browser tab and connect. It
is built on TypeScript, React, Vite, SCSS modules, zustand, Express, Prisma, Socket.IO, LiveKit and
Electron.

## Where this stands

The tunnel, the rendezvous, the embedded database (PGlite) and the Electron host are built and tested on one Mac. An
Apple Silicon Mac package is built and was run for real on that Mac (docs/DESKTOP.md). It is not signed by a developer
or notarized, so macOS asks the person to allow it once. Windows and Linux packages have not been built.

The word "unproven" below means no test has shown it works. Everything marked proven was proven on one Mac,
with both ends on the same machine: real home routers, carrier NAT and separate networks are still untested.

| Part                                         | State                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| The app: chat, voice, screen share, admin    | Built. Needs no database server                                |
| Tunnel over data channels, and its bridge    | Built. `e2e/tunnel-*.spec.ts` prove it on one machine          |
| LiveKit signalling through the tunnel        | Built. A call and a screen share pass on one machine           |
| Service Worker for files, with video seeking | Built. Chromium and Playwright's WebKit pass. Firefox unproven |
| Finding the host with a code                 | Built. One smoke test on public relays, both ends on one Mac   |
| Connection failure screen and relay field    | Built. A `turn:` relay in that field has never been run        |
| Embedded database                            | Built. Integration and browser suites run on it. See below     |
| Host mode in Electron                        | Built. `e2e-desktop/host-*.spec.ts` unpackaged, `e2e-packaged` |
| Bundled LiveKit                              | In the Mac package, arm64, started from inside it              |
| Page for guests in a browser tab             | Guest build exists, the tunnel specs use it. No site is set up |

## The shape

Everyone connects to the host and nobody connects to each other (a star). A new guest adds one
connection, to the host, and guests never need to reach or know each other's addresses.

```text
 guest app ───┐
              │   WebRTC (encrypted, direct)   ┌──────────── host PC ───────────┐
 guest tab ───┼───────────────────────────────▶│ room server + database + files │
              │                                │ media server (forwards streams)│
 guest app ───┘                                └────────────────────────────────┘
```

WebRTC (the browser's built-in system for direct encrypted connections) is the only transport, because
it is the only one that lets a page on HTTPS reach a home PC without a trusted certificate. A secure page
may not open a plain WebSocket to a home IP, and a home PC cannot easily get a certificate that browsers
accept.

A browser tab is a guest only. It cannot listen for connections or run a media server, and it stops when
closed or put to sleep. The Electron app does both: it opens on a choice, and comes back to the same room next time.

Three things come with this design. Every guest learns the host's home IP address, so it suits friends
rather than strangers. The host's PC can read everything, which is the same trust a server owner has
today. And the host's upload speed decides what a room can carry, more than the PC does: a media server
forwards streams without converting them, using little CPU, but sends a copy of every stream to every
guest.

## A person is their device

There is no login, no username, no password and no invite. A person is a nickname, an avatar and a background on one
device, and everything underneath uses ids, so two people may share a name.

**The first run.** The host chooses a nickname and optional pictures and gets the code. Hosting again goes straight
back to being the owner. The owner's identity comes from a high-entropy secret kept beside the others in
`host/secrets.json`. The main process holds it, sends it to the room server by message, and exchanges it on loopback
for the owner's session. It never reaches a renderer, a log or a command line, a request through the gateway can never
use it, and comparison is in constant time. An ordinary server has no code and so no lock, so `HOSTILE_ENV=production`
refuses to start unless it is the host app's own server. The project has no deployment files, so nothing is lost.

**Asking.** Someone with the code fills in one card and clicks Ask to join. The host sees the nickname and picture on a
small card that takes no focus, and in the Waiting list under Hosting, and clicks Let in or Turn away. With the
window closed, a native notification says who is asking. The code and that one click are what let someone in. The
ask routes take only what the gateway vouches for, using its token for this run, so a program on the PC talking to
the loopback port is refused.

**Until the click.** A guest with the code reaches `/api/health`, `/api/public-config`, `/api/join` and the capability
URLs of files and pictures. They get no socket, no LiveKit token, no member list, no messages and no channels. What
they send is hostile until the host says yes: the nickname is only ever rendered as text, and the picture goes
through the same checks and limit as a profile upload and is held in memory only. Nothing reaches the disk or the
database before Let in, and a banner stays on the guest's side until then. At most 20 people wait at once, one per
connection. A request ends when they cancel, after 90 seconds without looking, or after 30 minutes. Restarting the host
loses requests, and guests ask again by themselves.

**Waiting.** The gateway's rule for guests without a session is unchanged: three minutes each, with the longest
waiting making room. A person waiting for the host loses that seat and takes a new one by themselves, without leaving
the screen, because the request lives on the host and not on the connection. A dropped connection works the same way.

**Coming back.** The same device comes straight in with no asking, after a reload, a restart of their app or of the
host, and after a new code once they paste it. Sessions do not expire, and nothing rotates: the same token works until
it is revoked, so an answer lost on its way costs one retry. A new device or cleared browser data makes a new person,
who asks again. Old messages keep the old nickname and picture. There is no recovery, linking or export.

**Remove.** Removing someone ends their sessions, socket, call and LiveKit participation at once, and their messages
stay. With the code they can only ask again, as someone new.

**The session cookie is not HttpOnly for a guest.** A browser keeps cookies per website, and the room is not
the website the guest's page came from, so the page keeps the session cookie itself, in `localStorage`, and
hands it to the tunnel. This holds for a guest in the app as well as in a tab. The server still sets `HttpOnly`, but
nothing here can honour it: any script running in the guest's page can read the cookie, so a cross-site scripting bug
or a tampered guest site could steal a session, which with an `HttpOnly` cookie it could only ride. The CSRF token
stays in memory only. This is the price of a tab reaching a host with no certificate. It is kept per host fingerprint,
so a new code keeps the person, because the host's key belongs to the host and not to the code.

**One code for the whole room.** That has consequences a host should know:

- Anyone with the code can also stand up a fake host on it, and it gets nothing from a guest, on a first visit or any
  other. The code names the host's signing key (see "Finding the host"), so a guest believes only a host that signs with
  it: a fake host with the code but another key never receives a guest's connection details, and the guest never tries
  to reach the fake's addresses. Behind that, a browser remembers the certificate fingerprint of the first host it reached
  and tells no other host anything, and when the real host is away the guest waits for it. The host keeps both keys from
  one start to the next. A guest who hits a real change of host's certificate, such as one past its year, is told so and
  pastes the code again, which asks as a new person. Their old identity stays on the device if that host returns. A host
  on a new PC has a new signing key, and so a new code.
- A copied device identity is that person until the host removes them.
- A removed person keeps the code and can ask again. The owner can change the code for everyone: Settings, Hosting,
  Make a new code. The old code then reaches nobody, and everyone connected is cut off until given the new one.
- Every reconnect is a new guest to the rate limits. The gateway caps new guests at 120 a minute, so reconnecting to
  get a fresh budget is slowed, not stopped. Anyone with the code can burn that one shared budget, which refuses new
  guests for as long as they keep at it, and can keep the 20 waiting places full until each lapses.
- Anyone with the code can read the host's half of the signalling on the relay: the host's addresses and fingerprint,
  and that someone is joining and when. They need only sit on the relay. So a person holding the code can have the host's
  home address for as long as the code lives. A guest's half is sealed for the host alone, so the code does not give away a
  guest's address or fingerprint. They can knock, and replay the host's older messages, which can slow a join down but
  shows them nothing.

## The tunnel

The server, its routes, Socket.IO and LiveKit are unchanged. Guests reach them through one small generic
tunnel: a `fetch` and a WebSocket carried over WebRTC data channels (general-purpose pipes inside a WebRTC
connection). API calls, Socket.IO and LiveKit signalling all use the same tunnel. Media still flows directly from
the browser to LiveKit over WebRTC.

```text
 guest page ── data channels ──▶ bridge window ── loopback WebSocket ──▶ gateway ──▶ room server, LiveKit
 apps/web/src/tunnel/guest.ts    src/tunnel/bridge.ts                    apps/server/src/tunnel/gateway.ts
```

The host's side has two halves, because neither can do it all. Only a page can hold an `RTCPeerConnection`, so
the bridge window owns those and passes each guest's frames along unread. A page cannot set a `Cookie` or
`X-Forwarded-For` header, stream an upload over HTTP/1.1, or hold more than six requests open per server, which
one slow guest's video would use up. So a small gateway in Node makes the real requests, and keeps the rules. It
listens on loopback, and accepts only a window holding its per-run secret. The server must run with
`TRUST_PROXY=loopback`, or every guest looks like one address to the rate limits, so the gateway refuses to start
when its options do not say so. A hosted room believes a stated address only with the gateway's token for that run, so
no other program on the PC can state one. In the app the bridge is a hidden window, and the browser specs also run it in a
Chromium page. How the host's parts fit together is in [DESKTOP.md](DESKTOP.md).

Two negotiated channels carry the frames: one for files and one for everything else, so a video cannot hold up the
chat or a call's signalling. Each stream has its own 256 KB window, and the receiver reports what it has taken.
That reaches from the guest's video element to the room server's socket, so a paused video stops the download.

`livekit-client` takes no WebSocket of ours, so in a guest build `window.WebSocket` and `window.fetch` answer
differently for its made-up host alone, `livekit.hostile-tunnel.invalid`. This is the part a LiveKit upgrade could
break: its client must go on calling `new WebSocket(url)`, and the voice spec fails if it stops working.

The bridge must not become an open proxy:

- A guest can name a path, never a host. Only the room server and LiveKit are reachable.
- Frame sizes are limited, and messages are cut to 16 KB or less.
- The sender respects `bufferedAmount` for backpressure (the channel telling the sender to slow down).
- Requests are attributed per guest, so the server's rate limits still apply to each one. The gateway gives each
  connection a made-up address in `X-Forwarded-For`, and a guest cannot choose that or any other header outside
  a short list.
- Only `/api/*` (never the LiveKit webhook) and `/socket.io/` on the room server, and `/rtc` on LiveKit, are
  reachable. Each request gets its own connection, so a guest's bytes cannot be read as a second request.
- At most 64 streams per guest and 50 guests, by default.

## Files

`<img>` and `<video>` cannot read a data channel, so a Service Worker catches file requests and streams
them through the tunnel, including HTTP range requests for video seeking. This passes in Chromium and Playwright's
WebKit. Real Safari has not run it, and its behaviour here is the part to distrust until it has.

## Finding the host

`trystero` does the rendezvous (a meeting point for the first few encrypted packets, which never sees
messages, voice or video), with the code giving the room id and password. A code carries about 128 random
bits, so it is meant to be pasted, not read aloud. Negotiated data channels run on the `RTCPeerConnection`s
it provides.

Guests join as Trystero's "passive" peers, which never connect to each other, so the app never shows a guest
another's address, and neither does the relay to someone with the code (below). A passive peer waits to hear a
non-passive one, and on Nostr a host repeats itself only once a minute, so a guest publishes a knock, which carries
nothing, and the host answers it by announcing itself at once, at most once a second. That leans on how Trystero 0.26
words its messages, so the version is pinned, and the tunnel specs fail if it stops working.

The room code names the host. Its 16 bytes are the start of a SHA-256 hash over a label, the host's signing key (ECDSA
P-256, made once and kept in `host/secrets.json`) and 32 random bytes, which keep the code from being guessed from the key.
Make a new code changes only those random bytes. A host from before this design gets a new code once, on its first start
after the upgrade, and its guests need that code.

Everything put on a relay is sealed twice (`hostSealFor` and `guestSealFor` in `rendezvous.ts`, through a small patch to
Trystero in `patches/`). The outer seal is a key from the code. A topic is visible to anyone on the relay, and Trystero's
own announcements were readable and unsigned, so a made-up peer id published to it made the host build a connection and
an offer: 650 of them stopped real guests joining. Now what lacks the outer seal is dropped first, before any work with
keys, and a stranger sees only blobs. Inside it:

- The host signs everything it sends with its signing key, together with the code, a fresh key for this run of the
  bridge (ECDH P-256, held only in memory) and the time the run started. A guest checks that the code names the signing key and that the signature
  holds, and drops anything else. So a host with the code but another key cannot be believed.
- A guest seals everything it sends for that run key, with a fresh key of its own for each message, so only the host can
  open it. Another code holder sees a blob.
- Until a guest has checked a host, the only thing it may put on a relay is the knock.

A sealed message can be replayed. A guest follows the run that started last and never goes back to an earlier one. So the
host's messages from an earlier run, replayed to a guest that has not yet heard the current one, can send it to a run key
the host no longer holds, which slows that join until the host speaks again. If the host's clock was ahead during an
earlier run and has since been set right, that run's messages win, and replaying them can hold up joins for as long as
someone keeps at it. A guest's, replayed to the host, costs it one offer each, for ids already seen.

A relay's operator still sees the IP address of the host and of every guest, and can link them by topic, with no code
needed. So anyone running one of the public relays Trystero picks can find a host's home address. That comes with using
public relays: to reduce it, a host would choose its relays, and nothing lets it yet. The relays never see the code,
and never read a message. A STUN server sees the address of every page that asks it, and the host, which every guest
connects to directly, sees every guest's.

Chromium offers a page that has no microphone permission only its default-route address, as an mDNS name unless told
otherwise. Every guest on a first visit is such a page, and that is fine across real networks, where the public address
from STUN does the work. It matters for the host: the bridge window must offer all of its addresses, so that a guest on
the same machine or LAN can reach it. On this Mac two pages without the permission could not meet at all, because that
default-route address does not reach itself. The app's session for that window answers yes when asked whether the
permission is held and no to every real request, so it gets the addresses and can never open a microphone.
[DESKTOP.md](DESKTOP.md) has the details.

Trystero leaves its rooms on `beforeunload`, which also fires when someone answers "stay" to "leave site?". A guest would
then lose the very upload the question was about, so `guest.ts` moves that handler to `pagehide` while joining.

Using a rendezvous every time is fine for the first version. Reaching a host with no rendezvous at all, by
asking the router to open a port, is out of scope for now.

Some pairs of networks cannot connect directly at all. Published estimates of how many sessions need a
relay run from about 8% to 25%, from vendors and anecdotes, and the real figure for friends' home networks
is unknown until measured. The project runs no relay. If connecting fails, the app says which step failed
and offers a field for a relay of your own. It never spins forever.

Tests use a local rendezvous so they do not depend on public services. Public relays are contacted only by
one deliberate smoke test.

## Database

PGlite (PostgreSQL 18 compiled to WebAssembly) through `pglite-prisma-adapter`, keeping the schema and the raw
SQL. The data folder is `DATA_DIR`: the database in `db/`, attachments in `uploads/`. The server applies the
migration SQL files itself at startup (`apps/server/src/db.ts`), because Prisma's migrate engine needs a server
to talk to. The integration and browser suites run on it unchanged.

Four things PGlite does not do by itself, and what the server does about them:

- **Durability.** It starts Postgres with fsync off, its file system has no fsync, and its fdatasync does
  nothing. So the server turns fsync on, wires it to the real one and sets `wal_sync_method=fsync`. Each
  commit now reaches the disk, and a test shows the call being made. Without this a power cut could lose
  commits or corrupt the database.
- **Time zone.** It takes one from the host's clock, while the adapter labels every timestamp as UTC. The
  server fixes it to UTC.
- **One opener.** A second process can open a folder already in use, and both carry on. The server takes a
  lock file (process id and boot time), and a stale one is reclaimed after a crash.
- **Maintenance.** Postgres runs as a single process, so there is no autovacuum and no timed checkpoint. The
  server runs `VACUUM ANALYZE` at each start. WAL grows to `max_wal_size`, 128 MB here, before a checkpoint. At
  PGlite's default of 1 GB it was measured at 880 MB of `pg_wal` after 760,000 rows, and recovery took 1.5 s.

There is one connection. Queries take turns, a transaction holds up everything else until it ends, and every
query runs on the same thread as the HTTP server, with an fsync per commit. Code inside `$transaction` must use
its `tx`: a query through `db` there waits until Prisma's timeout ends both. The isolation level Prisma asks for
is not applied (the adapter sends it outside the transaction), which changes nothing, since no other transaction
can run alongside.

Measured on this project's M-series Mac with 1,500 real sends through the API, against the same code on Postgres
17 in Docker (whose fsync goes to Docker's VM, so that side's disk cost is not comparable):

| Measure                         | PGlite          | Postgres in Docker              |
| ------------------------------- | --------------- | ------------------------------- |
| First start, empty folder       | 1.4 s           | 1.1 s container + 0.5 s migrate |
| Restart of the API              | 0.55 s, bundled | 0.28 s under tsx (PGlite: 0.77) |
| Reopen after `kill -9`          | 0.75 to 1.3 s   | not measured                    |
| One send, nothing else running  | 8.3 ms mean     | 7.1 ms mean                     |
| 50 messages of history          | 3.7 ms mean     | 5.9 ms mean                     |
| 10 writers flat out             | 153 sends/s     | 250 sends/s                     |
| 50 writers flat out             | 156 sends/s     | 328 sends/s                     |
| 50 writers, slowest 1% of sends | 3.9 s and up    | 0.25 s and up                   |
| Memory of the API process       | 0.7 to 1.6 GB   | not measured                    |

That memory row was taken with PGlite's default settings. The limit to know is about 150 sends a second, which a
room of friends will not reach. An empty database takes 39 MB on disk.

The server now starts PGlite with `shared_buffers=16MB`, `wal_buffers=1MB`, `work_mem=2MB`,
`maintenance_work_mem=16MB`, `min_wal_size=32MB` and `max_wal_size=128MB`. This costs no durability: every commit
still reaches the disk, and `pnpm test:durability` passes 10 of 10 rounds. On a table of 100,000 messages, point reads
and commits took the same time as with the defaults, and a full scan took 33 ms against 30 ms. The first start still
peaks far higher than anything after it, because creating the database runs Postgres's own setup: a sample every 100 ms
saw 869 to 934 MB in the server process, once. It rests at about 430 MB until the next start, and about 270 MB after it.

`pnpm test:durability` kills the real server during writes. Across ten kills on one database, under plain Node
and again under Electron's Node, every acknowledged message was there afterwards, the sequence numbers had no
gaps, and Postgres's index checker passed. Killing a first run while it creates the database is covered too.
A power cut remains unproven: `kill -9` shows recovery from a crash of the process, and surviving a power cut also
needs the disk to honour fsync, which this machine cannot test.

## Media

`livekit-server` ships as a bundled binary, one per platform, copied in at packaging time and never kept in git, so
the client code keeps working: noise suppression, screen share, per-person volume. Each host runs its own server, so
versions need not match across a room. `apps/desktop/livekit-manifest.json` names the version, source and SHA-256 per
platform: macOS arm64 is 1.13.7 from Homebrew, which is why the Mac build is Apple Silicon only for now, and Windows
x64 and Linux x64 are 1.13.11 from LiveKit's releases. Version 1.13.11 has not run any test here, and those two
SHA-256 values stay empty until it is downloaded. In development the host uses the Homebrew path. Its settings for a
home PC, generated per host from the host's own secret:

- `use_ice_lite` stays off. LiveKit's own sample warns it "might cause connect issue" behind NAT.
- `use_external_ip: true` finds the public address by STUN (a service that tells a PC its public address).
  Its sample notes clients otherwise use Google's public STUN servers, a small outside dependency that
  `stun_servers` can replace.
- `udp_port` sends all media through a single UDP port, the only thing that listens off loopback. It stays the same
  from one start to the next. A home firewall may ask about it the first time.
- Signalling is bound to 127.0.0.1, the TCP fallback is off (`tcp_port: 0`), and no TURN server runs.

It refuses joins with an HTTP 500 for its first seconds, about seven on one Mac, most of them spent checking its
external address. The bridge opens only after that, and the owner's own window waits for it before joining a call.

**The biggest risk.** LiveKit's client opens a WebSocket to its server for signalling, and a tab on HTTPS
cannot open that to a home PC. So `livekit-client` gets an object that behaves like a WebSocket but runs over
the tunnel. That is built, and a call and a screen share pass on one machine. A LiveKit upgrade could break it.
If it stops working, the choice is between fixing it and moving off LiveKit, which would be far more work: `voice/controller.ts` alone is about 1700 lines written against it.

## Where a tab gets the page

A microphone needs a secure page, so the page cannot come from the host over plain HTTP. It will come from a
static site on public HTTPS, such as GitHub Pages, which is free and needs no domain of our own. No such site is
set up yet. The build's `base` path has to match. A GitHub Pages project site shares `user.github.io` as its origin, and with it `localStorage`, with every other
project page of that account, and that storage holds sessions and codes: so it needs an origin of its own, an
organisation's Pages root or its own domain. The site holds no room data, and anyone can run a copy. Whoever controls it could
still ship code that reads everything in the tab, which is a reason to publish builds openly. The app does
not have this exposure.

## What hosting costs

Estimates from the presets in `packages/shared/src/limits.ts` (screen share up to 4.5 Mbps), with voice
assumed at about 40 kbps per speaker. Silence is not sent, so real voice figures are lower.

| Room                                 | Host upload               |
| ------------------------------------ | ------------------------- |
| 5 people, all talking                | about 0.6 Mbps            |
| 10 people, all talking               | about 3.2 Mbps            |
| 5 people, one screen share to 4      | about 18 Mbps, plus voice |
| 10 people, one screen share to 9     | about 41 Mbps, plus voice |
| One 200 MB video opened by 4 friends | 800 MB                    |

Voice is cheap, and screen sharing is what hits the limit.

## When the host is away

The room closes when the host's PC sleeps or shuts down. That is the core tradeoff of the design. Two hosts
sharing a room live, or automatic failover, means replicating data between PCs, which is a different and much
harder product.

Guests see that the host is away within about 12 seconds, and come back by themselves on the same code when it
returns. Their session survives a reload and a restart of the host. While hosting, the app keeps the PC from sleeping
by itself. Closing a laptop's lid still sleeps it, and that ends the room until the lid opens. Still only an idea,
with no decision behind it: moving a room to another PC as one file.

## Security on a home PC

- Rate-limit connection attempts, because each incoming packet can make a server allocate a connection. The
  gateway caps new guests at 120 a minute.
- A guest can see the host's IP, and a malicious one could flood that home connection. At this size there is
  no defence except letting in only people you trust.
- An unpatched server on a home network is the failure that matters most, so updates need a real answer before
  this is given to strangers.
- An unsigned app gets a frightening warning on macOS and Windows, and that warning will name an app called
  Hostile. There is no paid signing for now.

## Questions only real networks answer

Each of these can change the design, and none has been run on a real network:

1. Can a code from an app behind a home router reach a tab on mobile data?
2. Does media reach LiveKit on a home PC from another network? On one machine it goes to 127.0.0.1.
3. Does the database survive a power cut?
4. Do images and video seeking work in Firefox and in real Safari, on a Mac and on an iPhone? Only Chromium and
   Playwright's build of WebKit have run them.

Testing needs a matrix on real networks as well as the suites: a host on a normal router and on carrier NAT,
against guests on Wi-Fi, mobile data and a corporate network.

## Out of scope

Hosting from a tab or a phone; end-to-end encryption between guests; rooms talking to other rooms; live
replication between hosts.

## Sources

- [LiveKit config sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml): the settings
  quoted above.
- [libp2p WebRTC Direct specification](https://github.com/libp2p/specs/blob/master/webrtc/webrtc-direct.md):
  the 16 KB message limit and the warning about packets allocating connections.
- [Trystero](https://npmjs.com/package/trystero): rendezvous over public networks.
- [`pglite-prisma-adapter`](https://www.npmjs.com/package/pglite-prisma-adapter) and
  [Prisma driver adapters](https://www.prisma.io/docs/orm/core-concepts/supported-databases/database-drivers).
- Relay estimates, all vendor or anecdotal:
  [Fora Soft](https://www.forasoft.com/learn/video-streaming/glossary/terms-streaming/nat),
  [CallSphere](https://callsphere.ai/blog/vw1e-webrtc-ice-turn-gotchas-scale.md),
  [discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/5d_EJwM6iJM).
