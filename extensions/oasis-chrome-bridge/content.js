/**
 * Oasis Chrome Bridge — Content Script
 *
 * Runs on every page. Listens for messages from the background service worker
 * and performs DOM extraction / element interaction.
 */

(() => {
  "use strict";

  /* ── Shadow DOM deep traversal helpers ─────────────────────────────────
   * Many modern web apps (NotebookLM, YouTube, Google Docs, etc.) use
   * Shadow DOM. Standard querySelectorAll doesn't penetrate shadow roots.
   * These helpers recursively traverse into open shadow roots.
   */

  function querySelectorAllDeep(selector, root = document) {
    const results = [...root.querySelectorAll(selector)];
    // Traverse shadow roots
    const allElements = root.querySelectorAll("*");
    for (const el of allElements) {
      if (el.shadowRoot) {
        results.push(...querySelectorAllDeep(selector, el.shadowRoot));
      }
    }
    return results;
  }

  function getDeepBodyText(root = document.body) {
    let text = root.innerText || "";
    const allElements = root.querySelectorAll("*");
    for (const el of allElements) {
      if (el.shadowRoot) {
        const shadowText = (el.shadowRoot.textContent || "").trim();
        if (shadowText && !text.includes(shadowText.substring(0, 50))) {
          text += "\n" + shadowText;
        }
      }
    }
    return text;
  }

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
    for (const el of querySelectorAllDeep(selectors)) {
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
        let text = document.body ? getDeepBodyText(document.body) : "";
        // Also capture dialog/modal content that might be in portals
        for (const el of querySelectorAllDeep('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, [data-testid*="dialog"]')) {
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
      // Normalize smart quotes, em dashes, and other Unicode variants to ASCII
      // so "What's" matches "What\u2019s" (right single quote used by Facebook etc.)
      const normalize = (s) => s.toLowerCase().trim()
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // smart single quotes → '
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')  // smart double quotes → "
        .replace(/[\u2013\u2014]/g, '-')               // em/en dash → -
        .replace(/\u2026/g, '...');                     // ellipsis → ...
      const lowerMatch = normalize(textMatch);

      // Strategy 1: search interactive elements by aria-label, text, title (most precise)
      // Uses deep traversal to also find elements inside Shadow DOM (NotebookLM, Google apps, etc.)
      const interactiveSelectors = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex="0"], [onclick]';
      const candidates = [];
      for (const el of querySelectorAllDeep(interactiveSelectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const label = normalize(el.getAttribute("aria-label") || "");
        const title = normalize(el.getAttribute("title") || "");
        const text = normalize(el.textContent || "");

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
        // Prefer <a> links over containers (so clicks navigate correctly)
        const links = candidates.filter(c => c.tagName === "A");
        const pool = links.length > 0 ? links : candidates;
        const idx = index || 0;
        return pool[Math.min(idx, pool.length - 1)];
      }

      // Strategy 2: deep walk fallback for non-interactive elements
      // Recursively searches both light DOM and Shadow DOM roots
      const matches = [];
      function deepWalk(root) {
        const allEls = root.querySelectorAll("*");
        for (const node of allEls) {
          const tag = node.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(tag)) continue;
          const text = normalize(node.textContent || "");
          const label = normalize(node.getAttribute?.("aria-label") || "");
          if (text === lowerMatch || text.includes(lowerMatch) || label === lowerMatch || label.startsWith(lowerMatch)) {
            matches.push(node);
          }
          if (node.shadowRoot) {
            deepWalk(node.shadowRoot);
          }
        }
      }
      deepWalk(document.body);

      // Prefer the most specific (deepest) match
      if (matches.length > 0) {
        const idx = index || 0;
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
      pageUrl: window.location.href,
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

          // Dispatch a full mouse event sequence so client-side routers
          // (GitHub Turbo, Next.js, etc.) recognise the interaction as a
          // real user click rather than a synthetic `.click()`.
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const eventOpts = {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, button: 0, buttons: 1,
          };
          el.dispatchEvent(new PointerEvent("pointerdown", { ...eventOpts, pointerId: 1 }));
          el.dispatchEvent(new MouseEvent("mousedown", eventOpts));
          el.dispatchEvent(new PointerEvent("pointerup", { ...eventOpts, pointerId: 1, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("mouseup", { ...eventOpts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("click", { ...eventOpts, buttons: 0 }));

          // Post-click: if the click likely opened a modal/dialog and the
          // target isn't itself an editable, find and focus the editor inside
          // the modal so the next `type` lands in the right place.
          // Facebook, Twitter, Slack etc. all use this pattern: the click
          // target is a placeholder button, and a contenteditable opens inside
          // a [role="dialog"] or [aria-modal="true"] container.
          try {
            const clickedIsEditor =
              el.isContentEditable ||
              el.contentEditable === "true" ||
              el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA";
            if (!clickedIsEditor) {
              // Give the modal a moment to mount/focus naturally before we intervene.
              setTimeout(() => {
                try {
                  const active = document.activeElement;
                  const activeIsEditor =
                    active &&
                    (active.isContentEditable ||
                     active.contentEditable === "true" ||
                     active.tagName === "INPUT" ||
                     active.tagName === "TEXTAREA");
                  if (activeIsEditor) return; // Site already focused its editor.

                  // Prefer editors inside the freshly-opened dialog/modal.
                  const dialogs = document.querySelectorAll(
                    '[role="dialog"], [aria-modal="true"], [role="alertdialog"]',
                  );
                  const candidates = [];
                  for (const d of dialogs) {
                    // Must be visible
                    const r = d.getBoundingClientRect();
                    if (r.width < 10 || r.height < 10) continue;
                    // Find editable descendants
                    const editors = d.querySelectorAll(
                      '[contenteditable="true"], [contenteditable=""], input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea',
                    );
                    for (const ed of editors) {
                      const er = ed.getBoundingClientRect();
                      if (er.width < 10 || er.height < 10) continue;
                      if (ed.disabled || ed.readOnly) continue;
                      candidates.push(ed);
                    }
                  }
                  if (candidates.length > 0) {
                    // Pick the largest by area (the main composer, not a search box)
                    candidates.sort((a, b) => {
                      const ra = a.getBoundingClientRect();
                      const rb = b.getBoundingClientRect();
                      return rb.width * rb.height - ra.width * ra.height;
                    });
                    const target = candidates[0];
                    target.focus();
                    // Place cursor at end for contenteditable so typing appends
                    if (target.isContentEditable) {
                      const sel = window.getSelection();
                      const range = document.createRange();
                      range.selectNodeContents(target);
                      range.collapse(false);
                      sel.removeAllRanges();
                      sel.addRange(range);
                    }
                  }
                } catch (_) { /* best effort */ }
              }, 120);
            }
          } catch (_) { /* best effort */ }

          // Include href in response so caller can navigate directly if
          // client-side routing (Turbo, etc.) blocks synthetic clicks.
          const linkEl = el.closest("a[href]") || el.querySelector("a[href]");
          const href = linkEl && linkEl.href && !linkEl.href.startsWith("javascript:")
            ? linkEl.href : null;

          sendResponse({ success: true, payload: { clicked: true, bounds, href } });
          break;
        }

        case "click_scoped":
        case "find_scoped": {
          // Anchor-and-traverse element locator. Solves the "many posts share
          // the same aria-label" problem (e.g. every FB post on a profile has
          // its own three-dot button named "Actions for this post"). Rather
          // than clicking the first DOM match, we:
          //   1. Find the anchor text in the DOM (typically a unique post-prefix
          //      substring supplied by the caller).
          //   2. Walk UP to each ancestor of the anchor (up to max_ancestors).
          //   3. For each ancestor, look DOWN for the first descendant that
          //      matches the target (by aria-label or text). The first
          //      ancestor that contains BOTH the anchor AND the target wins —
          //      that is, by construction, the correct post's target.
          //   4. If command is click_scoped: dispatch a DOM click directly
          //      (fallback path for when CDP is unavailable; less reliable
          //      on React apps than CDP but works on simple pages).
          //      If command is find_scoped: return bounds only so the caller
          //      (background.js) can use CDP for a trusted click.
          //
          // Request payload: {
          //   anchor_text:       string,   // substring to locate the container
          //   target_aria_label: string?,  // preferred target matcher
          //   target_text:       string?,  // fallback target matcher (inner text)
          //   max_ancestors:     number?,  // default 15
          // }
          const anchorRaw = msg.anchor_text || "";
          const targetAria = msg.target_aria_label || "";
          const targetText = msg.target_text || "";
          const maxAncestors = Math.max(1, Math.min(40, msg.max_ancestors || 15));

          if (!anchorRaw) {
            sendResponse({ success: false, error: "click_scoped: anchor_text required" });
            break;
          }
          if (!targetAria && !targetText) {
            sendResponse({
              success: false,
              error: "click_scoped: target_aria_label or target_text required",
            });
            break;
          }

          const normalize = (s) =>
            (s || "").toLowerCase().trim()
              .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
              .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
              .replace(/[\u2013\u2014]/g, "-")
              .replace(/\u2026/g, "...");
          const anchorLower = normalize(anchorRaw);
          const targetAriaLower = normalize(targetAria);
          const targetTextLower = normalize(targetText);

          // Step 1: collect parent elements of text nodes containing the anchor.
          const anchorEls = [];
          const seen = new Set();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let tnode;
          while ((tnode = walker.nextNode())) {
            if (!tnode.textContent) continue;
            const txt = normalize(tnode.textContent);
            if (!txt.includes(anchorLower)) continue;
            const parent = tnode.parentElement;
            if (parent && !seen.has(parent)) {
              seen.add(parent);
              anchorEls.push(parent);
              if (anchorEls.length >= 10) break;
            }
          }
          if (anchorEls.length === 0) {
            sendResponse({
              success: false,
              error: `click_scoped: anchor text "${anchorRaw.slice(0, 60)}" not found in DOM`,
            });
            break;
          }

          // Helper — search an ancestor's subtree for a target element.
          function findTargetInSubtree(ancestor) {
            // Prefer aria-label match (most precise for accessibility-tagged controls).
            if (targetAriaLower) {
              const byLabel = ancestor.querySelectorAll("[aria-label]");
              for (const el of byLabel) {
                const lbl = normalize(el.getAttribute("aria-label") || "");
                if (lbl === targetAriaLower || lbl.includes(targetAriaLower)) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) return el;
                }
              }
            }
            // Fallback — textContent match on plausible interactive elements.
            if (targetTextLower) {
              const interactive = ancestor.querySelectorAll(
                'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"]'
              );
              for (const el of interactive) {
                const t = normalize(el.textContent || "");
                if (t === targetTextLower || t.startsWith(targetTextLower)) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) return el;
                }
              }
            }
            return null;
          }

          // Step 2+3: for each anchor, walk up and probe each ancestor's subtree.
          let target = null;
          let chosenAncestorDepth = -1;
          let chosenAnchor = null;
          for (const anchorEl of anchorEls) {
            let ancestor = anchorEl;
            for (let depth = 0; depth < maxAncestors && ancestor; depth++) {
              const candidate = findTargetInSubtree(ancestor);
              if (candidate) {
                // Prefer the CLOSEST ancestor match (smallest depth) across all
                // anchor candidates — that's the tightest scope to the post.
                if (target === null || depth < chosenAncestorDepth) {
                  target = candidate;
                  chosenAncestorDepth = depth;
                  chosenAnchor = anchorEl;
                }
                break; // stop walking THIS anchor's ancestors; move to next
              }
              ancestor = ancestor.parentElement;
            }
          }

          if (!target) {
            sendResponse({
              success: false,
              error:
                `click_scoped: anchor matched (${anchorEls.length} candidates) but no ancestor ` +
                `within ${maxAncestors} levels contained "${targetAria || targetText}"`,
            });
            break;
          }

          // Scroll into view and compute bounds.
          target.scrollIntoView({ block: "center", behavior: "instant" });
          const boundsOut = getElementBounds(target);

          const basePayload = {
            method: "anchor_walk",
            anchor_candidates: anchorEls.length,
            ancestor_depth: chosenAncestorDepth,
            target_aria_label: target.getAttribute("aria-label") || "",
            target_text: (target.textContent || "").slice(0, 80).trim(),
            bounds: boundsOut,
          };

          if (msg.command === "find_scoped") {
            // Just locate — background.js will CDP-click at these coords.
            sendResponse({ success: true, payload: basePayload });
            break;
          }

          // click_scoped: dispatch DOM click directly as a fallback path.
          const r = target.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const eventOpts = {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, button: 0, buttons: 1,
          };
          target.dispatchEvent(new PointerEvent("pointerdown", { ...eventOpts, pointerId: 1 }));
          target.dispatchEvent(new MouseEvent("mousedown", eventOpts));
          target.dispatchEvent(new PointerEvent("pointerup", { ...eventOpts, pointerId: 1, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("mouseup", { ...eventOpts, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("click", { ...eventOpts, buttons: 0 }));

          sendResponse({ success: true, payload: { ...basePayload, clicked: true } });
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

          // If the current target isn't an editable, scan for a visible
          // contenteditable inside an open dialog/modal (Facebook composer,
          // Twitter compose, Slack message box, etc.). This fixes the case
          // where a previous click opened a modal but didn't focus the
          // nested editor — common for React portals.
          const isEditor = (e) =>
            e && (
              e.isContentEditable ||
              e.contentEditable === "true" ||
              e.tagName === "INPUT" ||
              e.tagName === "TEXTAREA"
            );
          if (!isEditor(target)) {
            try {
              const dialogs = document.querySelectorAll(
                '[role="dialog"], [aria-modal="true"], [role="alertdialog"]',
              );
              const candidates = [];
              for (const d of dialogs) {
                const r = d.getBoundingClientRect();
                if (r.width < 10 || r.height < 10) continue;
                const editors = d.querySelectorAll(
                  '[contenteditable="true"], [contenteditable=""], input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea',
                );
                for (const ed of editors) {
                  const er = ed.getBoundingClientRect();
                  if (er.width < 10 || er.height < 10) continue;
                  if (ed.disabled || ed.readOnly) continue;
                  candidates.push(ed);
                }
              }
              // Fallback: any visible contenteditable on the page (e.g. inline
              // composers that aren't in a dialog role).
              if (candidates.length === 0) {
                const loose = document.querySelectorAll(
                  '[contenteditable="true"], [contenteditable=""]',
                );
                for (const ed of loose) {
                  const er = ed.getBoundingClientRect();
                  if (er.width < 100 || er.height < 30) continue;
                  candidates.push(ed);
                }
              }
              if (candidates.length > 0) {
                candidates.sort((a, b) => {
                  const ra = a.getBoundingClientRect();
                  const rb = b.getBoundingClientRect();
                  return rb.width * rb.height - ra.width * ra.height;
                });
                target = candidates[0];
                target.focus();
              }
            } catch (_) { /* continue with whatever we had */ }
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
