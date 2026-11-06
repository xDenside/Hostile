# Hostile

**This is not ready to use, and there are no installers yet.** Do not use it for anything you care about.

Hostile is going to be a free Discord-style app with no rented server. One person hosts from their own PC in a
desktop app, the app gives a code, and friends paste it into the app or a browser tab and connect. Voice, screen
sharing and text chat all run on the host's PC.

## What works today

- **The app itself:** chat, voice, screen sharing and admin, as an ordinary client and server on one computer. The
  database runs inside the server, so there is no database to install.
- **Reaching a host with a code:** the rendezvous, and a tunnel over WebRTC data channels that carries chat, files,
  calls and screen shares. These pass browser tests on one Mac, with both ends on the same machine.

- **Hosting from the desktop app:** the app opens on a choice, host a room or join with a code. There is no login: a
  friend pastes the code, picks a nickname and asks to join, and the host clicks Let in. This passes tests in real
  Electron on one Mac, unpackaged. See [docs/DESKTOP.md](docs/DESKTOP.md).

Not built yet: an installable package holding the media server, and a public page for guests. Real home networks have not
been tried. [docs/DESIGN.md](docs/DESIGN.md) has the plan, and marks what is unbuilt and unproven.

## Running it as a developer

You need Node 24, pnpm 11 and `livekit-server`. [docs/SETUP.md](docs/SETUP.md) has the details.

```bash
git clone https://github.com/xDenside/Hostile.git
cd Hostile
pnpm install
pnpm setup:local    # say yes to the two test people, to have someone in the room
pnpm dev            # http://localhost:5190
```

## Documents

| Document                                     | What it covers                                        |
| -------------------------------------------- | ----------------------------------------------------- |
| [docs/DESIGN.md](docs/DESIGN.md)             | How hosting from a PC will work, and what is unproven |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the app is put together today                     |
| [docs/SETUP.md](docs/SETUP.md)               | Running it locally                                    |
| [docs/TESTING.md](docs/TESTING.md)           | The test suites and what they prove                   |
| [docs/SECURITY.md](docs/SECURITY.md)         | The trust model                                       |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md)   | What the app does not do                              |
| [docs/DESKTOP.md](docs/DESKTOP.md)           | The Electron shell                                    |
| [docs/ASSETS.md](docs/ASSETS.md)             | Fonts, sounds, the logo and dependency licences       |

## Licence

[Apache 2.0](LICENSE). Bundled fonts and dependencies keep their own licences, listed in
[docs/ASSETS.md](docs/ASSETS.md).
