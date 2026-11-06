# Desktop clients

The desktop client is the same React application as the browser client, loaded from the app's own
`hostile://hostile` scheme inside an Electron shell. The shell adds what a browser cannot: OS-encrypted
credential storage, a screen-source picker, global shortcuts and window behaviour. It also hosts a room, or joins one
with a code. See "Hosting a room" below.

Minimum operating systems, set by Electron 44: **Windows 10 or newer (x64)** and **macOS 13 Ventura or
newer**. The Mac package is built for **Apple Silicon only**; nobody has built or run an Intel one.

## Running it during development

```bash
pnpm dev:desktop                                   # the app, with its pages from the Vite dev server
pnpm dev:desktop -- --profile=bob --no-build       # in another terminal, a second person
```

`pnpm dev:desktop` uses the Vite dev server that `pnpm dev` started if one is running, and otherwise starts its own,
which stops with it. The app needs nothing else: it hosts its own room server, with LiveKit from Homebrew on a Mac,
and joins other rooms through the public relays. On macOS the Dock shows Hostile's icon
(`apps/desktop/build/icon-mac.png`), as the packaged app does.

Each `--profile` gets its own Electron user-data directory, its own identity and its own
single-instance lock, so two profiles are two different people. Their folders are under
`~/Library/Application Support/Hostile/profiles` on a Mac. Each opens on the choice: one can host,
and the other can join with its code, which uses the public relays.

In development the renderer is loaded from the Vite dev server (hot reload) instead of `hostile://`; that
path only exists when the app is unpackaged and the environment variable set by `dev:desktop` is
present. It cannot happen in a packaged build.

## Building a package

```bash
pnpm package:desktop
```

This builds the web client, bundles the main process and preload, copies the renderer into the app,
and runs electron-builder for the platform you are on. Artifacts land in `apps/desktop/release/`.

Build on the operating system you are targeting:

- **macOS** → `.dmg` and `.zip` for Apple Silicon (arm64). It uses the Electron and dmg tools electron-builder keeps
  in `~/Library/Caches`, so a machine that has built once builds again offline. LiveKit is copied in from the
  Homebrew install (`brew install livekit`) by `scripts/lib/bundle-livekit.mjs`, which refuses a
  file whose hash differs from `apps/desktop/livekit-manifest.json`.
- **Windows** → an NSIS `.exe` installer (per-user by default, installation directory changeable).
- Cross-building a Windows installer from macOS is refused unless you pass `--allow-cross`, because
  electron-builder needs extra tooling for it that is not part of this repository. Nothing pretends a
  build succeeded when it did not.

## Signing, notarization and what your friends will see

The default build is **unsigned**. That is fine for yourself and for people you hand the file to
directly, but it is not invisible:

- **macOS** — an app that is not notarized is stopped by Gatekeeper the first time it is opened from a download.
  Since macOS 15 the old way round it, right-click → _Open_, no longer offers an Open button. What a recipient does:
  1. Open the `.dmg` and drag Hostile to Applications. Open Hostile once. macOS says it was not opened, because
     Apple could not check it for malicious software. Click _Done_, not _Move to Trash_.
  2. Open _System Settings → Privacy & Security_ and scroll down to _Security_. It says Hostile was blocked. Click
     _Open Anyway_, then _Open Anyway_ again, and confirm with your password or Touch ID.
  3. From then on Hostile opens normally.

  Someone at ease with Terminal can instead run `xattr -dr com.apple.quarantine /Applications/Hostile.app` once, which
  removes the "downloaded" mark that Gatekeeper checks. Both steps above were written from Apple's documented
  behaviour: on the build machine `spctl -a -vv -t exec` rejects a marked copy and `syspolicy_check distribution`
  reports it as ad-hoc signed and not notarized, but nobody has clicked through the dialogs on this version of the
  package. Do **not** turn off Gatekeeper globally
  (`spctl --master-disable`); that weakens the whole machine for one app. To remove the warning
  properly you need an Apple Developer Program membership ($99/year): set `CSC_LINK`/`CSC_KEY_PASSWORD`
  (or `CSC_NAME`), remove `identity: null` from `apps/desktop/electron-builder.yml`, and add
  notarization credentials so electron-builder can staple a ticket.

- **Windows** — SmartScreen will warn ("Windows protected your PC") for an unsigned installer until
  the file builds reputation. The recipient can click _More info → Run anyway_. Removing the warning
  needs an OV or EV code-signing certificate from a commercial CA.

The packaged macOS app is ad-hoc signed after the Electron fuses are flipped, which is what lets a
modified binary launch at all on Apple Silicon — that is not the same as Developer ID signing. The signature carries
the hardened runtime and `build/entitlements.mac.adhoc.plist`: see the switches section below.

## Moving the window on macOS

The Mac window has no title bar of its own (`titleBarStyle: hiddenInset`), so the page says where it can be dragged.
It is one strip as high as the window's buttons, 28 pixels, across the whole window, on every screen
(`.window-drag` in `apps/web/src/styles/global.scss`). Nothing clickable sits in or under it, and nothing that
scrolls passes under it: a click on a drag region moves the window and never reaches the page. Dialogs, the picture
viewer and profile cards keep below it. Windows and Linux keep the system's own title bar, and there the strip has no
height. Why no button may sit inside a drag region, even one marked `no-drag`, and how that is tested, is in
docs/TESTING.md under "Real clicks, which no suite sees".

## macOS permissions

- **Microphone** — requested on first use, described by `NSMicrophoneUsageDescription`.
- **Local network** — macOS asks while hosting, described by `NSLocalNetworkUsageDescription`.
- **Screen Recording** — macOS grants this in System Settings; the app cannot request it
  programmatically. When it is missing, listing screens and windows fails and the app says so with the
  exact place to enable it. macOS usually needs the app restarted after granting.
- **System audio while sharing** — needs macOS 14.2 or newer (Core Audio taps) and the
  `NSAudioCaptureUsageDescription` string that the packaged build carries. On older macOS it is simply
  unavailable, and the picker says so rather than offering a switch that does nothing.
- **Unpackaged development runs** attribute all of these permissions to whatever launched Electron
  (Terminal, iTerm, VS Code). A packaged build gets its own entries in System Settings. This is why the
  permission flows must be re-checked against a packaged build before trusting them.

## Security posture of the shell

Context isolation on, renderer sandbox on, Node integration off, `webSecurity` untouched, a
Content-Security-Policy derived from the room's own address, navigation and pop-ups blocked, external
links handed to the system browser after validation, a short permission allowlist, IPC validated
including the sender frame, and Electron fuses disabling `RunAsNode`, `NODE_OPTIONS` and the inspector
while requiring the app to load from the asar archive and verifying that archive against the hash in
the bundle. Details in [SECURITY.md](SECURITY.md).

The permission allowlist is `media`, `speaker-selection`, `clipboard-sanitized-write` and
`fullscreen`, each granted only to the app's own main frame. The first two are voice chat and the
output-device picker; the third is the Copy button on the room code; the fourth is the
Fullscreen button on a shared stream. Electron replaces Chromium's permission manager entirely, so
anything not listed — clipboard _reads_, `automatic-fullscreen`, notifications, geolocation, MIDI,
HID, serial, USB — is denied even though a browser would allow some of it. Video capture is refused
inside a media request as well, so the camera cannot be opened at all.

The hosted room's address and the media URL the server reports are both rebuilt from their parsed parts
before they reach a policy header. Without that, one semicolon in either value appends a CSP directive of
its own and the window renders blank.

### What the asar integrity fuse means for a build

`EnableEmbeddedAsarIntegrityValidation` is on, so Electron checks `app.asar` against the hash
electron-builder embedded in the bundle (`ElectronAsarIntegrity` in `Info.plist` on macOS, an
`INTEGRITY` resource in the `.exe` on Windows) and refuses to start if they disagree. Without it
`OnlyLoadAppFromAsar` forces the load path but verifies nothing, so anyone who can write to the
installed app could swap the archive and run their own code with the bundle's identity — and with the
Screen Recording and Microphone grants and the encrypted refresh token that identity owns.

The cost is that nothing may modify `app.asar` after electron-builder has hashed it. Adding
`asarUnpack` entries, or any packaging step that rewrites the archive, turns a shipped build into an
app that will not launch. The `afterPack` hook only patches the fuse wire and re-applies the ad-hoc
signature, with the hardened runtime, which is why it is safe today.

Checked on macOS arm64, on an earlier code base and not on a build of this one, by
flipping the fuse on a copy of the packaged 0.1.0 app and launching it: with
electron-builder's own hash it starts normally, and with one byte changed inside the archive it exits
immediately with `Integrity check failed for asar archive entry '<header>'`. The same two
checks were repeated on a fresh `pnpm package:desktop` build with the fuse enabled by the build
itself, with the same results. That is still the mechanism, not a test of the next build, so run the
packaged app once after `pnpm package:desktop`. The Windows side is
unverified like the rest of the Windows target — electron-builder embeds the hash there in the same
pass, but no Windows build has been run yet, so check that the installed app starts before handing it
to anyone.

Source maps are built for local debugging but excluded from the packaged app (`!dist/**/*.map`). They
were three quarters of the asar and the packaged app never reads them.

### Switches and variables a packaged app refuses

The tests start the unpackaged app with Chromium switches that hand its window to a test tool or fake its microphone,
and with `HOSTILE_*` variables that point it at a local meeting point, a renderer folder or other STUN servers.
Anything able to start an installed app with one of those could drive its window, with its microphone grant and its
room. So a packaged app:

- exits at once, with one line on its console, if started with `--remote-debugging-port`, `--remote-debugging-pipe`,
  `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--use-file-for-fake-audio-capture` or
  `--use-file-for-fake-video-capture`. Chromium would otherwise honour the first one in a packaged app; the fuses
  do not cover it.
- takes no library from `DYLD_INSERT_LIBRARIES` or any other `DYLD_` variable, in itself or any helper. The
  unsigned build is signed ad hoc with the hardened runtime, which ignores them. Library validation is off in that
  build only, because ad-hoc code has no team ID for it to compare, so someone able to write inside the installed app
  could still swap a library in; a Developer ID build keeps it on. The packaged-app proofs check this with a library
  that notes every process it is loaded into.
- ignores `HOSTILE_DESKTOP_RENDERER_URL`, `HOSTILE_DESKTOP_RENDERER_DIR`, `HOSTILE_TEST_RELAYS` and
  `HOSTILE_TEST_STUN`, which are read only when `app.isPackaged` is false.
- runs as itself with `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, because the fuses turn those off.

### The proof build

`pnpm package:desktop -- --proof` makes the package the packaged-app proofs drive
(`node scripts/test.mjs e2e-packaged`), into `.local/packaged-proof` and never into `release`. It is the same code
with one constant set at build time, never read from the environment, so a release build cannot be turned into one.
Never hand it to anyone. The local rendezvous address is in a release build's main bundle too, as a constant
nothing reads there. Only a packaged proof build:

1. accepts the switches above, so the proofs can reach its pages over Chromium's DevTools port and give it fake
   devices;
2. meets on the local rendezvous `ws://127.0.0.1:5392`, also baked into its renderer, instead of the public relays;
3. reports the microphone and screen as allowed and never asks macOS, so no system question appears;
4. logs a join request instead of showing a notification, because the first one would make macOS ask whether the app
   may send notifications.

The proofs start the app from its binary inside the bundle, not with `open`, so macOS treats it as part of the
program that started it and asks nothing in Hostile's own name. That also means they do not test macOS's own
questions for a packaged app: microphone, local network, screen recording and the keychain (they pass
`--use-mock-keychain`). Check those by hand on a release build. A proof build and a release build both write
`apps/web/dist` and `apps/desktop/dist`, so build a release package after a proof build before handing one out.

### The packaged app, checked

On one Apple Silicon Mac, on the 0.1.0 package built from this code:

- **Sizes.** The `.dmg` is 161.5 MB and the `.zip` 161.6 MB. The app takes 414 MB on disk: Electron's frameworks
  300 MB, LiveKit 52 MB, `app.asar` 39 MB and Chromium's licence file 20 MB. Sizes in MB of 1,000,000 bytes, as Finder
  shows them.
- **Fuses**, read back from the built app with `npx @electron/fuses read --app`: RunAsNode off, NODE_OPTIONS off, the
  inspector switches off, cookie encryption on, asar integrity on, load only from the asar on, extra file-protocol
  privileges off.
- **Info.plist**: bundle id `app.hostile.desktop`, name Hostile, version 0.1.0, icon `icon.icns`, macOS 13 or newer.
  The words macOS shows:
  - Microphone: "Hostile uses the microphone for voice chat with the people in your room."
  - System audio while sharing: "Hostile can include the audio of the screen or window you share, so the others hear
    it too."
  - Local network: "While you host a room, Hostile uses your local network so that a guest on the same network can
    connect to this computer directly."
  - Camera and Bluetooth: no string, on purpose. The app never opens the camera, and Electron's default camera string
    would suggest it does.
  - Screen recording: macOS has no string for it. It names the app and sends the person to System Settings.
- **Inside the asar**: the room server and gateway bundles, PGlite's `pglite.wasm`, `pglite.data` and `initdb.wasm`,
  the nine migrations, the renderer with `third-party-notices.txt`, and no source maps. Nothing is unpacked: the
  room server reads all of them from inside the archive, which the packaged-app proofs show by making and using a room.
- **LiveKit** sits in `Contents/Resources/bin` as an arm64 binary with the ad-hoc signature its linker gave it, and
  starts from there when hosting.
- **Signature**: `codesign -dv` shows `flags=0x10002(adhoc,runtime)` on the app, its four helpers and Electron
  Framework, with the three entitlements of `build/entitlements.mac.adhoc.plist`. A deep, strict
  `codesign --verify` passes.
- **Licences** are in `Contents/Resources/licences`: the notices, Electron's licence and Chromium's
  `LICENSES.chromium.html`. The notices also ship inside the app, where Settings, Diagnostics opens them.
- **A release build hosting with every test variable set** (`HOSTILE_TEST_RELAYS`, `HOSTILE_TEST_STUN`,
  `HOSTILE_DESKTOP_RENDERER_DIR` and `_URL`, `HOSTILE_PROOF_BUILD`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`,
  `--inspect`) started its server, gateway and LiveKit from inside the app, made its database, wrote no STUN server
  into LiveKit's settings, never touched the local rendezvous, loaded its own pages and opened no inspector. Started
  with any of the refused switches above, it exited at once with code 1.
- **Icon.** `icon.icns` sits on Apple's grid. Asked how it shows the app, macOS draws it with no grey plate, where it
  puts Electron's own icon on one. The Dock itself was not looked at on the build machine, whose Dock hides itself.

## Unit tests for the shell

```bash
pnpm --filter @hostile/desktop test
```

They run on Node's own test runner over the TypeScript sources: the permission allowlist, the
Content-Security-Policy builder, the settings store, the credential store (with `safeStorage`
replaced) and the auth service (with `net` replaced). The Electron process itself is covered by the
smoke test, `pnpm test:e2e:desktop`.

## Hosting a room

The app opens on a choice: host a room, or join with a code. There is no way to point it at any other server: such a
server would have no code and so no lock. The first time it hosts it asks for a nickname and optional pictures, with no
password, and shows the code. After that it opens straight back on hosting, as the owner.
So does an app that joined a room, until it leaves. Settings has a Hosting group with the code, the guests connected,
the state of each part in words, a new code, and Stop hosting. A guest gets a Room group with a way to leave.

A friend pastes the room code, fills in one card and clicks Ask to join. The host answers on a small card over the app, which
takes no focus, and stays off the Hosting tab, whose Waiting list shows the same. With the window closed or not focused, a native notification says who is asking, at most one every 10 seconds, with the nickname as plain
text, and clicking it opens the window with the request showing.

| Part                | Runs as                 | Listens on                        | If it stops     |
| ------------------- | ----------------------- | --------------------------------- | --------------- |
| Room server, PGlite | Utility process         | 127.0.0.1, a free port each start | Restarted       |
| Tunnel gateway      | Its own utility process | 127.0.0.1, a free port each start | Restarted       |
| LiveKit             | Child process           | 127.0.0.1 for signalling, one UDP | Restarted       |
| Bridge              | Hidden window           | Nothing                           | Reopened        |
| Your own window     | The usual window        | Nothing                           | Reloaded, twice |

Each part is restarted at most five times in five minutes, and the Hosting group says so. If the main process is
killed, LiveKit's watcher and the utility processes end with it, and the next start clears anything left.

**Why utility processes.** PGlite blocks its thread during a query, and the packaged app turns the `RunAsNode` fuse off.
**Why the gateway has its own.** Measured with a WebSocket echo beside PGlite while it ran a query pair taking about
100 ms on 100,000 messages: on PGlite's thread the slowest echo took 99 ms and the 99th percentile 95 ms; in its own process
the slowest took 2 ms. A separate process costs about 85 MB. Calls and "is the host alive" keep working through a busy
query or a checkpoint on a slow disk. Files still pass through the room server's thread, so they wait for a long query,
for as long as it runs. The app has no unindexed text search, so its own queries are far shorter than that test's.

**Your own window** talks straight to the server on 127.0.0.1. The policy allows that origin only while hosting, and only
on those ports. Its session stays in the main process, encrypted with the OS keychain in `credentials.bin`. **A guest in the
app** runs the same tunnel code as a browser tab, from `hostile://`, with its files through a Service Worker. Its identity
is kept as a tab's is, in `localStorage` under the host's fingerprint, not in `credentials.bin`.

**The bridge window** has its session in `persist:hostile-bridge`, because the certificate guests know this host by lives
in its IndexedDB, and background throttling off. Chromium hides a page's addresses behind mDNS names unless the page may
use the microphone, and guests on the same network need the real ones. So that session answers yes when asked whether the
permission is held, and no to every real request. It offers all its addresses, and `getUserMedia` rejects with
`NotAllowedError`. No system prompt appears, because only capture causes one. A browser that has granted nothing, and
offers only an mDNS name, still reaches it: the first-run spec connects one.

**Nothing listens off loopback but LiveKit's one UDP port.** WebRTC in any page starts Chromium's mDNS responder, which
holds UDP 5353 on every network. So `WebRtcHideLocalIpsWithMdns` is turned off for any run of the app that does not start as
a guest in someone else's room. It can only be set at start, so a run that starts with no room takes the host's side, and
someone joining for the first time offers the host their LAN address instead of a made-up name until the app next starts.
A run that started as a guest never hosts: leaving that room starts the app again, and asking such a run to host is refused.
While a guest is connected, WebRTC holds a UDP socket per network on a random port in the network process, for that
connection and only while it lasts. They answer only to the peer they were negotiated with. They are not a service.

**Secrets** live in `host/secrets.json` under the app's user data folder, mode 0600 in a 0700 folder: the session and
token secrets, LiveKit's key and secret, the owner's secret, the room code, about 128 bits from a real random source. They
reach the server by message and LiveKit by a 0600 file. They are never on a command line, and the first-run spec searches
the logs and command lines for them. The server compares the owner's secret by digest, on loopback, and it never reaches a
renderer.

### What it costs in memory

Measured on the packaged app on one Apple Silicon Mac, with `E2E_MEASURE_MEMORY=1 node scripts/test.mjs e2e-packaged`.
Two figures per process: resident memory from `ps` (RSS), and macOS's own footprint (`phys_footprint`, top's MEM
column). Adding up RSS overstates, because Electron's processes share pages; the footprint leaves shared pages out, so
its total is the better guide to what the room costs. The two windows are told apart by the order they start in.

| Process         | Just made, first run | Idle, 60 s later | Two guests in chat |
| --------------- | -------------------- | ---------------- | ------------------ |
| Room server     | 722 / 508 MB         | 228 / 167 MB     | 221 / 173 MB       |
| Main            | 196 / 66 MB          | 173 / 53 MB      | 177 / 53 MB        |
| Your own window | 160 / 78 MB          | 147 / 69 MB      | 156 / 61 MB        |
| Bridge window   | 117 / 29 MB          | 100 / 25 MB      | 109 / 29 MB        |
| Graphics        | 101 / 176 MB         | 94 / 83 MB       | 95 / 142 MB        |
| Tunnel gateway  | 88 / 25 MB           | 75 / 21 MB       | 80 / 25 MB         |
| Network         | 48 / 9 MB            | 48 / 8 MB        | 50 / 9 MB          |
| LiveKit         | 43 / 18 MB           | 42 / 18 MB       | 40 / 19 MB         |
| Audio           | not running          | not running      | 39 / 8 MB          |
| **Total**       | **1,477 / 911 MB**   | **909 / 446 MB** | **969 / 521 MB**   |

RSS first, footprint second. The first column is read the moment the room is up, which is the highest point the test
saw; 20 s later the total was still 1,142 / 804 MB, with the room server at 468 MB RSS, and it settles within a
minute. A guest in the packaged app, in chat, used 489 / 299 MB. The unpackaged app, measured the same way by RSS only,
came to about 1,007 MB idle.

## What the desktop client deliberately does not do

No tray icon. Closing the window ends the call and releases the microphone. While hosting, it first asks whether to
stop hosting. Keep hosting leaves the room running with no window until the app is opened again or quit.
No auto-update. No global push-to-talk (only toggle mute/deafen) — see
[LIMITATIONS.md](LIMITATIONS.md) for why.
