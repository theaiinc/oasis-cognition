"""Autonomous goal execution for the CU agent.

Implements a simple screenshot → LLM → action → repeat loop that takes a
plain English goal and automatically executes it using the dev-agent's
computer actions.  No session management, no approval flow — just direct
one-action-at-a-time decisions grounded in the live screen.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any

import httpx

from services.dev_agent.computer_use import execute_computer_action, _list_screens

logger = logging.getLogger(__name__)

RESPONSE_URL = os.getenv("RESPONSE_URL", "http://localhost:8005")

# ── System prompt ────────────────────────────────────────────────────────────

AUTO_GOAL_SYSTEM = """\
You are an autonomous macOS computer-use agent. You look at a screenshot,
decide the SINGLE best next action, and output it in the exact format below.

## Available actions

open_application  | {"text": "<exact app name, e.g. Docker Desktop, Google Chrome, Notes>"}
focus_window      | {"text": "<app name>"}
click_ui_element  | {"text": "<element label or description>"}
type_text         | {"text": "<string to type>"}
key_press         | {"key": "<enter|tab|escape|delete|up|down|left|right|space>"}
hotkey            | {"keys": ["command", "n"]}
scroll            | {"direction": "up", "amount": 3}

## Rules

- Use EXACT app names: "Docker Desktop" not "Docker", "Google Chrome" not "Chrome".
- Use focus_window before clicking if the app is already running.
- If click_ui_element fails, try a shorter or different description of the element.
- NEVER repeat the same failing action. Try a different approach.
- You MUST execute ALL actions needed. Opening an app is just the first step.
- CRITICAL: Before saying DONE, check your action History. You can ONLY claim
  DONE if you see the required actions in your history:
  * "create a note" → history must show type_text for title AND body
  * "navigate to X tab" → history must show click_ui_element for that tab
  * "run command X" → history must show type_text for the command AND key_press enter
- If the required actions are NOT in your history, you have NOT done them yet.
  Do not be fooled by pre-existing content on screen.
- After completing all required actions, output DONE on the NEXT step.

## Output format (MANDATORY — follow EXACTLY)

THOUGHT: <1 sentence>
ACTION: <action_name> | <json params>

After all required actions are in your history:

THOUGHT: <confirm which actions in history prove the goal is done>
DONE: <summary>
"""


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_primary_region() -> tuple[int, int, int, int] | None:
    """Return (x, y, w, h) for the primary screen, or None."""
    try:
        info = await _list_screens()
        screens = info.get("screens", [])
        if screens:
            s = screens[0]
            return (s["x"], s["y"], s["width"], s["height"])
    except Exception:
        pass
    return None


async def _take_primary_screenshot() -> str:
    """Capture only the primary screen and return base64 JPEG."""
    region = await _get_primary_region()
    kwargs: dict[str, Any] = {}
    if region:
        kwargs["screen_region"] = {
            "x": region[0], "y": region[1],
            "width": region[2], "height": region[3],
        }
    result = await execute_computer_action(
        action="screenshot", x=None, y=None, **kwargs,
    )
    return result.get("screenshot", "")


async def _call_llm(system: str, user_message: str, screenshot_b64: str) -> str:
    """Call the response-generator chat endpoint with an optional screenshot."""
    payload: dict[str, Any] = {
        "user_message": user_message,
        "context": {
            "system_override": system,
            "max_tokens": 500,
        },
    }
    if screenshot_b64:
        payload["context"]["screen_image"] = screenshot_b64

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{RESPONSE_URL}/internal/response/chat",
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
    return (data.get("response_text") or data.get("response") or "").strip()


# ── Response parsing ─────────────────────────────────────────────────────────

_ACTION_RE = re.compile(
    r"ACTION:\s*(\w+)\s*\|\s*(.+?)(?:\n|$)", re.MULTILINE,
)
_DONE_RE = re.compile(r"DONE:\s*(.+?)(?:\n|$)", re.MULTILINE)
_FALLBACK_RE = re.compile(
    r"(?:action|next)\s*:\s*(\w+)\s*[|\-:]\s*(.+?)(?:\n|$)", re.IGNORECASE | re.MULTILINE,
)


def _parse_response(text: str) -> tuple[str, dict[str, Any] | str]:
    """Parse LLM response → ("action_name", {params}) or ("DONE", "summary")."""
    # Check DONE first
    done = _DONE_RE.search(text)
    if done:
        return ("DONE", done.group(1).strip())

    # Try strict ACTION format, then fallback
    act = _ACTION_RE.search(text) or _FALLBACK_RE.search(text)
    if act:
        action_name = act.group(1).strip()
        params_raw = act.group(2).strip()

        # Parse JSON params — try full string, then extract embedded JSON
        params = _parse_params(params_raw)

        # Fix common LLM mistakes: key_press with key in wrong field
        if action_name == "key_press" and "key" not in params and "text" in params:
            params["key"] = params.pop("text")

        return (action_name, params)

    # Last resort: look for any action-like pattern in the text
    for action in ("open_application", "focus_window", "click_ui_element",
                   "type_text", "key_press", "hotkey", "scroll"):
        pattern = re.search(
            rf'\b{action}\b.*?(\{{[^}}]+\}})', text, re.IGNORECASE | re.DOTALL,
        )
        if pattern:
            params = _parse_params(pattern.group(1))
            if action == "key_press" and "key" not in params and "text" in params:
                params["key"] = params.pop("text")
            return (action, params)

    return ("UNKNOWN", {"raw": text[:300]})


def _parse_params(raw: str) -> dict[str, Any]:
    """Parse a params string into a dict, handling various formats."""
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Extract embedded JSON
    json_match = re.search(r'\{[^}]+\}', raw)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass

    # Plain string — treat as text param
    # Strip quotes
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        raw = raw[1:-1]
    return {"text": raw}


# ── Window management ────────────────────────────────────────────────────────

async def _ensure_window_on_primary(app_name: str) -> None:
    """If the app's window is on a secondary monitor, move it to primary."""
    try:
        await asyncio.sleep(0.5)
        bounds_res = await execute_computer_action(
            action="get_window_bounds", text=app_name, x=None, y=None,
        )
        bounds = bounds_res.get("bounds", {})
        primary = await _get_primary_region()
        if not primary:
            return

        win_x = bounds.get("x", 0)
        primary_width = primary[2]

        if win_x >= primary_width or win_x < primary[0]:
            logger.info("auto_goal: moving %s from (%d,%d) to primary screen",
                        app_name, win_x, bounds.get("y", 0))
            await execute_computer_action(
                action="move_window_to_screen", text=app_name,
                x=primary[0], y=primary[1] + 25,
            )
            await asyncio.sleep(0.5)
    except Exception as e:
        logger.debug("auto_goal: window check failed for %s: %s", app_name, e)


# ── Zoomed sidebar click fallback ─────────────────────────────────────────────

UI_PARSER_URL = os.getenv("UI_PARSER_URL", "http://localhost:8011")


async def _zoomed_sidebar_click(element_text: str, app_name: str) -> str | None:
    """Fallback for clicking sidebar items: capture a zoomed left-edge region,
    send to ui-parser to find the element, and click at the returned coordinates.

    Returns output string on success, None on failure.
    """
    try:
        # 1. Get the app's window bounds
        bounds_res = await execute_computer_action(
            action="get_window_bounds", text=app_name, x=None, y=None,
        )
        bounds = bounds_res.get("bounds", {})
        if not bounds.get("width"):
            return None

        # 2. Capture zoomed sidebar region (left 200px of the window)
        sidebar_w = min(200, bounds["width"] // 3)
        sidebar_region = {
            "x": bounds["x"],
            "y": bounds["y"],
            "width": sidebar_w,
            "height": min(400, bounds["height"]),
        }
        sidebar_result = await execute_computer_action(
            action="screenshot", x=None, y=None,
            screen_region=sidebar_region,
        )
        sidebar_b64 = sidebar_result.get("screenshot", "")
        if not sidebar_b64:
            return None

        # 3. Get the image dimensions for coordinate scaling
        import base64, io
        from PIL import Image
        img_bytes = base64.b64decode(sidebar_b64)
        img = Image.open(io.BytesIO(img_bytes))
        img_w, img_h = img.size

        # 4. Send to ui-parser find-element
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{UI_PARSER_URL}/internal/ui-parser/find-element",
                json={"image": sidebar_b64, "query": element_text},
            )
            data = resp.json()

        if not data.get("found"):
            logger.info("zoomed sidebar: '%s' not found by ui-parser", element_text)
            return None

        el = data["element"]
        cx, cy = el.get("center_px") or el.get("center", [0, 0])

        # 5. Scale image coords to native screen coords
        scale_x = sidebar_region["width"] / img_w
        scale_y = sidebar_region["height"] / img_h
        native_x = int(cx * scale_x + sidebar_region["x"])
        native_y = int(cy * scale_y + sidebar_region["y"])

        logger.info("zoomed sidebar: '%s' found at img(%d,%d) → native(%d,%d)",
                     element_text, int(cx), int(cy), native_x, native_y)

        # 6. Focus the app and click
        await execute_computer_action(
            action="focus_window", text=app_name, x=None, y=None,
        )
        await asyncio.sleep(0.3)

        click_result = await execute_computer_action(
            action="click", x=native_x, y=native_y,
            app=app_name,
        )
        if click_result.get("success"):
            return f"Clicked '{element_text}' at ({native_x},{native_y}) via zoomed sidebar"
        return None

    except Exception as e:
        logger.warning("zoomed sidebar click failed: %s", e)
        return None


# ── Main loop ────────────────────────────────────────────────────────────────

async def run_auto_goal(
    goal: str,
    max_steps: int = 15,
) -> dict[str, Any]:
    """Execute a goal autonomously and return the result.

    Returns dict with: success, steps_taken, actions, summary, final_screenshot.
    """
    logger.info("auto_goal: starting — goal=%r max_steps=%d", goal, max_steps)

    actions_log: list[dict[str, Any]] = []
    current_app: str | None = None
    consecutive_failures = 0
    summary = ""

    for step in range(1, max_steps + 1):
        # 1. Screenshot
        screenshot = await _take_primary_screenshot()
        if not screenshot:
            logger.warning("auto_goal step %d: screenshot failed", step)
            consecutive_failures += 1
            if consecutive_failures >= 3:
                break
            continue

        # 2. Build user message
        history_text = ""
        if actions_log:
            history_lines = []
            for a in actions_log[-6:]:
                status = "OK" if a.get("success") else "FAIL"
                history_lines.append(
                    f"  [{status}] {a['action']}({json.dumps(a.get('params', {}))}) → {a.get('output', '')[:100]}"
                )
            history_text = "\n".join(history_lines)

        # Stuck detection
        stuck_warning = ""
        if len(actions_log) >= 2:
            last_two = actions_log[-2:]
            if (last_two[0]["action"] == last_two[1]["action"]
                    and last_two[0].get("params") == last_two[1].get("params")):
                stuck_warning = (
                    "\n!! STUCK: Same action repeated twice. You MUST try something "
                    "completely different (different action or different params).\n"
                )

        user_msg = f"GOAL: {goal}\n"
        if history_text:
            user_msg += f"\nHistory:\n{history_text}\n"
        if stuck_warning:
            user_msg += stuck_warning
        user_msg += f"\nStep {step}/{max_steps}. Look at the screenshot carefully. What is the next action needed to achieve the goal?"

        # 3. Call LLM
        try:
            llm_response = await _call_llm(AUTO_GOAL_SYSTEM, user_msg, screenshot)
        except Exception as e:
            logger.error("auto_goal step %d: LLM call failed: %s", step, e)
            consecutive_failures += 1
            actions_log.append({
                "step": step, "action": "llm_error", "params": {},
                "success": False, "output": str(e),
            })
            if consecutive_failures >= 3:
                break
            continue

        logger.info("auto_goal step %d: LLM → %s", step, llm_response[:200])

        # 4. Parse response
        action_name, params = _parse_response(llm_response)

        if action_name == "DONE":
            # Guard: reject premature DONE — require at least one meaningful
            # action (type_text, click_ui_element, key_press, hotkey) in history
            # beyond just open_application/focus_window.
            meaningful_actions = {
                "type_text", "click_ui_element", "key_press", "hotkey",
                "scroll", "click", "double_click",
            }
            has_meaningful = any(
                a["action"] in meaningful_actions and a.get("success")
                for a in actions_log
            )
            if not has_meaningful:
                logger.info("auto_goal step %d: rejecting premature DONE (no meaningful actions yet)", step)
                # Force the LLM to take an actual action next time
                actions_log.append({
                    "step": step, "action": "done_rejected", "params": {},
                    "success": False,
                    "output": "DONE rejected: you haven't performed any actions yet (type, click, etc). Do the task first.",
                })
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    break
                continue

            summary = params if isinstance(params, str) else str(params)
            logger.info("auto_goal: DONE at step %d — %s", step, summary)
            actions_log.append({
                "step": step, "action": "DONE", "params": {},
                "success": True, "output": summary,
            })
            break

        if action_name == "UNKNOWN":
            logger.warning("auto_goal step %d: parse failed: %s", step, llm_response[:150])
            consecutive_failures += 1
            actions_log.append({
                "step": step, "action": "parse_error", "params": {},
                "success": False, "output": llm_response[:200],
            })
            if consecutive_failures >= 3:
                break
            continue

        # 5. Execute action with smart defaults
        params = params if isinstance(params, dict) else {"text": str(params)}

        # Track current app
        if action_name in ("open_application", "focus_window"):
            current_app = params.get("text")

        # Ensure app window is on primary screen after open/focus
        if action_name in ("open_application", "focus_window") and current_app:
            await _ensure_window_on_primary(current_app)

        # Auto-inject app target for interaction actions
        if current_app and action_name in (
            "click_ui_element", "type_text", "key_press", "hotkey",
            "click", "double_click", "right_click",
        ):
            if "app" not in params:
                params["app"] = current_app

        # Extract and map params to execute_computer_action signature
        exec_x = params.pop("x", None)
        exec_y = params.pop("y", None)
        exec_text = params.pop("text", None)
        exec_key = params.pop("key", None)
        exec_keys = params.pop("keys", None)
        exec_app = params.pop("app", None)

        exec_kwargs: dict[str, Any] = {}
        if exec_app:
            exec_kwargs["app"] = exec_app
        # Pass through remaining params (direction, amount, etc.)
        for k in ("direction", "amount", "button"):
            if k in params:
                exec_kwargs[k] = params.pop(k)

        try:
            result = await execute_computer_action(
                action=action_name,
                x=exec_x, y=exec_y,
                text=exec_text, key=exec_key, keys=exec_keys,
                **exec_kwargs,
            )
            success = result.get("success", False)
            output = result.get("output", "")

            # Fallback for click_ui_element: if the full-screen approach fails,
            # try a zoomed sidebar screenshot via the ui-parser service.
            if not success and action_name == "click_ui_element" and exec_text and current_app:
                logger.info("auto_goal: click_ui_element failed, trying zoomed sidebar fallback")
                zoomed = await _zoomed_sidebar_click(exec_text, current_app)
                if zoomed:
                    success = True
                    output = zoomed

        except Exception as e:
            success = False
            output = str(e)

        logger.info("auto_goal step %d: %s → %s (%s)",
                     step, action_name, "ok" if success else "FAIL", output[:100])

        actions_log.append({
            "step": step,
            "action": action_name,
            "params": {
                k: v for k, v in {
                    "text": exec_text, "key": exec_key, "keys": exec_keys,
                    "x": exec_x, "y": exec_y, "app": exec_app,
                }.items() if v is not None
            },
            "success": success,
            "output": output[:200],
        })

        if success:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= 3:
                logger.warning("auto_goal: 3 consecutive failures — stopping")
                break

        # Small delay between actions for UI to settle
        await asyncio.sleep(0.8)

    # Final screenshot
    final_screenshot = await _take_primary_screenshot()
    is_done = any(a["action"] == "DONE" for a in actions_log)

    return {
        "success": is_done,
        "steps_taken": len(actions_log),
        "actions": actions_log,
        "summary": summary or ("Goal execution stopped" if not is_done else ""),
        "final_screenshot": final_screenshot,
    }
