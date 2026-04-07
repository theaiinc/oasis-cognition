# Oasis Chrome Bridge

Chrome extension that bridges the browser to the Oasis dev-agent for **computer-use** page extraction, navigation, and element interaction.

## Why

The computer-use system needs to read page content (text, meta tags, URLs) from Chrome. Without this extension, it falls back to macOS OCR which is slow and error-prone — garbled text causes username discovery failures, 404 navigations, and broken CU sessions.

With the extension, the dev-agent gets **clean DOM text** including GitHub's `meta[name=user-login]` tag, making token discovery (e.g. `__DISCOVERED_USERNAME__`) work reliably.

## Install

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder: `extensions/oasis-chrome-bridge`
5. Verify the extension icon shows a green **ON** badge (means WebSocket connected to dev-agent)

> The Computer Use panel in the Oasis UI will show "Chrome Bridge connected" (green) or a warning banner with install instructions if the extension is not detected.

## How it works

```
Chrome Extension                    Dev-Agent (port 8008)
  background.js  ── WebSocket ──>  /ws/chrome-bridge
       |                                  |
  content.js                        chrome_bridge.py
  (DOM access)                      (command routing)
```

- **background.js** — MV3 service worker. Maintains a WebSocket to `ws://localhost:8008/ws/chrome-bridge` with auto-reconnect. Routes commands from dev-agent to Chrome APIs or the content script.
- **content.js** — Runs on all pages. Extracts `document.body.innerText`, `<meta>` tags, `data-login` attributes, element bounds, and handles click commands.
- **chrome_bridge.py** — Singleton in the dev-agent. Correlates request/response via UUID. Used by `computer_use.py` as the primary path for `get_page_text`, `chrome_navigate`, and `chrome_set_url`, with AppleScript as fallback.

## Commands

| Command | Description |
|---------|-------------|
| `get_page_text` | Extract URL, title, visible text, meta tags, tab list |
| `navigate` | Open URL in new or existing window |
| `set_url` | Navigate existing tab to new URL |
| `click_element` | Click element by CSS selector or text match |
| `get_element_bounds` | Get element screen coordinates |
| `ping` | Health check |

## Permissions

- `tabs` — enumerate and navigate tabs
- `scripting` — inject content script on demand
- `activeTab` — access current tab
- `alarms` — keep service worker alive
- `<all_urls>` — content script runs on all pages

## Troubleshooting

- **No green badge**: Dev-agent not running. Start it with `./scripts/start-dev-agent.sh`
- **Extension errors in chrome://extensions**: Click "Errors" to see details. Most common: dev-agent WebSocket not reachable.
- **Page text still empty**: Reload the extension after restarting dev-agent (click the refresh icon on the extension card).
