# Oasis Cognition — Desktop (Electron)

Native macOS shell around the existing React UI. Auto-update is intentionally
not wired (needs signing certs + release pipeline first); Windows/Linux
builds are out of scope for v1.

## Prerequisites

The desktop app does **not** spawn the backend services. You must already be
running them via the repo's `make up` (or equivalent), so the gateway is
reachable at `http://localhost:8000`.

## Dev (live UI from vite)

In one terminal:

```bash
cd apps/oasis-ui-react && npm run dev
```

In another:

```bash
cd apps/desktop
npm install
npm run dev
```

This launches Electron pointing at `http://localhost:3001`. Edits to the
React app hot-reload as usual.

## Local production build (no signing, dir-only)

```bash
cd apps/desktop
npm install
npm run package:mac:dir
# → dist-electron/mac-arm64/Oasis Cognition.app
open "dist-electron/mac-arm64/Oasis Cognition.app"
```

## Distributable build (DMG + zip)

```bash
npm run package:mac
# → dist-electron/Oasis Cognition-<version>-arm64.dmg (and x64, and zip)
```

The DMG/zip are unsigned. Distributing them externally requires a Developer
ID cert and notarization — wire those up before turning on auto-update.

## Renderer API

The preload exposes a tiny `window.oasis` surface to the React app:

- `window.oasis.isDesktop` — `true` when running in the shell
- `window.oasis.notify({ title, body, silent? })` — native notification
- `window.oasis.appInfo()` — `{ version, electron, chrome, platform, packaged }`

## What's NOT here

- Auto-update (needs code signing + a release host first)
- Windows / Linux packaging (macOS-only for v1)
- Backend service supervision (use `make up`)
