# Oasis CU Overlay (macOS — Swift)

Native macOS replacement for the Electron `cu-overlay`. Frameless,
always-on-top floating panel that shows live computer-use session progress and
exposes pause / resume / cancel / steering controls.

## Why Swift instead of Electron on macOS

The Electron version had two recurring macOS issues that produced flaky UX:

- **Repaint stalls when the window was unfocused.** Transparent Electron
  windows on macOS skipped frames when not key, leaving the step list visibly
  stale even when the gateway state had moved on.
- **`alwaysOnTop` re-assertion churn.** Holding the floating layer above
  full-screen apps required re-asserting `alwaysOnTop` on a timer.

A native `NSPanel` with `.floating` level + `.canJoinAllSpaces` collection
behavior solves both for free, and the binary is ~1 MB instead of ~150 MB.

The Electron version is kept under [`apps/cu-overlay`](../cu-overlay) and is
still used on Windows / when the Swift bundle isn't built. See
`services/dev_agent/main.py` `launch_cu_overlay()` for the platform routing.

## Build

```bash
./Scripts/make-app.sh                # release build, ad-hoc signed
./Scripts/make-app.sh debug          # debug build, ad-hoc signed
```

Produces `OasisCUOverlay.app` in this directory. Ad-hoc signing is fine for
local dev. For distribution set `OASIS_CODESIGN_IDENTITY` to a Developer ID
identity (mirrors `oasis-echo/apps/mac/Scripts/make-app.sh`).

## Run

The dev-agent launches the bundle automatically when a CU session starts. To
run it manually:

```bash
open OasisCUOverlay.app --args --session=cu-xxxxxxxx --gateway=8000 --port=8008
```

Flags (compatible with the Electron launcher's argv so `dev-agent` can swap
backends without changing its spawn call):

| Flag | Default | Purpose |
|---|---|---|
| `--session=<id>` | (active session) | Pin the panel to a specific session id; otherwise tracks whatever the gateway reports as active. |
| `--gateway=<port>` | `8000` | api-gateway HTTP port for control endpoints (`/sessions/:id/pause`, `/resume`, `/feedback`, `DELETE /sessions/:id`). |
| `--port=<port>` | `8008` | dev-agent HTTP port for the proxied `/cu-overlay/active-session` endpoint. |

## Layout

```
apps/cu-overlay-mac/
├── Package.swift              SwiftPM, macOS 13+
├── Info.plist                 LSUIElement = true (no Dock icon, no Cmd-Tab)
├── OasisCUOverlay.entitlements
├── Scripts/make-app.sh        bundle SwiftPM binary into .app
└── Sources/OasisCUOverlay/
    ├── OasisCUOverlayApp.swift  @main + AppDelegate + arg parsing
    ├── OverlayPanel.swift       NSPanel subclass (.floating, .nonactivating)
    ├── OverlayView.swift        SwiftUI root: header, goal, step list, controls
    ├── SessionStore.swift       polls /cu-overlay/active-session every 700 ms
    └── Models.swift             CUSession / CUStep Codable shapes
```

## Polling cadence

The Electron version polled at 1.5 s, which felt visibly stale once Chrome
Bridge clicks shrank step-execution time below ~1 s. The Swift version polls
at 700 ms — fast enough to surface mid-step transitions, slow enough not to
hammer the gateway.
