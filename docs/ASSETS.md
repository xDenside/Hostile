# Bundled assets and licences

The audit of what Hostile ships, written before the first public commit. Hostile itself is under Apache
2.0 ([LICENSE](../LICENSE)). The tables below were read from the installed packages on 2026-11-05, with
`pnpm-lock.yaml` for the list.

**Result:** everything may ship alongside Apache 2.0, with the things to deal with first listed under
[Before a release](#before-a-release). There is no GPL or LGPL code in the npm dependencies. The sounds are
confirmed at their sources, the logo has no outside source on record, and `fastenhancer-web` ships with
a caveat, all explained below.

## Fonts

All nine come from `@fontsource` packages, and each package carries the full licence text as `LICENSE`.
The SIL Open Font License lets fonts be bundled with any software, as long as the licence and copyright
travel with them and the fonts are not sold on their own. The fonts stay under that licence; it does not
pass to Hostile, and Apache 2.0 does not pass to them. A Reserved Font Name only binds someone who
modifies the font, and Hostile ships them unmodified.

| Font             | Package                              | Licence | Copyright                                  | Reserved name | Used for           | May ship |
| ---------------- | ------------------------------------ | ------- | ------------------------------------------ | ------------- | ------------------ | -------- |
| Geist            | `@fontsource-variable/geist` 5.3.0   | OFL-1.1 | 2024, The Geist Project Authors            | no            | the interface font | Yes      |
| Caveat           | `@fontsource/caveat` 5.3.0           | OFL-1.1 | 2014, The Caveat Project Authors           | no            | display names      | Yes      |
| Comfortaa        | `@fontsource/comfortaa` 5.3.0        | OFL-1.1 | 2011, The Comfortaa Project Authors        | yes           | display names      | Yes      |
| JetBrains Mono   | `@fontsource/jetbrains-mono` 5.3.0   | OFL-1.1 | 2020, The JetBrains Mono Project Authors   | no            | display names      | Yes      |
| Pacifico         | `@fontsource/pacifico` 5.3.0         | OFL-1.1 | 2018, The Pacifico Project Authors         | no            | display names      | Yes      |
| Playfair Display | `@fontsource/playfair-display` 5.3.0 | OFL-1.1 | 2017, The Playfair Display Project Authors | yes           | display names      | Yes      |
| Press Start 2P   | `@fontsource/press-start-2p` 5.3.0   | OFL-1.1 | 2012, The Press Start 2P Project Authors   | yes           | display names      | Yes      |
| Russo One        | `@fontsource/russo-one` 5.3.0        | OFL-1.1 | 2011-2012, Jovanny Lemonad                 | yes           | display names      | Yes      |
| Unbounded        | `@fontsource/unbounded` 5.3.0        | OFL-1.1 | 2022, The Unbounded Project Authors        | no            | display names      | Yes      |

## Call sounds

The nine sounds in `apps/web/src/features/voice/sounds`. All are CC0 (public domain dedication, no
conditions), confirmed at both sources and recorded in `LICENSE.txt` beside them. They were trimmed,
level-matched and encoded to mono MP3.

| File              | Source                                    | Original           | Changed      | May ship |
| ----------------- | ----------------------------------------- | ------------------ | ------------ | -------- |
| `mute.mp3`        | Zulip notification sounds, Stefan Mertens | `down`             | slowed x0.78 | Yes      |
| `unmute.mp3`      | Zulip notification sounds, Stefan Mertens | `zaping`           | slowed x0.85 | Yes      |
| `leave.mp3`       | Zulip notification sounds, Stefan Mertens | `down`             | slowed x0.62 | Yes      |
| `share-start.mp3` | Zulip notification sounds, Stefan Mertens | `zaping`           | slowed x0.7  | Yes      |
| `share-stop.mp3`  | Zulip notification sounds, Stefan Mertens | `down`             | slowed x0.7  | Yes      |
| `join.mp3`        | "Interface Sounds" 1.0, Kenney            | `confirmation_001` | not slowed   | Yes      |
| `deafen.mp3`      | "Interface Sounds" 1.0, Kenney            | `minimize_006`     | not slowed   | Yes      |
| `undeafen.mp3`    | "Interface Sounds" 1.0, Kenney            | `maximize_006`     | not slowed   | Yes      |
| `viewer-join.mp3` | "Interface Sounds" 1.0, Kenney            | `glass_001`        | not slowed   | Yes      |

**How this was confirmed.** The CC0 statements of both packs were read: Zulip's `docs/THIRDPARTY`, for
`static/audio/notification_sounds` by Stefan Mertens, and the `License.txt` in Kenney's pack. All nine files
were then compared with their originals by normalised cross-correlation (how closely two waveforms match,
where 1.000 is the same shape). Each scored 0.993 to 1.000 against the original named above, and at most 0.569
against any other original. The originals are not in this repository; `LICENSE.txt` says where to find them.

## Logo

| File                                                   | What it is                                                                      | Origin                                          | May ship                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `apps/web/public/icon.svg`                             | Grey mark, a room seen from above with someone at its door. Seven lines of SVG. | Added as a new logo, no outside source recorded | Yes, as the project's own work |
| `apps/web/public/favicon.ico`, `apple-touch-icon.png`  | The same mark, rendered                                                         | Same                                            | Yes                            |
| `apps/desktop/build/icon.icns`, `icon.ico`, `icon.png` | The same mark, rendered by `apps/desktop/scripts/render-icon.mjs`               | Same                                            | Yes                            |

No outside source is recorded for the mark, and the PNG files hold no text metadata naming a tool or an author. No search
was made for similar marks. The name "Hostile" has had no trademark check.

## Noise suppression

These ship compiled code from other projects inside single files, so each layer is listed.

| Component                          | Version                  | Licence                                                  | Where it runs                                                                                 | May ship                   |
| ---------------------------------- | ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| `@sapphi-red/web-noise-suppressor` | 0.4.0                    | MIT (package `LICENSE`)                                  | the RNNoise worklet and loader                                                                | Yes                        |
| RNNoise (Xiph.Org, Mozilla)        | not versioned here       | BSD-3-Clause (`COPYING` in its repository)               | the enhanced suppressor, as WebAssembly inside the package above                              | Yes, with its notice       |
| `@shiguredo/rnnoise-wasm`          | 2022.2.0 (not confirmed) | Apache-2.0 (`LICENSE` in its repository)                 | the Emscripten build of RNNoise, compiled into the package above and not installed separately | Yes, with its notice       |
| `fastenhancer-web`                 | 0.1.1                    | MIT (package `LICENSE`, "fastenhancer-web contributors") | the strong suppressor: C engine, worklet, weights                                             | Yes, with the caveat below |
| FastEnhancer (Sunghwan Ahn et al.) | not versioned here       | MIT (`LICENSE` in its repository)                        | the model and its 48 kHz weights, inside the package above                                    | Yes                        |

**Caveat on `fastenhancer-web`.** Its README credits `kdrkdrkdr/fastenhancer.c.wasm` as its "reference
C/WASM implementation". That repository is understood to declare no licence, which was not re-checked here. The package
publishes its own engine under MIT. If its code was derived from that repository rather than guided by it, the
package's author could not have granted MIT over it. That cannot be settled from the published files. It is a
young package from a small project, and it is one suppressor among four settings, so it can be dropped without
touching anything else.

**It stays, and the caveat stands.** Noise suppression matters enough here to keep it. That does not settle
the question.

## Programs that ship whole

| Program                         | Version | Licence                                                        | May ship | What to carry                                                                                                                                                |
| ------------------------------- | ------- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `livekit-server` (media server) | 1.13.7  | Apache-2.0 (`LICENSE` and `NOTICE` beside the Homebrew binary) | Yes      | Its `LICENSE` and `NOTICE`. The Homebrew SBOM says `NOASSERTION`, so the Go libraries compiled into it were not itemised.                                    |
| Electron (desktop shell)        | 44.4.3  | MIT (package `LICENSE`)                                        | Yes      | Its `LICENSE` and the `LICENSES.chromium.html` it ships beside the app, covering Chromium and everything else inside it. Those were not read for this audit. |

LiveKit publishes no macOS build (`docs/SETUP.md`), so a bundled macOS binary has to come from a Homebrew
bottle or be built from source. Which one is not decided.

## Packages added for the design

Added for [DESIGN.md](DESIGN.md), and all in use now.

| Package                 | Version | Licence                                                  | Used by | May ship                                                                                                                                                                               |
| ----------------------- | ------- | -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@electric-sql/pglite`  | 0.5.10  | Apache-2.0 (package `LICENSE`)                           | server  | Yes. It compiles PostgreSQL itself to WebAssembly, and that licence text is not in this package's `LICENSE`; PostgreSQL's own licence is permissive: see `docs/third-party-licences/`. |
| `pglite-prisma-adapter` | 0.7.2   | MIT (`package.json`; **no licence file in the package**) | server  | Yes                                                                                                                                                                                    |
| `trystero`              | 0.26.0  | MIT (package `LICENSE`)                                  | web     | Yes                                                                                                                                                                                    |

## All runtime dependencies

Walked from `pnpm-lock.yaml`, from each package's `dependencies` down: 285 packages, including the ones above. By declared licence: 210 MIT, 28 ISC, 27 Apache-2.0, 9 OFL-1.1, 4 BSD-3-Clause, 2 Unlicense, 1 (Apache-2.0 AND BSD-3-Clause), 1 MIT and ISC, 1 BSD-2-Clause, 1 EPL-2.0, 1 0BSD. `pnpm ls -r --prod`, which an earlier count relied on, lists far fewer, because it stops short of what those packages pull in.

**No GPL, LGPL or AGPL.** The one that is not plainly permissive is `elkjs`, under EPL-2.0, a weak copyleft: it does not relicense the code around it, but whoever distributes it in compiled form has to keep its notices, say that it is available under EPL-2.0 and where its source is, and offer no conflicting terms for it. It comes only through `prisma` (by way of `@prisma/studio-core`), which is a dependency of `@hostile/server` because of the command-line tool, and nothing in `apps/server/src` imports it. The host app does not ship the `prisma` command-line tool, so `elkjs` and much of this list do not ship at all: see [Before a release](#before-a-release).

**Packages with no licence file**, relying on their `package.json` alone: `@bufbuild/protobuf`, `@prisma/dev`, `@radix-ui/react-compose-refs`, `@radix-ui/react-use-layout-effect`, `pglite-prisma-adapter`, `postgres`, `remeda`. When a notices file is generated, these need their text supplied from their source repositories.

| Package                                  | Version                                          | Licence                       | Used by        | May ship                |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------- | -------------- | ----------------------- |
| `@bufbuild/protobuf`                     | 1.10.1                                           | (Apache-2.0 AND BSD-3-Clause) | server, web    | Yes                     |
| `@electric-sql/pglite`                   | 0.4.3                                            | Apache-2.0                    | server         | Yes                     |
| `@electric-sql/pglite`                   | 0.5.10                                           | Apache-2.0                    | server         | Yes                     |
| `@electric-sql/pglite-socket`            | 0.1.3                                            | Apache-2.0                    | server         | Yes                     |
| `@electric-sql/pglite-tools`             | 0.3.3                                            | Apache-2.0                    | server         | Yes                     |
| `@fontsource-variable/geist`             | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/caveat`                     | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/comfortaa`                  | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/jetbrains-mono`             | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/pacifico`                   | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/playfair-display`           | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/press-start-2p`             | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/russo-one`                  | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@fontsource/unbounded`                  | 5.3.0                                            | OFL-1.1                       | web            | Yes                     |
| `@livekit/mutex`                         | 1.1.1                                            | Apache-2.0                    | web            | Yes                     |
| `@livekit/protocol`                      | 1.51.0                                           | Apache-2.0                    | server         | Yes                     |
| `@livekit/protocol`                      | 1.50.4                                           | Apache-2.0                    | web            | Yes                     |
| `@noble/secp256k1`                       | 3.2.0                                            | MIT                           | web            | Yes                     |
| `@pinojs/redact`                         | 0.4.0                                            | MIT                           | server         | Yes                     |
| `@prisma/client`                         | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/client-runtime-utils`           | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/config`                         | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/debug`                          | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/debug`                          | 7.2.0                                            | Apache-2.0                    | server         | Yes                     |
| `@prisma/dev`                            | 0.24.17                                          | ISC                           | server         | Yes                     |
| `@prisma/driver-adapter-utils`           | 7.2.0                                            | Apache-2.0                    | server         | Yes                     |
| `@prisma/engines`                        | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/engines-version`                | 8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8 | Apache-2.0                    | server         | Yes                     |
| `@prisma/fetch-engine`                   | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/get-platform`                   | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/get-platform`                   | 7.2.0                                            | Apache-2.0                    | server         | Yes                     |
| `@prisma/query-plan-executor`            | 7.2.0                                            | Apache-2.0                    | server         | Yes                     |
| `@prisma/streams-local`                  | 0.1.11                                           | Apache-2.0                    | server         | Yes                     |
| `@prisma/studio-core`                    | 0.33.0                                           | Apache-2.0                    | server         | Yes                     |
| `@radix-ui/primitive`                    | 1.1.3                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-compose-refs`           | 1.1.2                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-primitive`              | 2.1.3                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-slot`                   | 1.2.3                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-toggle`                 | 1.1.10                                           | MIT                           | server         | Yes                     |
| `@radix-ui/react-use-controllable-state` | 1.2.2                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-use-effect-event`       | 0.0.2                                            | MIT                           | server         | Yes                     |
| `@radix-ui/react-use-layout-effect`      | 1.1.1                                            | MIT                           | server         | Yes                     |
| `@sapphi-red/web-noise-suppressor`       | 0.4.0                                            | MIT                           | web            | Yes                     |
| `@socket.io/component-emitter`           | 3.1.2                                            | MIT                           | server, web    | Yes                     |
| `@standard-schema/spec`                  | 1.1.0                                            | MIT                           | server         | Yes                     |
| `@trystero-p2p/core`                     | 0.26.0                                           | MIT                           | web            | Yes                     |
| `@trystero-p2p/nostr`                    | 0.26.0                                           | MIT                           | web            | Yes                     |
| `@types/cors`                            | 2.8.19                                           | MIT                           | server         | Yes                     |
| `@types/d3-array`                        | 3.0.3                                            | MIT                           | server         | Yes                     |
| `@types/d3-color`                        | 3.1.0                                            | MIT                           | server         | Yes                     |
| `@types/d3-delaunay`                     | 6.0.1                                            | MIT                           | server         | Yes                     |
| `@types/d3-format`                       | 3.0.1                                            | MIT                           | server         | Yes                     |
| `@types/d3-geo`                          | 3.1.0                                            | MIT                           | server         | Yes                     |
| `@types/d3-interpolate`                  | 3.0.1                                            | MIT                           | server         | Yes                     |
| `@types/d3-path`                         | 3.1.1                                            | MIT                           | server         | Yes                     |
| `@types/d3-scale`                        | 4.0.2                                            | MIT                           | server         | Yes                     |
| `@types/d3-shape`                        | 3.1.7                                            | MIT                           | server         | Yes                     |
| `@types/d3-time`                         | 3.0.0                                            | MIT                           | server         | Yes                     |
| `@types/d3-time-format`                  | 2.1.0                                            | MIT                           | server         | Yes                     |
| `@types/dom-mediacapture-record`         | 1.0.22                                           | MIT                           | web            | Yes                     |
| `@types/geojson`                         | 7946.0.16                                        | MIT                           | server         | Yes                     |
| `@types/lodash`                          | 4.17.25                                          | MIT                           | server         | Yes                     |
| `@types/node`                            | 24.13.5                                          | MIT                           | server         | Yes                     |
| `@types/react`                           | 19.3.0                                           | MIT                           | server, web    | Yes                     |
| `@types/react-dom`                       | 19.3.0                                           | MIT                           | server         | Yes                     |
| `@types/ws`                              | 8.18.1                                           | MIT                           | server         | Yes                     |
| `@visx/curve`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/event`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/grid`                             | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/group`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/point`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/responsive`                       | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/scale`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/shape`                            | 4.0.1-alpha.0                                    | MIT                           | server         | Yes                     |
| `@visx/vendor`                           | 4.0.0-alpha.0                                    | MIT and ISC                   | server         | Yes                     |
| `accepts`                                | 1.3.8                                            | MIT                           | server         | Yes                     |
| `accepts`                                | 2.0.0                                            | MIT                           | server         | Yes                     |
| `ajv`                                    | 8.20.0                                           | MIT                           | server         | Yes                     |
| `atomic-sleep`                           | 1.0.0                                            | MIT                           | server         | Yes                     |
| `aws-ssl-profiles`                       | 1.1.2                                            | MIT                           | server         | Yes                     |
| `base64id`                               | 2.0.0                                            | MIT                           | server         | Yes                     |
| `better-result`                          | 2.10.0                                           | MIT                           | server         | Yes                     |
| `body-parser`                            | 2.4.0                                            | MIT                           | server         | Yes                     |
| `bytes`                                  | 3.1.2                                            | MIT                           | server         | Yes                     |
| `c12`                                    | 3.3.4                                            | MIT                           | server         | Yes                     |
| `call-bind-apply-helpers`                | 1.0.2                                            | MIT                           | server         | Yes                     |
| `call-bound`                             | 1.0.4                                            | MIT                           | server         | Yes                     |
| `chokidar`                               | 5.0.0                                            | MIT                           | server         | Yes                     |
| `classnames`                             | 2.5.1                                            | MIT                           | server         | Yes                     |
| `confbox`                                | 0.3.1                                            | MIT                           | server         | Yes                     |
| `confbox`                                | 0.2.4                                            | MIT                           | server         | Yes                     |
| `content-disposition`                    | 2.0.1                                            | MIT                           | server         | Yes                     |
| `content-type`                           | 2.1.0                                            | MIT                           | server         | Yes                     |
| `cookie`                                 | 0.7.2                                            | MIT                           | server         | Yes                     |
| `cookie`                                 | 2.0.1                                            | MIT                           | server         | Yes                     |
| `cookie-signature`                       | 1.2.2                                            | MIT                           | server         | Yes                     |
| `cors`                                   | 2.8.6                                            | MIT                           | server         | Yes                     |
| `cross-spawn`                            | 7.0.6                                            | MIT                           | server         | Yes                     |
| `csstype`                                | 3.2.3                                            | MIT                           | server, web    | Yes                     |
| `d3-array`                               | 3.2.4                                            | ISC                           | server         | Yes                     |
| `d3-array`                               | 3.2.1                                            | ISC                           | server         | Yes                     |
| `d3-color`                               | 3.1.0                                            | ISC                           | server         | Yes                     |
| `d3-delaunay`                            | 6.0.2                                            | ISC                           | server         | Yes                     |
| `d3-format`                              | 3.1.0                                            | ISC                           | server         | Yes                     |
| `d3-geo`                                 | 3.1.0                                            | ISC                           | server         | Yes                     |
| `d3-interpolate`                         | 3.0.1                                            | ISC                           | server         | Yes                     |
| `d3-path`                                | 3.1.0                                            | ISC                           | server         | Yes                     |
| `d3-scale`                               | 4.0.2                                            | ISC                           | server         | Yes                     |
| `d3-shape`                               | 3.2.0                                            | ISC                           | server         | Yes                     |
| `d3-time`                                | 3.1.0                                            | ISC                           | server         | Yes                     |
| `d3-time-format`                         | 4.1.0                                            | ISC                           | server         | Yes                     |
| `debug`                                  | 4.4.3                                            | MIT                           | server, web    | Yes                     |
| `deepmerge-ts`                           | 8.0.2                                            | BSD-3-Clause                  | server         | Yes                     |
| `defu`                                   | 6.1.7                                            | MIT                           | server         | Yes                     |
| `delaunator`                             | 5.1.0                                            | ISC                           | server         | Yes                     |
| `depd`                                   | 2.0.0                                            | MIT                           | server         | Yes                     |
| `destr`                                  | 2.0.5                                            | MIT                           | server         | Yes                     |
| `dotenv`                                 | 17.4.2                                           | BSD-2-Clause                  | server         | Yes                     |
| `dunder-proto`                           | 1.0.1                                            | MIT                           | server         | Yes                     |
| `ee-first`                               | 1.1.1                                            | MIT                           | server         | Yes                     |
| `effect`                                 | 3.20.0                                           | MIT                           | server         | Yes                     |
| `elkjs`                                  | 0.11.1                                           | EPL-2.0                       | server         | Yes, on its terms below |
| `empathic`                               | 2.0.0                                            | MIT                           | server         | Yes                     |
| `encodeurl`                              | 2.0.0                                            | MIT                           | server         | Yes                     |
| `engine.io`                              | 6.6.10                                           | MIT                           | server         | Yes                     |
| `engine.io-client`                       | 6.6.6                                            | MIT                           | web            | Yes                     |
| `engine.io-parser`                       | 5.2.3                                            | MIT                           | server, web    | Yes                     |
| `env-paths`                              | 3.0.0                                            | MIT                           | server         | Yes                     |
| `es-define-property`                     | 1.0.1                                            | MIT                           | server         | Yes                     |
| `es-errors`                              | 1.3.0                                            | MIT                           | server         | Yes                     |
| `es-object-atoms`                        | 1.1.2                                            | MIT                           | server         | Yes                     |
| `escape-html`                            | 1.0.3                                            | MIT                           | server         | Yes                     |
| `etag`                                   | 1.8.1                                            | MIT                           | server         | Yes                     |
| `events`                                 | 3.3.0                                            | MIT                           | web            | Yes                     |
| `express`                                | 5.3.0                                            | MIT                           | server         | Yes                     |
| `exsolve`                                | 1.1.1                                            | MIT                           | server         | Yes                     |
| `fast-check`                             | 3.23.2                                           | MIT                           | server         | Yes                     |
| `fast-decode-uri-component`              | 1.0.1                                            | MIT                           | server         | Yes                     |
| `fast-deep-equal`                        | 3.1.3                                            | MIT                           | server         | Yes                     |
| `fast-querystring`                       | 1.1.2                                            | MIT                           | server         | Yes                     |
| `fast-uri`                               | 3.1.8                                            | BSD-3-Clause                  | server         | Yes                     |
| `fastenhancer-web`                       | 0.1.1                                            | MIT                           | web            | Yes                     |
| `finalhandler`                           | 2.1.1                                            | MIT                           | server         | Yes                     |
| `find-my-way`                            | 9.7.0                                            | MIT                           | server         | Yes                     |
| `foreground-child`                       | 3.3.1                                            | ISC                           | server         | Yes                     |
| `forwarded`                              | 0.2.0                                            | MIT                           | server         | Yes                     |
| `framer-motion`                          | 14.9.0                                           | MIT                           | web            | Yes                     |
| `fresh`                                  | 2.0.0                                            | MIT                           | server         | Yes                     |
| `function-bind`                          | 1.1.2                                            | MIT                           | server         | Yes                     |
| `generate-function`                      | 2.3.1                                            | MIT                           | server         | Yes                     |
| `get-caller-file`                        | 2.0.5                                            | ISC                           | server         | Yes                     |
| `get-intrinsic`                          | 1.3.0                                            | MIT                           | server         | Yes                     |
| `get-port-please`                        | 3.2.0                                            | MIT                           | server         | Yes                     |
| `get-proto`                              | 1.0.1                                            | MIT                           | server         | Yes                     |
| `giget`                                  | 3.3.1                                            | MIT                           | server         | Yes                     |
| `gopd`                                   | 1.2.0                                            | MIT                           | server         | Yes                     |
| `graceful-fs`                            | 4.2.11                                           | ISC                           | server         | Yes                     |
| `grammex`                                | 3.1.13                                           | MIT                           | server         | Yes                     |
| `graphmatch`                             | 1.1.1                                            | MIT                           | server         | Yes                     |
| `has-flag`                               | 4.0.0                                            | MIT                           | server, web    | Yes                     |
| `has-symbols`                            | 1.1.0                                            | MIT                           | server         | Yes                     |
| `hasown`                                 | 2.0.4                                            | MIT                           | server         | Yes                     |
| `helmet`                                 | 8.3.0                                            | MIT                           | server         | Yes                     |
| `http-errors`                            | 2.0.1                                            | MIT                           | server         | Yes                     |
| `iconv-lite`                             | 0.7.3                                            | MIT                           | server         | Yes                     |
| `inherits`                               | 2.0.4                                            | ISC                           | server         | Yes                     |
| `internmap`                              | 2.0.3                                            | ISC                           | server         | Yes                     |
| `ipaddr.js`                              | 1.9.1                                            | MIT                           | server         | Yes                     |
| `is-promise`                             | 4.0.0                                            | MIT                           | server         | Yes                     |
| `is-property`                            | 1.0.2                                            | MIT                           | server         | Yes                     |
| `isexe`                                  | 2.0.0                                            | ISC                           | server         | Yes                     |
| `jiti`                                   | 2.7.0                                            | MIT                           | server         | Yes                     |
| `jose`                                   | 5.10.0                                           | MIT                           | server         | Yes                     |
| `jose`                                   | 6.2.12                                           | MIT                           | web            | Yes                     |
| `json-schema-traverse`                   | 1.0.0                                            | MIT                           | server         | Yes                     |
| `livekit-client`                         | 2.22.3                                           | Apache-2.0                    | web            | Yes                     |
| `livekit-server-sdk`                     | 2.19.0                                           | Apache-2.0                    | server         | Yes                     |
| `lodash`                                 | 4.18.1                                           | MIT                           | server         | Yes                     |
| `loglevel`                               | 1.9.2                                            | MIT                           | web            | Yes                     |
| `long`                                   | 5.3.2                                            | Apache-2.0                    | server         | Yes                     |
| `lru.min`                                | 1.1.5                                            | MIT                           | server         | Yes                     |
| `lucide-react`                           | 1.47.0                                           | ISC                           | web            | Yes                     |
| `machina`                                | 7.0.1                                            | MIT                           | web            | Yes                     |
| `math-intrinsics`                        | 1.1.0                                            | MIT                           | server         | Yes                     |
| `media-typer`                            | 1.1.1                                            | MIT                           | server         | Yes                     |
| `merge-descriptors`                      | 2.0.0                                            | MIT                           | server         | Yes                     |
| `mime-db`                                | 1.52.0                                           | MIT                           | server         | Yes                     |
| `mime-db`                                | 1.54.0                                           | MIT                           | server         | Yes                     |
| `mime-types`                             | 2.1.35                                           | MIT                           | server         | Yes                     |
| `mime-types`                             | 3.0.2                                            | MIT                           | server         | Yes                     |
| `motion`                                 | 14.9.0                                           | MIT                           | web            | Yes                     |
| `motion-dom`                             | 14.9.0                                           | MIT                           | web            | Yes                     |
| `motion-utils`                           | 14.7.0                                           | MIT                           | web            | Yes                     |
| `ms`                                     | 2.1.3                                            | MIT                           | server, web    | Yes                     |
| `mysql2`                                 | 3.24.4                                           | MIT                           | server         | Yes                     |
| `named-placeholders`                     | 1.1.6                                            | MIT                           | server         | Yes                     |
| `negotiator`                             | 0.6.3                                            | MIT                           | server         | Yes                     |
| `negotiator`                             | 1.1.0                                            | MIT                           | server         | Yes                     |
| `object-assign`                          | 4.1.1                                            | MIT                           | server         | Yes                     |
| `object-inspect`                         | 1.13.4                                           | MIT                           | server         | Yes                     |
| `ohash`                                  | 2.0.12                                           | MIT                           | server         | Yes                     |
| `on-exit-leak-free`                      | 2.1.2                                            | MIT                           | server         | Yes                     |
| `on-finished`                            | 2.4.1                                            | MIT                           | server         | Yes                     |
| `once`                                   | 1.4.0                                            | ISC                           | server         | Yes                     |
| `parseurl`                               | 1.3.3                                            | MIT                           | server         | Yes                     |
| `path-key`                               | 3.1.1                                            | MIT                           | server         | Yes                     |
| `path-to-regexp`                         | 8.4.2                                            | MIT                           | server         | Yes                     |
| `pathe`                                  | 2.0.3                                            | MIT                           | server         | Yes                     |
| `perfect-debounce`                       | 2.1.0                                            | MIT                           | server         | Yes                     |
| `pglite-prisma-adapter`                  | 0.7.2                                            | MIT                           | server         | Yes                     |
| `pino`                                   | 10.3.1                                           | MIT                           | server         | Yes                     |
| `pino-abstract-transport`                | 3.0.0                                            | MIT                           | server         | Yes                     |
| `pino-http`                              | 11.0.0                                           | MIT                           | server         | Yes                     |
| `pino-std-serializers`                   | 7.1.0                                            | MIT                           | server         | Yes                     |
| `pkg-types`                              | 2.3.3                                            | MIT                           | server         | Yes                     |
| `postgres`                               | 3.4.7                                            | Unlicense                     | server         | Yes                     |
| `postgres-array`                         | 3.0.4                                            | MIT                           | server         | Yes                     |
| `prisma`                                 | 7.10.1                                           | Apache-2.0                    | server         | Yes                     |
| `process-warning`                        | 5.1.0                                            | MIT                           | server         | Yes                     |
| `proper-lockfile`                        | 4.1.2                                            | MIT                           | server         | Yes                     |
| `proxy-addr`                             | 2.0.8                                            | MIT                           | server         | Yes                     |
| `pure-rand`                              | 6.1.0                                            | MIT                           | server         | Yes                     |
| `qs`                                     | 6.17.1                                           | BSD-3-Clause                  | server         | Yes                     |
| `quick-format-unescaped`                 | 4.0.4                                            | MIT                           | server         | Yes                     |
| `range-parser`                           | 1.3.0                                            | MIT                           | server         | Yes                     |
| `raw-body`                               | 3.0.2                                            | MIT                           | server         | Yes                     |
| `rc9`                                    | 3.1.0                                            | MIT                           | server         | Yes                     |
| `react`                                  | 19.3.0                                           | MIT                           | server, web    | Yes                     |
| `react-dom`                              | 19.3.0                                           | MIT                           | server, web    | Yes                     |
| `readdirp`                               | 5.1.1                                            | MIT                           | server         | Yes                     |
| `real-require`                           | 1.0.0                                            | MIT                           | server         | Yes                     |
| `real-require`                           | 0.2.0                                            | MIT                           | server         | Yes                     |
| `remeda`                                 | 2.33.4                                           | MIT                           | server         | Yes                     |
| `require-from-string`                    | 2.0.2                                            | MIT                           | server         | Yes                     |
| `ret`                                    | 0.5.0                                            | MIT                           | server         | Yes                     |
| `retry`                                  | 0.12.0                                           | MIT                           | server         | Yes                     |
| `robust-predicates`                      | 3.0.3                                            | Unlicense                     | server         | Yes                     |
| `router`                                 | 2.2.0                                            | MIT                           | server         | Yes                     |
| `rxjs`                                   | 7.8.2                                            | Apache-2.0                    | web            | Yes                     |
| `safe-regex2`                            | 5.1.1                                            | MIT                           | server         | Yes                     |
| `safe-stable-stringify`                  | 2.5.0                                            | MIT                           | server         | Yes                     |
| `safer-buffer`                           | 2.1.2                                            | MIT                           | server         | Yes                     |
| `scheduler`                              | 0.28.0                                           | MIT                           | server, web    | Yes                     |
| `sdp`                                    | 3.2.2                                            | MIT                           | web            | Yes                     |
| `sdp-transform`                          | 2.15.0                                           | MIT                           | web            | Yes                     |
| `send`                                   | 1.2.1                                            | MIT                           | server         | Yes                     |
| `serve-static`                           | 2.2.1                                            | MIT                           | server         | Yes                     |
| `setprototypeof`                         | 1.2.0                                            | ISC                           | server         | Yes                     |
| `shebang-command`                        | 2.0.0                                            | MIT                           | server         | Yes                     |
| `shebang-regex`                          | 3.0.0                                            | MIT                           | server         | Yes                     |
| `side-channel`                           | 1.1.1                                            | MIT                           | server         | Yes                     |
| `side-channel-list`                      | 1.0.1                                            | MIT                           | server         | Yes                     |
| `side-channel-map`                       | 1.0.1                                            | MIT                           | server         | Yes                     |
| `side-channel-weakmap`                   | 1.0.2                                            | MIT                           | server         | Yes                     |
| `signal-exit`                            | 3.0.7                                            | ISC                           | server         | Yes                     |
| `signal-exit`                            | 4.1.0                                            | ISC                           | server         | Yes                     |
| `socket.io`                              | 4.8.3                                            | MIT                           | server         | Yes                     |
| `socket.io-adapter`                      | 2.5.8                                            | MIT                           | server         | Yes                     |
| `socket.io-client`                       | 4.8.3                                            | MIT                           | web            | Yes                     |
| `socket.io-parser`                       | 4.2.7                                            | MIT                           | server, web    | Yes                     |
| `sonic-boom`                             | 4.2.1                                            | MIT                           | server         | Yes                     |
| `split2`                                 | 4.2.0                                            | ISC                           | server         | Yes                     |
| `sql-escaper`                            | 1.5.2                                            | MIT                           | server         | Yes                     |
| `statuses`                               | 2.0.2                                            | MIT                           | server         | Yes                     |
| `std-env`                                | 3.10.0                                           | MIT                           | server         | Yes                     |
| `supports-color`                         | 8.1.1                                            | MIT                           | server, web    | Yes                     |
| `thread-stream`                          | 4.2.0                                            | MIT                           | server         | Yes                     |
| `toidentifier`                           | 1.0.1                                            | MIT                           | server         | Yes                     |
| `trystero`                               | 0.26.0                                           | MIT                           | web            | Yes                     |
| `tslib`                                  | 2.8.1                                            | 0BSD                          | web            | Yes                     |
| `type-is`                                | 2.1.0                                            | MIT                           | server         | Yes                     |
| `typed-emitter`                          | 2.1.0                                            | MIT                           | web            | Yes                     |
| `typescript`                             | 6.0.3                                            | Apache-2.0                    | server         | Yes                     |
| `undici-types`                           | 7.18.2                                           | MIT                           | server         | Yes                     |
| `unpipe`                                 | 1.0.0                                            | MIT                           | server         | Yes                     |
| `valibot`                                | 1.4.2                                            | MIT                           | server         | Yes                     |
| `vary`                                   | 1.1.2                                            | MIT                           | server         | Yes                     |
| `webrtc-adapter`                         | 9.0.6                                            | BSD-3-Clause                  | web            | Yes                     |
| `which`                                  | 2.0.2                                            | ISC                           | server         | Yes                     |
| `wrappy`                                 | 1.0.2                                            | ISC                           | server         | Yes                     |
| `ws`                                     | 8.21.3                                           | MIT                           | server, web    | Yes                     |
| `xmlhttprequest-ssl`                     | 2.1.2                                            | MIT                           | web            | Yes                     |
| `zeptomatch`                             | 2.1.0                                            | MIT                           | server         | Yes                     |
| `zod`                                    | 4.6.7                                            | MIT                           | server, shared | Yes                     |
| `zustand`                                | 5.0.15                                           | MIT                           | web            | Yes                     |

Development-only packages (Vite, TypeScript, ESLint, Playwright, Vitest, Sass, esbuild, electron-builder and
what they pull in) do not ship and are not listed. `prisma` is listed because it is a runtime dependency today;
the host app does not ship its command-line tool: see [Before a release](#before-a-release).

The interface's animated effects were written for this project in plain CSS after studying uiverse.io,
magicui.design and reactbits.dev. No code is understood to have been copied from them, and this audit did not
compare the code.

## Before a release

Checked on the macOS build of 2026-11-05 (Apple Silicon, unsigned). Check again for every release and every platform.

1. **The notices file travels with the code.** MIT, BSD, ISC, Apache and OFL all require the licence text to travel with
   the code, and Vite's bundle does not carry it. Each web build generates `third-party-notices.txt` with
   `scripts/third-party-notices.mjs`: 285 packages, with LiveKit's `NOTICE`, nine copies of the OFL and the texts in
   [third-party-licences](third-party-licences/README.md). Until this check, the generator silently skipped every package
   whose `exports` hide its `package.json`, and everything under it, about half the list; that is fixed. The page guests
   load carries the file at its root. The Mac app carries it inside `app.asar` and again in
   `Contents/Resources/licences`, beside Electron's `LICENSE` and Chromium's `LICENSES.chromium.html`, which a Mac build
   used to leave out. Eight packages have no licence file to quote, and the file lists them at its end. The file names more
   than ships: it follows every runtime dependency in `package.json`, including the `prisma` tool's tree below.
2. **The `prisma` command-line tool does not ship, so `elkjs` does not either.** The host app runs the room server from
   one bundle holding only what its code imports, and applies migrations itself. The extracted `app.asar` of the Mac build
   holds no `elkjs` and no part of the tool. Shipping the tool with its dependencies would add 130 packages, about 241 MB
   installed, `elkjs` 7.7 MB of it; the whole `app.asar` is 39 MB. `prisma` stays a dependency of the server package
   because `prisma generate` runs when it is installed and built.

Two earlier items are closed: the sounds are confirmed at their sources, and `fastenhancer-web` stays, with its
caveat above.
