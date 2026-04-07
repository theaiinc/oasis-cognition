/**
 * Oasis Chrome Bridge — Content Script
 *
 * Runs on every page. Listens for messages from the background service worker
 * and performs DOM extraction / element interaction.
 */

(() => {
  "use strict";

  /* ── extract_page: full page text + metadata ──────────────────────────── */

  function extractPage() {
    const meta = {};
    for (const el of document.querySelectorAll("meta[name], meta[property]")) {
      const key = el.getAttribute("name") || el.getAttribute("property");
      const val = el.getAttribute("content");
      if (key && val) meta[key] = val;
    }

    // GitHub-specific: data-login attribute on the user menu
    const loginEl = document.querySelector("[data-login]");
    if (loginEl) {
      meta["data-login"] = loginEl.getAttribute("data-login");
    }

    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").substring(0, 12000),
      meta,
    };
  }

  /* ── find_element: locate element by CSS selector or text match ──────── */

  function findElement(selector, textMatch, index) {
    // Try CSS selector first
    if (selector) {
      const els = document.querySelectorAll(selector);
      const idx = index || 0;
      return els[idx] || null;
    }

    // Text content walk
    if (textMatch) {
      const lowerMatch = textMatch.toLowerCase();
      const walk = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            const tag = node.tagName;
            if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            const text = (node.textContent || "").trim().toLowerCase();
            if (text === lowerMatch || text.startsWith(lowerMatch)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            // Check aria-label
            const label = (node.getAttribute("aria-label") || "").toLowerCase();
            if (label === lowerMatch || label.startsWith(lowerMatch)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          },
        }
      );

      const matches = [];
      let node;
      while ((node = walk.nextNode())) {
        matches.push(node);
      }

      // Prefer the most specific (deepest) match
      if (matches.length > 0) {
        const idx = index || 0;
        // Sort by depth (most children = most specific) then take idx
        matches.sort(
          (a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length
        );
        return matches[Math.min(idx, matches.length - 1)];
      }
    }

    return null;
  }

  /* ── get_element_bounds: absolute screen coordinates ─────────────────── */

  function getElementBounds(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.screenX),
      y: Math.round(rect.top + window.screenY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.left + rect.width / 2 + window.screenX),
      centerY: Math.round(rect.top + rect.height / 2 + window.screenY),
      visible: rect.width > 0 && rect.height > 0,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().substring(0, 200),
    };
  }

  /* ── Message handler ─────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.command) {
        case "extract_page": {
          sendResponse({ success: true, payload: extractPage() });
          break;
        }

        case "click_element": {
          const el = findElement(msg.selector, msg.text_match, msg.index);
          if (!el) {
            sendResponse({
              success: false,
              error: `Element not found: ${msg.selector || msg.text_match}`,
            });
            break;
          }
          const bounds = getElementBounds(el);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          sendResponse({ success: true, payload: { clicked: true, bounds } });
          break;
        }

        case "get_element_bounds": {
          const el2 = findElement(msg.selector, msg.text_match, msg.index);
          if (!el2) {
            sendResponse({
              success: false,
              error: `Element not found: ${msg.selector || msg.text_match}`,
            });
            break;
          }
          sendResponse({
            success: true,
            payload: getElementBounds(el2),
          });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown command: ${msg.command}` });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }

    // Return true to indicate we'll respond asynchronously (even though we
    // respond synchronously above, this keeps the channel open in case of
    // future async commands).
    return true;
  });
})();
