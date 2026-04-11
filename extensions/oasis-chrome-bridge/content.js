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

    // Build a structured snapshot of interactive elements (like an accessibility tree)
    const interactiveEls = [];
    const selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [onclick], [data-testid], [tabindex="0"]';
    const seen = new Set();
    for (const el of document.querySelectorAll(selectors)) {
      if (interactiveEls.length >= 100) break;
      const rect = el.getBoundingClientRect();
      // Skip invisible/off-screen elements
      if (rect.width === 0 || rect.height === 0 || rect.top > window.innerHeight + 200 || rect.bottom < -200) continue;
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.getAttribute("data-tooltip") ||
        el.textContent?.trim().substring(0, 80) ||
        "";
      if (!label || label.length < 2) continue;
      // Deduplicate by label but keep different tags/roles
      const key = label.substring(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      interactiveEls.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        label,
        href: el.getAttribute("href") || "",
        type: el.getAttribute("type") || "",
      });
    }

    return {
      url: location.href,
      title: document.title,
      text: (() => {
        let text = document.body ? document.body.innerText : "";
        // Also capture dialog/modal content that might be in portals
        for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, [data-testid*="dialog"]')) {
          const dialogText = (el.innerText || "").trim();
          if (dialogText && !text.includes(dialogText.substring(0, 50))) {
            text = `[DIALOG] ${dialogText}\n\n${text}`;
          }
        }
        return text;
      })().substring(0, 8000),
      meta,
      interactive: interactiveEls,
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

    // Text content walk — finds clickable elements matching the text
    if (textMatch) {
      const lowerMatch = textMatch.toLowerCase().trim();

      // Strategy 1: search interactive elements by aria-label, text, title (most precise)
      const interactiveSelectors = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex="0"], [onclick]';
      const candidates = [];
      for (const el of document.querySelectorAll(interactiveSelectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        const text = (el.textContent || "").trim().toLowerCase();

        // Exact match (highest priority)
        if (label === lowerMatch || title === lowerMatch || text === lowerMatch) {
          candidates.unshift(el);
          continue;
        }
        // Contains match
        if (label.includes(lowerMatch) || title.includes(lowerMatch) || text.includes(lowerMatch)) {
          candidates.push(el);
        }
      }
      if (candidates.length > 0) {
        const idx = index || 0;
        return candidates[Math.min(idx, candidates.length - 1)];
      }

      // Strategy 2: tree walker fallback for non-interactive elements
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
            if (text === lowerMatch || text.includes(lowerMatch)) {
              return NodeFilter.FILTER_ACCEPT;
            }
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
      // Screen-absolute coordinates
      x: Math.round(rect.left + window.screenX),
      y: Math.round(rect.top + window.screenY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.left + rect.width / 2 + window.screenX),
      centerY: Math.round(rect.top + rect.height / 2 + window.screenY),
      // Viewport-relative coordinates (for CDP Input.dispatchMouseEvent)
      vpX: Math.round(rect.left + rect.width / 2),
      vpY: Math.round(rect.top + rect.height / 2),
      visible: rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0,
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

        case "scroll_to_element": {
          const el3 = findElement(msg.selector, msg.text_match, msg.index);
          if (el3) {
            el3.scrollIntoView({ block: "center", behavior: "instant" });
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: "Element not found" });
          }
          break;
        }

        case "type_text": {
          // Type text into the focused element or a specified element.
          // Uses execCommand('insertText') which works with contenteditable divs
          // (Facebook, Twitter post composers, etc.) and regular inputs/textareas.
          const text = msg.text || '';
          let target = document.activeElement;

          // If a selector/text_match is provided, find and focus that element first
          if (msg.selector || msg.text_match) {
            const found = findElement(msg.selector, msg.text_match);
            if (found) {
              found.scrollIntoView({ block: "center", behavior: "instant" });
              found.focus();
              found.click();
              target = found;
            }
          }

          // For contenteditable elements (like Facebook's post composer)
          if (target && (target.isContentEditable || target.contentEditable === 'true')) {
            target.focus();
            const sel = window.getSelection();
            const range = document.createRange();

            // Select ALL existing content first — this replaces instead of appending
            // Prevents duplication when the type action retries
            range.selectNodeContents(target);
            sel.removeAllRanges();
            sel.addRange(range);

            // Delete existing content, then insert new text
            document.execCommand('delete', false);
            document.execCommand('insertText', false, text);
            sendResponse({ success: true, payload: { typed: text.length, method: 'execCommand-replace' } });
          } else if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            // Regular input/textarea
            target.focus();
            target.value = text;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            sendResponse({ success: true, payload: { typed: text.length, method: 'value' } });
          } else {
            // Fallback: try execCommand on whatever is focused
            document.execCommand('insertText', false, text);
            sendResponse({ success: true, payload: { typed: text.length, method: 'fallback' } });
          }
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
