# Limitations and deliberate omissions

An honest list of what the application itself does not do. Anything here is either not implemented, not
verified, or bounded by something outside the application's control. The measurements were taken on an
earlier code base and were not repeated here. [DESIGN.md](DESIGN.md) lists what the
host-on-your-PC design has not built or proved yet.

## Who is who

- **The code plus one click is what lets someone in.** Anyone holding the code can ask, and the host decides. There is
  no second check of who is really asking: a friend's nickname and picture are whatever the asker typed.
- **A person is their device.** A new device or cleared browser data makes a new person, whose old messages keep the old
  name and picture. There is no recovery, linking or export. The host's key lasts a year, the limit browsers set, so at that
  rollover everyone asks again as someone new.
- **A copied browser profile is that person** until the host removes them. A guest's identity is a non-extractable key in
  IndexedDB, which page scripts cannot read out, but a copy of the whole profile on disk carries it.
- **Anyone holding the code learns the host's address** from the relays, for as long as the code lives, and sees when
  someone joins. A guest's own connection details are sealed for the host alone, and a host someone stands up on the code
  without the host's signing key gets nothing from a guest, on a first visit too.
- **Waiting places can be filled.** Guests without a session have ten seats, three minutes each, and whoever has waited
  longest makes room for a new one. People waiting for the host take a new seat by themselves. Twenty requests can wait
  at once, one per connection, and someone reconnecting with the code can hold those places until each lapses, 90 seconds
  after it stops looking. Changing the code stops them.
- **Safari may forget a guest in a tab.** WebKit is documented as clearing a site's script-writable storage after seven days
  of Safari use without a visit to it, and a tab guest's identity is in its storage, so they would ask again as someone
  new. This was not tested, because it cannot be run here. The page asks for persistent storage where the browser offers it,
  and whether that exempts Safari is not known. Friends on Safari keep their identity for certain only in the app.
- **Let in on someone who has already gone makes a member nobody uses.** A request stays on the list for up to 90 seconds
  after its tab closes, and letting it in then makes a real member who stays listed as offline until the host removes them.
- **A banner chosen before a reload during a wait is lost**, because it is held in that page until the host says yes. So
  is the card, if the host restarts after that reload: the person chooses again.
- **A program on the PC shares one budget for refresh tries.** Whatever reaches the room server on loopback without the
  gateway's token counts as one address, whatever it claims. It can use that budget up for 15 minutes, which the owner's
  own window also draws on.

## Hosting from the app

- **Closing a laptop's lid ends the room** until it opens. The app can stop a PC sleeping by itself, not this.
- **A new code cuts off everyone connected.** They need the new code from the host. A code that has leaked has no other answer.
- **The code changes once on upgrade.** The code now names the host's signing key, so a host from before that gets a new
  code on its first start after the upgrade, and has to give it to everyone again.
- **One PC at a time.** Moving a room to another PC is not built.
- **Proven on one Mac.** Both ends of every test were on the same machine, with one exception for the relays. The
  Apple Silicon package was run for real there (docs/DESKTOP.md, "The packaged app, checked"); real home routers,
  carrier NAT, Windows, Linux and an Intel Mac have not been tried.
- **The Mac package is not signed by a developer or notarized by Apple.** Gatekeeper stops it on first opening, and
  the person has to allow it once in System Settings. The steps are in docs/DESKTOP.md and have not been clicked
  through on screen.
- **The packaged app was driven only in ways a test tool can reach.** Its window was never closed with the close
  button under test, because that needs input from the system itself, so "Keep hosting" was proven on the unpackaged
  app only. macOS's own questions to a packaged app (microphone, local network, screen recording, keychain,
  notifications) were not seen: the proofs start it from its binary, which makes macOS ask the program that started
  it instead.
- **A screen share from the app** needs the system's Screen Recording permission, which only a person can grant.
  Its test skips on a Mac that has not granted it, and it ran with fake media devices.

- **macOS's question about the local network.** While hosting, macOS asks whether the app may find devices on local
  networks. The packaged app carries the wording in its Info.plist; it has not been seen on screen. What a guest on the same network
  loses when someone answers Don't Allow has not been tested, because that takes a second machine.
- **Leaving a room starts the app again** when that run began as a guest, so the window closes and reopens. The specs
  see the new process start, and the packaged-app proofs drive the new run to the first screen and host a room from
  it, on one Mac.
- **A media server slow to become ready was seen and not explained.** In two of four full runs of the desktop suite on
  one Mac, LiveKit had not answered as ready after 30 s, and the app wrongly said it had stopped. Fifteen later runs,
  five of them with most of the processor kept busy, did not repeat it; on its own LiveKit was ready in about 7 s every
  time. A VPN was running on that Mac, and LiveKit asks public STUN servers for this PC's address before it is ready,
  so the network is the remaining suspect. The app now says the media server is still starting after 20 s, lets guests
  into chat meanwhile, starts it again after 90 s, and logs what it last answered. If it keeps failing, the Hosting
  group says so and that stopping and hosting again retries.
- **Stopping during a call ends it abruptly.** The media server gets three seconds, then is killed.

## Not implemented (by choice, for now)

- **Push-to-talk (hold to talk).** Only toggle mute and toggle deafen exist, including as global
  shortcuts. A real global press-and-release implementation needs OS-level key hooks that Electron's
  `globalShortcut` does not provide; a half-version that misses a key-up would leave your microphone
  open, which is worse than not having it.
- **Webcams.** Voice tokens do not even grant the camera source. Voice and screen sharing came first
  deliberately.
- **Link previews, and attachments other than images and videos.** Previews add fetch-side request
  forgery concerns. Attachments are images (10 MB) and videos (30 MB), up to ten on a message, at most 1 GB per person in any 24 hours, and
  nothing is transcoded: a video plays only where the browser can decode it. They are stored and
  served as uploaded apart from location data, which comes out at upload, as it does from a member's
  avatar and banner ([SECURITY.md](SECURITY.md)). What that does not reach stays readable by anyone in
  the community: a file uploaded before that, WebM, a location track inside a video's media data, maker
  notes, a place written in a caption, and a file that did not parse as expected. Any other metadata a
  photo carries stays too, such as its camera and the time it was taken. Anyone holding a file's URL can
  fetch it without being in the room, until its message is deleted. A file not yet uploaded does not survive a reload of the page: its
  message comes back saying so, with its text, to be discarded and sent again. Text sent while an upload
  is running goes ahead of it, because a message takes its place when it reaches the server. Two messages
  upload at a time and the rest wait, in the order they were sent, so one sent after a long video can
  sit behind it, and of the two running, the later one can arrive first.
- **What an attached image can ask of a browser is bounded, not eliminated.** The server refuses an image
  whose pixels are out of proportion to its file: anything up to an 8K screen (128 MiB of pixels) always
  passes, since a blank screenshot compresses as far as any bomb does, and past that each byte of file
  pays for 160 bytes of pixels. So what stays open is deliberate: ten images of that free size on one
  message come to 1.3 GB from almost no bytes, and at the largest a 6 MB file still asks for 1 GB, not far
  past what a real 200 MP photo asks for. An animation is limited to 4 gigapixels for one pass, and a browser
  decodes that over time rather than holding it, so a long one at a large canvas can still be slow to
  play. No real device was brought near these numbers: the limits are measured from real files, and what
  they save a phone is reasoned, not observed. Nothing like this applies to a video, whose size the server
  never reads. Avatars and banners are not affected: they have their own 4096 px limit, and at that size a
  tiny file can still ask for 67 MB. A valid image refused this way cannot be sent as it is.
- **A forward is a copy, and it outlives its original.** Deleting a message does not take back forwards
  of it, or their files, and only the person who forwarded one, or the owner, can delete it. So
  deleting something does not mean it is gone from every channel, including a photo sent before
  locations were removed at upload, with its location still in it. Editing the original does not change a forward either, and a forward cannot be edited at all. The
  line under it keeps the channel's name from that moment, so it can read differently from the channel
  after a rename.
- **Replies.** A reply can only answer a message in its own channel. Text of up to 160 characters of the
  original travels with it, on purpose, and goes when the original is deleted. There are no threads:
  replying to a reply quotes that one message and nothing further back, and nothing notifies the
  person being answered beyond the channel's ordinary unread dot.
- **The menu on a phone.** A long press opens the message's menu, so text in a message cannot be selected
  by finger: Copy text takes all of it. A browser holds back small finger movements, so one that moves
  10 to about 15 pixels is still a long press in Chromium rather than the 10 asked for.
- **Direct messages, threads, reactions, pinned messages, search.** Out of scope for a 3–10 person
  room with a handful of channels.
- **Multiple communities / servers.** One community per host, which is why there is no server
  rail in the sidebar.
- **Roles beyond owner and member.** There is exactly one owner (whoever hosts the room, on its first run) and
  everyone else is a member.
- **Automatic updates for the desktop client.** Rebuild and reinstall.
- **Mobile clients.**

## Implemented but not verified on real hardware

The automated suites prove the media path with synthetic devices. The following have **not** been run
with real hardware or on a second machine:

- real microphones and speakers/headsets, device switching, device removal mid-call,
- sleep/wake recovery,
- macOS permission dialogs for a _packaged_ app (unpackaged development runs attribute permissions to
  the launching terminal instead),
- system-audio capture on Windows and on macOS 14.2+,
- global shortcuts against other focused applications,
- the packaged Windows client (no Windows machine was available),
- LAN testing across two computers.

Nor have these, for attachments:

- **A browser's limit on media players.** None was found on a desktop: 500 live videos in the app all
  loaded in Chromium, and 1000 in WebKit on a test page. Android's Chrome is understood to stop at about
  40, which is from memory: no Android device was tried. What is measured is the app's side of it: at most
  25 videos have a player at any moment on a phone-sized screen, and 30 on a desktop.
- **What a browser other than Chromium does with a dropped file.** Chromium opens it in a new tab, which
  the guard is shown to stop. Others have been known to replace the page. Neither Firefox nor Safari has
  been tried, since only Chromium lets a test make a real drop.
- **QuickTime files older than the file type box.** None was to hand, so they were tested as real ffmpeg
  output with the box taken out and the offsets corrected, which ffprobe, AVFoundation and WebKit all read.

## Enhanced noise suppression (RNNoise): what it is and is not

Settings → Voice offers four modes: off, standard (built in: the suppressor the browser, or the desktop
app's Chromium, already has), enhanced (RNNoise, in this app) and strong (FastEnhancer, in this app, and
the default for a new profile; next two sections). Honest comparison of enhanced, in the order that matters:

- **Better than standard on steady background noise.** Measured through a real call,
  with a fake microphone carrying speech over constant broadband noise, in four runs: the level in the
  pauses between words fell from 0.00231–0.00234 to 0.00023–0.00028 (eight and a half to ten times
  quieter), while the speech itself came through at 0.993–1.006 of its level with standard — about an
  eightfold improvement in speech-to-noise ratio, voice unchanged.
- **It does not make you quieter.** An earlier version of this page said it cost about 6 dB of voice.
  That was a bug in this client, not a property of RNNoise: the suppressor was being handed two
  channels and only wrote one, and the silent one was averaged into the mono stream. It is fixed, and
  the measurement above is from the fixed pipeline.
- **Below Krisp on sudden, non-stationary noise.** Discord uses Krisp, which is proprietary and, in
  LiveKit's plugin form, only works on LiveKit Cloud — not on a self-hosted server like this one.
  RNNoise is a small recurrent network trained on stationary noise; a door slam, a cough, a dog, a
  single loud keystroke or someone else talking in the room will get through where Krisp would often
  remove it. Steady fans, hum and room tone are what it is good at.
- **It leaves strongly periodic sounds alone**, which is by design: its pitch filter exists to protect
  voiced speech. A 440 Hz test tone comes through at 0.998–1.014 of its unsuppressed level, while
  standard cuts the same tone to a third of it.
- **It adds delay, and how much was not measured.** The suppressor's own buffering is 640 samples,
  13 ms at 48 kHz — that is read off the library's ring buffer, not timed. On top of it sit the extra
  AudioContext's own output buffering and the MediaStreamAudioDestinationNode, neither of which was
  measured, so the total added mouth-to-ear delay is unknown.
- **Its extra AudioContext bridges two clocks.** The context is driven by the output device while the
  capture track is driven by the input device, and the graph reconciles the two with no drift
  compensation. On a mismatched pair — a USB microphone with built-in or Bluetooth output — that is
  the classic cause of a periodic tick or a dropout every few seconds. Nobody has listened for it.
- **Nobody has listened to it.** Every claim above is a measurement taken by the automated suite. No
  person has judged how it sounds, on any real microphone. Quality by ear — warbling, musical noise, thinness on music — is unassessed.
- **A little more CPU**, one AudioWorklet and one extra AudioContext per client while a call is open.
  Not measured against a budget; it has not been tried on a slow machine.
- If the WebAssembly or the worklet cannot be loaded (an old browser, a policy without
  `'wasm-unsafe-eval'`, no memory), the session falls back to the standard suppressor, keeps your
  stored choice and says so. It never silently sends unprocessed audio, and never a dead microphone.
- **Not exercised: a reconnect while enhanced is on.** LiveKit republishes local tracks after a
  full reconnect and the processor travels with the track; the code path is the same one the device
  switch test covers, but nothing has cut a real connection mid-call to prove it.

## Strong noise suppression (FastEnhancer): what it is and is not

FastEnhancer is a streaming speech-enhancement network from 2025 (ICASSP 2026; MIT), run the same
way as RNNoise through `fastenhancer-web`, which ships its 48 kHz weights. Strong uses the Base model.
It replaced GTCRN, which removed noise well but sent nothing above 8 kHz.

- **The strongest suppressor the app has, and full-range.** Through a real call with the
  speech-over-noise fake microphone (two runs), the level in the pauses fell 253–430 times below
  standard's (RNNoise: 8.0–12.4 times in the same runs), with the speech at 1.068–1.090 of
  standard's loudness. Offline, on one synthetic clip of speech under fan noise, hum and
  keyboard clicks, it scored 13.0 dB SI-SDR at 5 dB SNR (GTCRN 11.7, RNNoise 7.0) and kept the band
  above 8 kHz. It is also the only small model in that comparison that left lightly noisy speech
  better than it found it: 28.2 dB from 25.0, where RNNoise and GTCRN dropped to 15.8 and 19.9.
- **Base, not Small.** Small scored 13.9 instead of 13.0 under heavy noise and the same under light
  noise, for about 2.4 times the CPU.
- **Several times RNNoise's CPU.** About 8% of one Apple Silicon core in that offline run (RNNoise:
  under 1%); the package's author reports 1.63 ms per 10.7 ms frame, 15% of the time available.
  Nothing here has measured a slow machine.
- **It gives way instead of crackling.** When a frame takes longer than the 10.7 ms of sound it
  covers, the worklet passes the microphone through unprocessed until it catches up. A computer
  that stays behind for 5 seconds, or falls behind three times in a minute, is moved to standard for
  the session (`apps/web/src/features/voice/overload.ts`), and told so if it chose strong; how that
  looks when strong was only the default is in the next section.
- **About as much delay as enhanced, not timed here.** 10.7 ms of algorithm (measured offline) and
  10.7 ms of frame buffering in the worklet, against about 23 ms in total for RNNoise. The extra
  AudioContext's own buffering comes on top, as it does for enhanced.
- **An 80 Hz high-pass sits in front of it.** RNNoise filters rumble internally and FastEnhancer does
  not; with standard off, nothing else in the path is guaranteed to.
- **A young package.** `fastenhancer-web` 0.1.1 was published in April 2026 by a small project. Its
  author reports output matching the original PyTorch model to about 10⁻⁶. Its weights arrive as
  JavaScript, about 400 KB compressed, the first time a call or a microphone test needs strong, which
  for a new profile is its first call.
- **Nobody has listened to it**, on any microphone. The
  clock-bridging, reconnect and fallback caveats listed for enhanced apply unchanged: it is the same
  pipeline with another worklet in it.

## Strong as the default: where it runs, and what happens when it does not

A new profile starts on strong. A saved mode is kept, standard saved by an earlier version included,
and the old on/off switch still means standard or off. The preference records whether the mode was
chosen, so a default is worked out again on every start rather than frozen the first time something
else is saved.

Where it runs, read from `apps/web/src/features/voice/suppressor.ts` and `fastenhancer-web` 0.1.1, and
measured where a machine here could:

- **It needs WebAssembly and AudioWorklet, nothing more.** No SharedArrayBuffer, no threads, no
  cross-origin isolation. Where either is missing the default is standard and nothing is tried, so
  nothing fails: Safari before 14.5, a page that is not a secure context (which has no microphone
  either), and, from memory and not tried, an iPhone in Lockdown Mode, which turns WebAssembly off.
- **WebAssembly that may not be compiled cannot be told apart in advance.** Under a policy without
  `'wasm-unsafe-eval'` strong is tried, fails at once, and the call is on standard before the
  microphone is sent.
- **No WebAssembly SIMD** (Safari before 16.4, old Chromium): the package loads its scalar build. In
  Chromium on this Mac (Apple Silicon) a 10.7 ms frame took 2.9 ms on average with it and 1.8 ms with
  SIMD, the worst of 900 frames 8 and 9 ms, none late.
- **iPhone and iPad.** WebKit runs it. In Playwright's WebKit on this Mac, desktop and iPhone
  emulation, the model was ready 6–10 ms after it reached the worklet and a frame took 1.5–1.7 ms on
  average, the worst 5–7 ms,
  none late. That is WebKit on a Mac's processor: no real iPhone has run it. The scalar build was not
  measured in WebKit. While an iPhone has the page in the background, falling behind is not acted on,
  because the change to standard re-opens the microphone, which is what iOS may refuse there; the
  count starts again when the page is in front (`hiddenOnIOS` in `suppressor.ts`).
- **Android.** Chrome there has everything it needs. A slow phone may not keep up, and then changes
  to standard. No Android device has tried it.
- **A slow computer** changes to standard the same way. None has been tried.
- **What it costs.** About 8% of one Apple Silicon core for the whole call (above), and on a phone
  the battery that goes with it, which was not measured. Each new profile downloads the model on its
  first call, about 430 KB compressed (403 KB of weights, 28 KB of WebAssembly, in this build): from
  the host's computer for the desktop app and a browser on its network, from the guest site for a
  guest. "Voice connected" does not wait for it; the microphone does.

What a person sees when strong does not run:

- **They chose it:** as before, a toast says it could not start and why, Settings → Voice says the
  same beside the choice, and the choice is kept for the next start.
- **It was only the default:** no toast. Settings → Voice shows a note, not a warning, with the
  reason and that standard is on for now; Diagnostics lists the reason under "Suppressors that
  failed". It is tried again at the next start. The few seconds before it gives way, if a computer
  is falling behind, go out unprocessed, as they do for a chosen strong.

## Profiles

- Profile images are served by a URL with a long random id and no session, because an image tag cannot
  send a token. Anyone given that link can see that one image.
- Colors are free choice, so a member can pick a name color that is hard to read on the dark background.
- Animated avatars hold their first frame in lists and chat until the row is hovered. They always
  play in the profile card, in voice tiles and on your own card.
- Animated name effects run wherever a name appears once per member. In chat, where one person can fill
  the screen, they run when the row is hovered.

## Stream ducking

- Off by default, per person, from Settings → Voice or by right-clicking a stream. It only lowers
  screen-share audio, and only on your machine.
- Anything loud enough on someone's microphone counts as talking, about -42 dBFS: a person with no noise
  suppression next to a loud fan can hold a stream down. Muting them for yourself stops that.
- It cannot lower sound the sharer plays into their own microphone, which is just their voice as far as
  anyone else can tell.

## Call sounds

- Recordings shipped with the client, played on your machine only, and switched off with Settings →
  Voice → Call sounds, where each can also be previewed. They follow your chosen output device where the browser supports
  choosing one for Web Audio (Chromium and the desktop app do).
- "Someone joined the stream" means a member has that screen share on screen in the call view. The
  member's client reports it, like mute; viewing a text channel, or enlarging another stream,
  stops it. A minimised desktop window with the call view open still counts as watching.
- Someone whose report vanishes and comes back within 15 seconds (their connection blipped, the API
  restarted) is not announced again, and neither is a member who flips away from the stream and back
  inside that window.
- Joins and departures that happen while your own connection is reconnecting are not announced:
  the room is re-read silently once it settles.

## Shortcuts

- In a browser, the shortcuts in Settings → Shortcuts only work while the Hostile tab is the one in front.
  A web page cannot hear keys pressed anywhere else. Global shortcuts exist only in the desktop app.
- Browsers keep some combinations for themselves and never show them to a page, such as new tab and close
  tab, so pressing one while setting a shortcut does nothing. Combinations known to be taken are refused with
  a reason, but that list is not exhaustive. A combination that seems to do nothing is taken by the browser or
  the system.
- A shortcut set in one browser does not follow you to another: bindings are stored on the machine, per
  person, like per-person volumes.
- Fullscreen acts on a stream that is on screen. If you are reading a text channel during a call, it says there
  is none rather than leaving the channel.

## Phones

- The layout below 720 px wide was checked in Chromium's phone emulation, not on a real phone.
- No phone browser can capture a screen, so the share button is not offered there. Watching a stream works.
- Right-click menus need a long press, which Safari on an iPhone does not report as a right-click. A tap still
  opens the profile card, which holds the mute control.
- The member list is still unavailable below 900 px, as it was. People in a call show under the channel, in the
  channel list.
- A call keeps going with the browser in the background, like a phone call. To make that work, an iPhone or
  iPad plays the other people through plain audio elements, because Safari there stops Web Audio the moment it
  goes to the background, and every browser on them is Safari underneath. A computer, an Android phone and the
  desktop app are unchanged: Chrome keeps Web Audio playing in the background. What an iPhone or iPad gives up:
  - On an iPhone there is no volume per person or per stream, and no "Lower streams when others talk",
    because iOS ignores an audio element's volume on an iPhone. "Mute for me" and Deafen still work.
  - On an iPad, volumes stop at 100%.
- On an iPhone, someone who refused the microphone keeps hearing the call in the background, but a person who
  joins while the page is in the background stays silent until they come back to it and tap "Enable audio",
  unless someone else is already being heard. A page cannot start sound in the background without a tap.
- Added to the Home Screen as an app, an iPhone loses the microphone and the sound in the background
  (WebKit bug 239602). Keep the call in a browser tab.
- Background calls were checked with Chromium imitating each phone's background rules, taken from the source of
  WebKit and Chromium. The WebKit behaviour this relies on was also seen in Safari's real engine on an iOS 26.5
  simulator, with a test page and not this app. Nothing here was tried on a real iPhone, iPad or Android phone,
  or with the screen locked.

## Bounded by the platform

- **System audio while screen sharing** is not universal. Windows captures everything you hear;
  Windows 11 and macOS 14.2+ can also exclude this app's own output (so other people's voices are not
  echoed back to them); macOS before 14.2 and most Linux setups cannot capture system audio at all.
  The picker says what the current machine supports, and if a source yields no audio track the app
  says so instead of pretending the stream has sound.
- **Browser screen sharing** offers whatever the browser's own picker offers; audio availability
  depends on the browser and on what you pick (a tab, a window, a whole screen).
- **Audio playback may be blocked** until you interact with the page (browser autoplay policy). The
  app shows an "Enable audio" button rather than failing silently.
- **A guest who refuses the microphone can usually still listen.** The app asks for the microphone
  before a call connects, because a browser without that permission offers the call only a made-up
  `.local` name instead of its real address. On a network where those names do not resolve, a guest
  who refuses cannot join voice at all through a host on the same machine or network.
- **Media tokens cannot be revoked** in LiveKit 1.13. In a hosted room the gateway refuses a removed person's call
  connection, so this matters only for a server run on its own; see [SECURITY.md](SECURITY.md#media-authorization).
- **Two windows of the same person** cannot both be in the same voice room. The newest window wins
  and the older one is told why.

## What the tunnel leaves open

[DESIGN.md](DESIGN.md) gives the reasons. The first two need someone holding the code.

- **The host's half of the signalling is readable with the code**, including the host's address, and so is the fact that
  someone is joining and when. A guest's half is sealed for the host, so the code does not give away a guest's address.
- **Someone holding the code can slow a join down**, by knocking, or by replaying the host's older messages, which can
  point a guest at a key the host no longer holds until the host speaks again. Neither shows them anything.
- **A host's certificate lasts a year**, the longest browsers allow, and a new one looks to guests like someone else. They
  are told, and paste the code again.
- **Relay operators see addresses.** Anyone running a relay in use sees the host's and every guest's IP address, and so
  does any STUN server a page asks.
- **No policy on the guest pages.** The guest and bridge pages carry no `Content-Security-Policy`, and the server's
  policy only covers a site it serves itself. A meta tag would cover them, once it can be tested against a built
  guest site, including WebAssembly and worklets for voice.

## Operational notes

- Messages are kept forever; there is no retention policy or export command yet.
- There is no backup automation.
- The API is a single process. It is the right size for 3–10 people, but it means restarting it drops
  every socket at once (clients reconnect and reconcile automatically).
- Presence and typing state live in memory; after an API restart they are rebuilt from reconnecting
  clients and from LiveKit, not from the database.
