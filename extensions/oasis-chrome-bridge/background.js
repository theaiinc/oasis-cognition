/**
 * Oasis Chrome Bridge — Background Service Worker
 *
 * Maintains a WebSocket connection to the dev-agent (ws://localhost:8008/ws/chrome-bridge).
 * Routes commands from dev-agent to Chrome APIs or content scripts.
 */

const WS_URL = "ws://localhost:8008/ws/chrome-bridge";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let pingTimer = null;
let connected = false;

/* ── Connection management ─────────────────────────────────────────────── */

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[OasisBridge] WebSocket create failed:", e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[OasisBridge] Connected to dev-agent");
    connected = true;
    reconnectDelay = RECONNECT_BASE_MS;
    updateBadge(true);
    startPing();
  };

  ws.onclose = () => {
    console.log("[OasisBridge] Disconnected");
    connected = false;
    updateBadge(false);
    stopPing();
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.warn("[OasisBridge] WS error:", e);
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn("[OasisBridge] Invalid JSON from dev-agent");
      return;
    }

    if (data.type === "request") {
      handleCommand(data);
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: crypto.randomUUID(), type: "response", command: "ping", success: true, payload: {} }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function updateBadge(isConnected) {
  chrome.action.setBadgeText({ text: isConnected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: isConnected ? "#22c55e" : "#ef4444" });
}

/* ── Keep service worker alive via alarms ──────────────────────────────── */

if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 }); // ~25s
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      if (!connected) connect();
    }
  });
} else {
  // Fallback: use setInterval (less reliable for MV3 but works)
  setInterval(() => { if (!connected) connect(); }, 25000);
}

/* ── Tab finder: mirrors AppleScript heuristic ─────────────────────────── */

async function findTargetTab(urlHint) {
  const allTabs = await chrome.tabs.query({});

  // 1. Match by URL hint
  if (urlHint) {
    const hint = urlHint.toLowerCase();
    for (const tab of allTabs) {
      if (tab.url && tab.url.toLowerCase().includes(hint)) {
        return tab;
      }
    }
  }

  // 2. First non-localhost, non-extension tab
  for (const tab of allTabs) {
    const url = (tab.url || "").toLowerCase();
    if (
      url &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1") &&
      !url.startsWith("chrome://") &&
      !url.startsWith("chrome-extension://")
    ) {
      return tab;
    }
  }

  // 3. Active tab in the last focused window
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab || allTabs[0] || null;
}

/* ── Ensure content script is injected ─────────────────────────────────── */

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { command: "__ping" });
  } catch {
    // Content script not loaded — inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Small delay for script to initialize
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ── Send response back to dev-agent ───────────────────────────────────── */

function sendResponse(id, command, success, payload, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { id, type: "response", command, success, payload: payload || {} };
  if (error) msg.error = error;
  ws.send(JSON.stringify(msg));
}

/* ── Command router ────────────────────────────────────────────────────── */

async function handleCommand(msg) {
  const { id, command, payload } = msg;

  try {
    switch (command) {
      case "get_page_text": {
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        await ensureContentScript(tab.id);

        // Get page data from content script
        const pageData = await chrome.tabs.sendMessage(tab.id, { command: "extract_page" });

        // Get tab list
        const allTabs = await chrome.tabs.query({});
        const tabList = allTabs
          .filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
          .map((t) => `${t.title} | ${t.url}`)
          .join("\n");

        sendResponse(id, command, true, {
          url: pageData?.payload?.url || tab.url,
          title: pageData?.payload?.title || tab.title,
          text: pageData?.payload?.text || "",
          meta: pageData?.payload?.meta || {},
          tabs: tabList,
        });
        break;
      }

      case "navigate": {
        if (payload.new_window) {
          const createOpts = { url: payload.url, focused: true };
          if (payload.bounds) {
            createOpts.left = payload.bounds.x;
            createOpts.top = payload.bounds.y;
            createOpts.width = payload.bounds.width || 1280;
            createOpts.height = payload.bounds.height || 900;
          }
          const win = await chrome.windows.create(createOpts);
          const tab = win.tabs[0];
          sendResponse(id, command, true, { url: payload.url, tab_id: tab.id, window_id: win.id });
        } else {
          // Navigate in existing tab
          const tab = await findTargetTab(payload.url_hint);
          if (tab && tab.id) {
            await chrome.tabs.update(tab.id, { url: payload.url, active: true });
            // Focus the window
            await chrome.windows.update(tab.windowId, { focused: true });
            sendResponse(id, command, true, { url: payload.url, tab_id: tab.id });
          } else {
            // No existing tab — create new
            const newTab = await chrome.tabs.create({ url: payload.url, active: true });
            sendResponse(id, command, true, { url: payload.url, tab_id: newTab.id });
          }
        }
        break;
      }

      case "set_url": {
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        await chrome.tabs.update(tab.id, { url: payload.url, active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse(id, command, true, { url: payload.url, tab_id: tab.id });
        break;
      }

      case "click_element": {
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        await ensureContentScript(tab.id);
        const clickResult = await chrome.tabs.sendMessage(tab.id, {
          command: "click_element",
          selector: payload.selector,
          text_match: payload.text_match,
          index: payload.index,
        });
        sendResponse(id, command, clickResult?.success ?? false, clickResult?.payload, clickResult?.error);
        break;
      }

      case "get_element_bounds": {
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        await ensureContentScript(tab.id);
        const boundsResult = await chrome.tabs.sendMessage(tab.id, {
          command: "get_element_bounds",
          selector: payload.selector,
          text_match: payload.text_match,
          index: payload.index,
        });
        sendResponse(id, command, boundsResult?.success ?? false, boundsResult?.payload, boundsResult?.error);
        break;
      }

      case "ping": {
        sendResponse(id, command, true, {});
        break;
      }

      default:
        sendResponse(id, command, false, null, `Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(`[OasisBridge] Command ${command} failed:`, err);
    sendResponse(id, command, false, null, err.message);
  }
}

/* ── Startup ───────────────────────────────────────────────────────────── */

connect();
console.log("[OasisBridge] Service worker started");
