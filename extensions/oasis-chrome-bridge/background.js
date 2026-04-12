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

  // 1. Prefer the active tab in the last focused window if it matches the hint
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (urlHint) {
    const hint = urlHint.toLowerCase();

    // Check active tab first
    if (activeTab?.url?.toLowerCase().includes(hint)) {
      return activeTab;
    }

    // Then check all tabs, preferring active ones
    const matches = allTabs.filter(t => t.url && t.url.toLowerCase().includes(hint));
    // Prefer active tabs over inactive ones
    const activeMatch = matches.find(t => t.active);
    if (activeMatch) return activeMatch;
    if (matches.length > 0) return matches[0];
  }

  // 2. Active tab if it's a real page (not localhost/chrome)
  if (activeTab?.url) {
    const url = activeTab.url.toLowerCase();
    if (!url.includes("localhost") && !url.includes("127.0.0.1") &&
        !url.startsWith("chrome://") && !url.startsWith("chrome-extension://")) {
      return activeTab;
    }
  }

  // 3. First non-localhost, non-extension tab
  for (const tab of allTabs) {
    const url = (tab.url || "").toLowerCase();
    if (url && !url.includes("localhost") && !url.includes("127.0.0.1") &&
        !url.startsWith("chrome://") && !url.startsWith("chrome-extension://")) {
      return tab;
    }
  }

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

/* ── CDP (Chrome DevTools Protocol) helpers for trusted events ──────────── */

// Track attached debugger sessions to avoid re-attaching
const attachedTabs = new Set();

async function cdpAttach(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  } catch (e) {
    // Already attached or permission denied
    if (e.message?.includes("Already attached")) {
      attachedTabs.add(tabId);
    } else {
      throw e;
    }
  }
}

function cdpSend(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function cdpDetach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch { /* ignore */ }
  attachedTabs.delete(tabId);
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

/**
 * Click an element via CDP trusted mouse events.
 * First finds the element bounds via content script, then dispatches
 * trusted mousePressed/mouseReleased via CDP.
 */
async function cdpClickElement(tabId, textMatch, selector, index) {
  // 1. Find element bounds via content script
  await ensureContentScript(tabId);
  const boundsResult = await chrome.tabs.sendMessage(tabId, {
    command: "get_element_bounds",
    text_match: textMatch,
    selector,
    index,
  });

  if (!boundsResult?.success || !boundsResult?.payload) {
    return { success: false, error: boundsResult?.error || "Element not found" };
  }

  const bounds = boundsResult.payload;
  if (!bounds.visible) {
    // Scroll element into view first
    await chrome.tabs.sendMessage(tabId, {
      command: "scroll_to_element",
      text_match: textMatch,
      selector,
      index,
    });
    await new Promise(r => setTimeout(r, 300));
  }

  // 2. Get fresh bounds after potential scroll
  const freshBounds = await chrome.tabs.sendMessage(tabId, {
    command: "get_element_bounds",
    text_match: textMatch,
    selector,
    index,
  });
  const b = freshBounds?.payload || bounds;

  // Viewport-relative coords for CDP (from content script)
  const vpX = b.vpX || (b.centerX - b.x + (b.width / 2));
  const vpY = b.vpY || (b.centerY - b.y + (b.height / 2));

  // 3. Attach debugger and dispatch trusted click
  try {
    await cdpAttach(tabId);

    // Mouse move first (some sites need hover)
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: vpX, y: vpY, button: "none",
    });
    await new Promise(r => setTimeout(r, 50));

    // Click
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: vpX, y: vpY, button: "left", clickCount: 1,
    });
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: vpX, y: vpY, button: "left", clickCount: 1,
    });

    return { success: true, bounds: b };
  } catch (e) {
    // CDP failed — fall back to content script .click()
    console.warn("[OasisBridge] CDP click failed, falling back to DOM click:", e.message);
    const clickResult = await chrome.tabs.sendMessage(tabId, {
      command: "click_element",
      text_match: textMatch,
      selector,
      index,
    });
    if (clickResult?.success) {
      const href = clickResult?.payload?.href || null;
      return { success: true, bounds: b, method: "dom_fallback", href };
    }
    return { success: false, error: clickResult?.error || "Click failed" };
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
        if (payload.new_tab) {
          // Create a new tab in the current window (keeps all CU tabs together)
          const newTab = await chrome.tabs.create({ url: payload.url, active: true });
          if (newTab.windowId) {
            await chrome.windows.update(newTab.windowId, { focused: true });
          }
          sendResponse(id, command, true, { url: payload.url, tab_id: newTab.id, new_tab: true });
        } else {
          const tab = await findTargetTab(payload.url_hint);
          if (!tab || !tab.id) {
            // No matching tab — create new instead of failing
            const newTab = await chrome.tabs.create({ url: payload.url, active: true });
            sendResponse(id, command, true, { url: payload.url, tab_id: newTab.id, new_tab: true });
            return;
          }
          await chrome.tabs.update(tab.id, { url: payload.url, active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          sendResponse(id, command, true, { url: payload.url, tab_id: tab.id });
        }
        break;
      }

      case "switch_tab": {
        // Activate an existing tab by matching title or URL substring
        const query = (payload.query || payload.text || "").toLowerCase();
        if (!query) {
          sendResponse(id, command, false, null, "switch_tab requires query (tab title or URL fragment)");
          return;
        }
        const allTabs = await chrome.tabs.query({});
        const match = allTabs.find(t => {
          const title = (t.title || "").toLowerCase();
          const url = (t.url || "").toLowerCase();
          return title.includes(query) || url.includes(query);
        });
        if (match && match.id) {
          await chrome.tabs.update(match.id, { active: true });
          await chrome.windows.update(match.windowId, { focused: true });
          sendResponse(id, command, true, {
            tab_id: match.id,
            title: match.title,
            url: match.url,
          });
        } else {
          sendResponse(id, command, false, null, `No tab matching "${query}"`);
        }
        break;
      }

      case "click_element": {
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        // Use CDP trusted events (falls back to DOM .click() if CDP fails)
        const clickResult = await cdpClickElement(
          tab.id,
          payload.text_match,
          payload.selector,
          payload.index,
        );
        sendResponse(id, command, clickResult.success, clickResult, clickResult.error);
        break;
      }

      case "type_text": {
        // Type text into the currently focused element using execCommand('insertText').
        // Works with contenteditable divs (Facebook, Twitter, etc.) and regular inputs.
        const tab = await findTargetTab(payload.url_hint);
        if (!tab || !tab.id) {
          sendResponse(id, command, false, null, "No suitable tab found");
          return;
        }
        await ensureContentScript(tab.id);
        const typeResult = await chrome.tabs.sendMessage(tab.id, {
          command: "type_text",
          text: payload.text,
          selector: payload.selector, // optional: focus this element first
        });
        sendResponse(id, command, typeResult?.success ?? false, typeResult?.payload, typeResult?.error);
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
