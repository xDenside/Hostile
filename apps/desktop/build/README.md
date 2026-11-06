# Packaging resources

electron-builder reads this directory (`buildResources`) while packaging.

## Icons

All four are rendered from the app's grey mark by `apps/desktop/scripts/render-icon.mjs`, which needs only what
is installed: Playwright's Chromium, `iconutil` on macOS, and a small `.ico` writer of its own. Run it again to change them.
electron-builder picks them up:

| File           | Used by              | Requirement                                |
| -------------- | -------------------- | ------------------------------------------ |
| `icon.icns`    | macOS dmg and app    | 1024x1024, all sizes inside the `.icns`    |
| `icon-mac.png` | the Dock, unpackaged | 1024x1024, the same picture as `icon.icns` |
| `icon.ico`     | Windows nsis + exe   | 256x256 included (multi-size `.ico`)       |
| `icon.png`     | Linux AppImage       | 1024x1024 (512x512 minimum)                |

The two for macOS sit on Apple's grid: an 824x824 body with continuous corners, centred on a 1024 canvas with a
transparent margin. A full-bleed icon looks too big in the Dock, and recent macOS draws an icon that does not fit that shape
on a grey plate. `icon.png` and `icon.ico` stay full-bleed. electron-builder picks up the first three with no change to
`electron-builder.yml`. `icon-mac.png` is not packaged: an unpackaged run on macOS, such as `pnpm dev:desktop` or a test,
sets it as the Dock icon itself, which would otherwise be Electron's.

## `bin`

Packaging copies the bundled media server here, as `apps/desktop/livekit-manifest.json` names it. It is ignored by git.

## `entitlements.mac.plist` and `entitlements.mac.adhoc.plist`

The first is applied when a macOS build is signed with a Developer ID. Local builds are unsigned (`identity: null`
in `electron-builder.yml`), and the `afterPack` hook signs them ad hoc after flipping the Electron fuses, which is
what lets macOS launch them. That signature carries the hardened runtime and the second file, which adds
`disable-library-validation`: ad-hoc code has no team ID, and without it the app cannot load its own Electron
Framework. Keep that entitlement out of a Developer ID build.
Signing and notarizing for other machines needs a Developer ID: set `CSC_LINK`
and `CSC_KEY_PASSWORD`, remove `identity: null`, and notarize separately.
