# Testing

How to run the app locally and what the automated suites prove. The figures below were taken on an
earlier code base and were not repeated here, except where this page says so.
The suites run on the embedded database in [DESIGN.md](DESIGN.md), which also has the durability results.

---

## Same machine

Everything on one computer, no domain, no router changes.

```bash
pnpm setup:local
pnpm dev
```

- Browser client: <http://localhost:5190>. Open a second private window for a second user.
- Desktop: `pnpm dev:desktop -- --profile=alice` and `... --profile=bob`, each opening on the choice to host or join.
- The API is `http://localhost:4191`, LiveKit is `ws://localhost:17890`, both bound to loopback.

`localhost` is treated as a secure context by browsers, so microphone access and screen capture work
without TLS. This is only true for localhost.

### Two voice clients on one computer sound wrong, and that is not the app

With two clients in one call on one computer, what one client plays comes out of the same speakers
the other client's microphone is listening to. Your voice is sent, played a fraction of a second
later, picked up again and sent round once more: a decaying chain of delayed copies that sounds
metallic or "warped". Each client's echo canceller only knows about sound its own process played, so
it cannot remove the other client's output, and it degrades your live voice while it tries.

This happens even when the second client is muted, because muting stops it sending, not playing. Use
headphones for same-machine voice tests, or deafen every client but one. Two people on two computers
do not have this loop. `e2e/audio-quality.spec.ts` checks the part the app is responsible for: the
voice one client receives is a spectrally clean copy of what the other sent, played exactly once.

A Bluetooth headset adds a separate effect: macOS switches it to its low-quality hands-free profile
while its microphone is in use, which makes all audio sound thin. Picking the built-in microphone as
the input in Settings → Voice avoids it.

## Two computers

A server with no host app stays on loopback, because it has no code and so nothing would keep anyone on the network out.
To try two computers, one hosts from the app and the other joins with the code.

---

## Automated suites

```bash
pnpm test           # unit + integration
pnpm test:unit      # pure logic only, fast
pnpm test:integration   # real database on a throwaway folder + real local LiveKit
pnpm test:durability    # kills the real server during writes; ten rounds
pnpm test:e2e       # Playwright: real stack, two browser contexts, real media
pnpm test:e2e:desktop   # real Electron, unpackaged: hosting, joining, calls, restarts
node scripts/test.mjs e2e-packaged   # the macOS package itself (see below)
```

What they use:

- **Unit** — no services. Schemas, config validation, token signing, the rate limiter, message
  formatting, the reconnect reconciliation reducer and the chat store, the noise-mode preference
  migration and the mode-to-capture-constraints mapping (including that one in-app suppressor
  failing leaves the other usable), the queue that keeps two microphone-pipeline changes from
  overlapping, the decision about whether a suppressor that has finished building is still wanted,
  who hears "someone joined the stream", when a suppressor that keeps falling behind real time is
  given up on, which way incoming audio is played on a computer, an iPhone and an iPad and what a saved
  volume means on each, what may be attached to a message and how it uploads, waits its turn and fails, what a file that will not load has become, how replies and quotes stay current and what a finger on a message means, the `watching` report's backward compatibility and what the API keeps of it, both
  Content-Security-Policy builders, and the desktop shell's credential store, permission allowlist
  and refresh guards. The
  desktop package has no vitest; its tests run on Node's own test runner
  (`pnpm --filter @hostile/desktop test`), and `pnpm test:unit` includes them. So do the
  helpers behind the scripts (`scripts/lib/*.test.mjs`, also on Node's own runner, because the workspace
  root has no vitest).
- **Integration** — a new data folder in the system's temp directory, removed afterwards (never the
  development one; the harness refuses any folder whose name does not end in `_test`) and a real `livekit-server` on its own
  ports. LiveKit-dependent tests are **skipped, not passed**, when the binary is missing.
- **End-to-end** — starts its own stack (`.local/e2e/data_test`, emptied at each start; LiveKit on test ports, API, web client) and
  drives two independent browser contexts.

### How the media test proves media

Chromium's fake devices are used, with `--use-file-for-fake-audio-capture` pointed at a generated
440 Hz tone (the default fake microphone is silent, which would make "audio arrived" and "silence
arrived" indistinguishable). The assertions read the app's own Diagnostics panel and require, for the
_other_ participant's stream:

- `bytesReceived > 0` — media really crossed the network,
- `totalSamplesReceived > 0` — it was decoded, not just received,
- the media server's measured speech level `> 0` — the audio is not silence.

Decoded **audio energy** is deliberately not asserted: a headless browser has no audio output device,
so played-back energy stays at 0 even when everything is perfect. Real speakers and real microphones
need a person. Screen sharing asserts decoded video frames on the receiving
side, not merely that a video element appeared.

The fake-device flags live only in `playwright.config.ts`. They are not present in the application or
in any packaged build.

### How the noise-suppression tests measure suppression

Both measure the audio the _other_ client receives after it has crossed LiveKit, which is the only
place a sender's own meter cannot flatter itself.

- `e2e/noise-suppression.spec.ts` (project `chromium`, the 440 Hz tone) does **not** try to measure
  suppression. A tone is the one steady sound RNNoise protects on purpose — its pitch filter exists to
  keep voiced speech — so the tone is used for two other things: that the published track really
  carries the processor (read back from the app's own Diagnostics line, which names what
  `LocalAudioTrack.getProcessor()` is holding, not what the preference says), and that the level does
  not move. Measured, mean RMS of the received audio, A/B/A/B, over four full suite runs: **off
  0.15781–0.15873, standard 0.05078–0.05129, enhanced 0.15823–0.16092**, so enhanced sits at
  **0.998–1.014 of unsuppressed**. The test requires 0.8–1.25 of it, and that is the regression guard
  that matters: the channel-count bug described below halved this number, repeatably, and it was
  written up as a cost of RNNoise.
- `e2e/noise-speech.spec.ts` (project `chromium-speech`) is where suppression is proved. Its fake
  microphone is synthesised speech with constant broadband noise under it and long pauses, built at
  test-setup time by macOS `say` plus white noise mixed in Node (`e2e/fixtures.ts`); no audio is
  checked into the repository. Measured over four full suite runs: **the noise floor in the pauses
  falls from 0.00231–0.00234 to 0.00023–0.00028**, eight and a half to ten times quieter, with
  **speech at 0.993–1.006 of its level under standard**. The speech-to-noise ratio
  improves about eightfold and the voice is unchanged. The thresholds assert a fifth of the floor, at
  least four fifths of the speech, and a fivefold ratio improvement.
  On a machine without `say` (Linux) the file cannot be made, so the project is not defined at
  all and the suite stays green one measurement short. That is a real gap there, not a pass.

Two notes on where those numbers come from. Until this pass, enhanced measured 0.49 of the
unsuppressed tone and cost about 6 dB of speech, and both were documented as costs of RNNoise. They
were one bug: Chromium hands an `AudioWorkletNode` two input channels even when the microphone is mono
(probed in the browser — the capture track reports `channelCount` 1 while the worklet sees
`inputs[0].length` 2), the library writes only as many channels as its `maxChannels`, and the unwritten
one was emitted as digital silence and then averaged into the mono destination. Exactly half, for every
user, not only for stereo devices. And the same spec now also proves what is _not_ left behind: it
counts the AudioContexts the suppressor builds by patching the constructor from the test
(`countSuppressorContexts` in `e2e/helpers.ts`, so the application exposes nothing for the test's
benefit) and requires every superseded one to be closed.

Nobody has listened to any of it.

### Which noise mode a test starts on

Strong is the default, and FastEnhancer removes the 440 Hz tone the call tests listen for: measured
through a call, the tone arrived at 0.158 with suppression off, 0.048 on standard and 0.0001–0.0003 on
strong. So `signIn`, `askAndEnter` and the tunnel harness's `joinByCode` and `comeBack` store standard
as a chosen mode before the page loads (`pinNoiseMode` in `e2e/helpers.ts`), and only when nothing is
stored yet, so a test that changes the mode keeps its change across reloads. A test that wants the
real default calls `startOnDefaultNoiseMode(context)` first. The two desktop proofs of audio energy
(`e2e-desktop/host-room.spec.ts` proof 4 and the packaged call in `e2e-packaged/packaged.spec.ts`)
first check that the host's new profile is running FastEnhancer in the app, then set standard through
Settings on all three pages, since what they prove is the transport.

`e2e/noise-default.spec.ts` covers the default itself: a new profile shows "Strong (FastEnhancer)"
and its call runs FastEnhancer; a mode saved before the change is kept, and a choice made now survives
a reload; when FastEnhancer cannot start (an init script refuses its `AudioWorkletNode`) or cannot keep
up (three `auto_bypass` messages, the ones its worklet sends, dispatched on its port) as the default,
the call goes to standard with no toast, a note in Settings and the reason in Diagnostics, and the
microphone keeps sending; a chosen strong that cannot start still raises the toast; and a browser with
no AudioWorklet starts on standard without trying. `e2e/phone-background.spec.ts` adds the iPhone:
falling behind three times while in the background does not end strong, and the same once in front
ends it quietly. `e2e/other-engines.spec.ts` checks in Firefox, and in WebKit on desktop and iPhone,
that a new profile starts on strong and that the app's own `SuppressorProcessor` starts FastEnhancer
there at 48 kHz. Firefox on Linux cannot start its audio engine without a sound server, so the CI job
starts PulseAudio with a silent output first.

### How the call-tile test measures the avatar

In a large call tile the avatar is centred on both axes. Its size is what it always was, 0.36 of the
tile's height between 40 and 128 px, unless at that size its circle, grown to 1.04 as when someone
speaks, would come within 4 px of the name tag's real box; then it is the largest size that clears
the tag by 4 px, never under 32 px, and below that the overlap is accepted (`largeAvatarSize` in
`apps/web/src/features/voice/gallery.ts`, fed the tag's measured box by `CallView.tsx`).

`e2e/call-tiles.spec.ts` reads every tile, avatar and tag with `getBoundingClientRect` and requires,
in every layout: the avatar's centre within 0.5 CSS px of the tile's, the avatar no larger than
before and no smaller than 32 px, at least 3 px between the circle and the tag whenever the avatar is
above 32 px (4 by design, less up to rounding to whole pixels), the size from before kept wherever it
had room, and every tile inside the call. The layouts are one person at 1440×900 and 940×600, two (and
the sizes unchanged for two seconds while someone speaks), five with a long guest name at 1440×900,
1280×860, 1100×700 and 940×600 with the call's chat open and closed, a phone at 390×780 and 390×600,
beside a screen share, with one of two streams enlarged, and after the streams end. Your own tile's
tag has two lines ("you" under the name). Beside a stream a tile is a row with the avatar left of the
name, so there only the vertical centre is required. Each layout's sizes and distances are printed.

### How the phone-in-the-background test imitates a phone

`e2e/phone-background.spec.ts` puts a phone in a call through the real local LiveKit, with its browser in the
background, and checks that it keeps hearing and being heard, once and not twice, and after coming back. The phone is
Chromium, because that is the engine with fake microphones, given the phone's user agent and an init script that
imitates each phone's background rules as their engines' source states them: on an iPhone or iPad (WebKit), an
AudioContext with anything connected to its speaker stops when the page goes to the background and an audio element
does not; an iPhone ignores an element's volume and an iPad does not; Chrome on Android stops neither. A headless browser
has no speaker, so "heard" means what reaches a running context's destination or a playing, unmuted audio element.

It also covers deafen, "Mute for me" and the sender's own mute in the background (guards: the code before the fix passed
those too), a frozen page reconnecting with its sound, an iPhone offering no volume for a person or a stream and no
switch to lower streams, someone that iPhone had at 0% staying muted until "Unmute for me", an iPad stopping at 100% for a
person and a stream and Android at 200% for a person, the iPhone's noise suppressor sending without a gap in the
background, starting again there when an interruption ends, being rebuilt when the phone left it stopped, and giving way
to standard when it runs but lets nothing through, strong as the default not giving up while the iPhone is in the
background and giving way quietly once it is in front, and a computer keeping Web Audio.
`apps/web/test/audio-route.test.ts` covers which device is which, an iPhone asking for the desktop site included, and what
a saved volume means on each.

On the code before the fix, 9 of the 15 tests it had then failed, each at its own check: nothing heard from the
background on an iPhone or iPad, a volume slider offered on an iPhone and one going to 200% on an iPad, the
stream-lowering switch offered on an iPhone, the suppressor going silent in the background and being replaced by
standard, and no "Unmute for me" for someone left at 0%. The unit test could not load, since the module it tests
did not exist.

A review of the fix then added to it. The test of the stream-lowering switch became one per device that also shares a
screen with sound and looks at every stream volume; the iPhone's failed with the share tile's guard taken out, and the
iPad's was not run against a broken limit. The suppressor that lets nothing through is new: on the fix's first wiring an
iPhone left the watchdog's probes behind a silent gain that led nowhere, which neither Chromium nor WebKit renders, so
they read silence and the test failed at its first check. The unit test gained an iPhone asking for the desktop site,
which failed on the code that took it for an iPad. On the fixed code, all 17 and the unit test's 12 pass.

What it cannot imitate, and only a real phone can show: the phone's audio session and routing, whether the system lets
the page keep running, the lock screen, a phone call coming in, and what comes out of the speaker.

## The tunnel

`e2e/tunnel-*.spec.ts` run a real gateway, a Chromium page running the real bridge code (where the Electron window will
later run it), and guests on a site with no road to the API: a second Vite on port 5291 built with `HOSTILE_GUEST=1`. The
rendezvous is `e2e/local-rendezvous.ts` on port 5292, and there is no STUN, so these contact nothing outside this machine.

| Run                                                                                         | What it shows                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `node scripts/test.mjs e2e --project=chromium "--grep=tunnel"`                              | Chat, files, a call, the protections                                        |
| `node scripts/test.mjs e2e --project=chromium "--grep=without a new code"`                  | Reload and host restart                                                     |
| `node scripts/test.mjs e2e-engines --project=webkit "--grep=files through"`                 | Files and seeking with a guest in WebKit                                    |
| `E2E_PUBLIC_RENDEZVOUS=1 node scripts/test.mjs e2e "--grep=public rendezvous"`              | The one test that contacts public relays                                    |
| `node scripts/test.mjs e2e-desktop`                                                         | Real Electron: hosting, joining in one paste, files, calls, restarts, kills |
| `E2E_PUBLIC_RENDEZVOUS=1 node scripts/test.mjs e2e-desktop "--grep=over the public relays"` | A real host and a tab guest over the public relays. Run it on purpose       |
| `E2E_TUNNEL_MODE=1 node scripts/test.mjs e2e --project=chromium`                            | The whole existing suite, as a guest                                        |

In tunnel mode the specs stay as they are, but a guest's requests never touch the browser's network, so
`page.request`, `page.route`, `page.waitForResponse`, `page.routeWebSocket`, `page.on('request')`, `setOffline`, a spec's
own `fetch` in the page and a CDP session's upload limit would see nothing. `e2e/tunnel-mode.ts` gives them the same meaning
on the frames of the tunnel, under the tests only. With no route on the page a frame goes at once and the test process is
only told, because asking it first costs time that a reload right after can win.

The host's window holds a microphone permission in these tests, because a page without one offers only its default-route
address, and on a machine where that address does not reach itself a guest with no permissions could never connect. Most
tests grant the guest a microphone too, so `tunnel-chat.spec.ts` has one guest who has granted nothing.

The last count with `--project=chromium` was 196 of 196. In tunnel mode a removed person is cut off and lands on the join
screen with the host's message, not on the join card, so "a person joins, and is then removed" in `admin.spec.ts` checks for
that message there.

WebKit hides its address behind an mDNS name that the Chromium host on the same machine does not resolve, so under the tests
Trystero's own test switch reads such a name as loopback. Nothing proves here what real routers do.

## Asking to join

The default browser suite runs against a test server with nobody at the screen, so `JOIN_AUTO_ADMIT` lets people in at once.
`loadConfig` refuses it in production, and so while hosting, and a unit test says so. `e2e/seed-devices.ts` gives the seeded
Alice and Bob a session, and `signIn` puts that session on the device the test is using. `e2e/tunnel-ask.spec.ts` goes through
the real answer across the tunnel, on a server that lets nobody in by itself.

`e2e-desktop/host-answers.spec.ts` proves how the host answers and how a guest waits: a double click lets in one person, the
card leaves the message box and the Hosting tab free, repeated asking reaches an absent host about once in 10 seconds, a
refused picture on the first run costs nothing, and a guest in the room can paste a new code from the banner.
`e2e-desktop/host-join.spec.ts` proves the rest in real Electron with the real Let in: turned away with nothing kept, the queue,
returning on the same device after a reload, restarts and a new code, cleared storage, two people with one nickname, Remove in a
call, no entry without a code, a lost refresh answer, the notification, and a real wait of over three minutes through a dropped
connection and a host restart. The last takes about four minutes. `host-public.spec.ts` goes over the public relays, and only runs
with `E2E_PUBLIC_RENDEZVOUS=1`. One Mac cannot prove real home routers, carrier NAT, Windows or Linux.

## The packaged app

`node scripts/test.mjs e2e-packaged` builds the proof package (`pnpm package:desktop -- --proof`, described in
docs/DESKTOP.md) and drives it. Run `e2e-desktop` once before it, which builds the guest site it uses, and set
`E2E_PACKAGED_SKIP_BUILD=1` to reuse a proof package already built. The fuses keep Playwright's Electron mode out, so
`e2e-packaged/packaged.spec.ts` starts the app from the binary inside the bundle, with a throwaway data folder, and
connects to its pages over Chromium's DevTools port. It has no access to the main process, and nothing it does reaches
macOS's own dialogs. A Playwright Chromium tab is the browser guest; a second copy of the packaged app is the app guest.

It proves, in order: a first run with a nickname, pictures and a code, with LiveKit started from the app's resources and
the room server and gateway as Node utility processes; a tab and the second app asking and being let in, chat, a file,
and the host's picture reaching the tab; a call among the three with audio energy measured on each, and a screen share
from the tab decoded by both apps; a guest turned away; a returning tab coming straight in; a restart as owner; the app
guest restarting straight into the room, leaving, starting itself again and hosting a room of its own; Stop hosting
with no room process left; and quitting with no process left. With `E2E_MEASURE_MEMORY=1` it prints the memory figures
in docs/DESKTOP.md. Closing the window and Keep hosting are not in it: the close button needs input from the system
itself. `e2e-desktop/host-window.spec.ts` proves them on the unpackaged app.

After a proof build, build a release package (`pnpm package:desktop`) before `check:bundle-size` or handing anything
out: both write `apps/web/dist` and `apps/desktop/dist`.

## Real clicks, which no suite sees

Every suite clicks through Chromium's DevTools protocol, or Playwright's Electron mode, which delivers the click to the
page directly. On macOS a real mouse click goes through the system first, and if the page has marked that spot as a
window drag region (`-webkit-app-region: drag`), macOS starts moving the window and the page never sees the click. So a
button can pass every test and still do nothing for a person. An early build did exactly that: clicks on the
first-run card moved the window, and the console said `Window move completed without beginning` once per click.

`e2e-desktop/window-drag.spec.ts` reads the styles instead. On the first screen, the setup card (also in the smallest
window), Settings, the room, a profile card, the Forward and Delete dialogs, a voice call and the Join screen, it fails
if a control or a scrolling area sits in or under a drag region, if a drag region has anything inside it or is a
pseudo-element, or if the 28-pixel strip the window is dragged by is missing.
That catches the shape of the mistake, not every way Chromium can get a region wrong. So before a release, click through
a release build with a real mouse, or with a native input check that posts system-level mouse events: the first-run
card, the room, Settings and a dialog. Events posted to the app's process alone (`CGEventPostToPid`) were tried and are
not enough: Chromium showed hover but took no click, and the window did not move even from a drag region.

When checking by hand from another program, bring the window to the front before calling it blank. Chromium draws
nothing for a window that is not on screen, on another Space say, so a capture of it taken from the background after
the window reloaded, as it does once a room is made, shows only its dark background. Brought forward, it draws the room.
If a window really stays blank, the app's console may say why, but it reports only four things: the window's page
failing to load, its preload failing, the window not responding, and its renderer crashing. A blank window with any
other cause prints nothing. To see the console, start the app from Terminal with
`/Applications/Hostile.app/Contents/MacOS/Hostile`.
