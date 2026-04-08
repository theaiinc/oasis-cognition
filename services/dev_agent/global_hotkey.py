"""Global emergency-stop hotkey for computer-use sessions.

Listens for a configurable hotkey at the OS level regardless of which
app is focused.  When triggered, pauses the active CU session via the
API gateway.

Runs in a daemon thread started from main.py on launch.
The hotkey can be changed at runtime via ``update_hotkey()``, which is
called from the ``/internal/dev-agent/cu-panic-key`` endpoint.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import httpx

logger = logging.getLogger(__name__)

API_GATEWAY_URL = os.getenv("API_GATEWAY_URL", "http://localhost:8000")
CU_API = f"{API_GATEWAY_URL}/api/v1/computer-use"

# Debounce: ignore repeated triggers within this window
_last_trigger = 0.0
_DEBOUNCE_SECONDS = 2.0

# Active listener — replaced on hotkey change
_active_listener: Any = None
_active_lock = threading.Lock()
_current_hotkey: str = ""


# ── UI format → pynput format conversion ──────────────────────────────────

_KEY_MAP = {
    "meta": "<cmd>",
    "command": "<cmd>",
    "ctrl": "<ctrl>",
    "shift": "<shift>",
    "alt": "<alt>",
    "escape": "<esc>",
    "enter": "<enter>",
    "tab": "<tab>",
    "space": "<space>",
    "backspace": "<backspace>",
}


def _ui_to_pynput(ui_key: str) -> str:
    """Convert UI hotkey format (meta+Escape) to pynput format (<cmd>+<esc>)."""
    parts = ui_key.split("+")
    pynput_parts = []
    for part in parts:
        lower = part.lower().strip()
        if lower in _KEY_MAP:
            pynput_parts.append(_KEY_MAP[lower])
        elif len(lower) == 1:
            pynput_parts.append(lower)
        else:
            pynput_parts.append(f"<{lower}>")
    return "+".join(pynput_parts)


# ── Emergency stop action ─────────────────────────────────────────────────

def _on_emergency_stop() -> None:
    """Called when the global hotkey is pressed."""
    import time

    global _last_trigger
    now = time.monotonic()
    if now - _last_trigger < _DEBOUNCE_SECONDS:
        return
    _last_trigger = now

    logger.warning("EMERGENCY STOP hotkey triggered — pausing active CU session")

    try:
        resp = httpx.get(f"{CU_API}/sessions/active", timeout=5)
        if resp.status_code != 200:
            logger.info("No active CU session to pause")
            return

        data = resp.json()
        session = data.get("session")
        if not session:
            logger.info("No active CU session to pause")
            return

        session_id = session.get("session_id")
        status = session.get("status")
        if status != "executing":
            logger.info("CU session %s is %s, not executing — skipping pause", session_id, status)
            return

        pause_resp = httpx.post(f"{CU_API}/sessions/{session_id}/pause", timeout=5)
        if pause_resp.status_code == 200:
            logger.warning("EMERGENCY STOP: paused CU session %s", session_id)
        else:
            logger.error("Failed to pause session %s: %s", session_id, pause_resp.text)

    except Exception as e:
        logger.error("Emergency stop failed: %s", e)


# ── Listener management ──────────────────────────────────────────────────

def _start_listener(pynput_hotkey: str) -> None:
    """Start (or restart) the global hotkey listener with the given key combo."""
    global _active_listener, _current_hotkey

    try:
        from pynput import keyboard
    except ImportError:
        logger.warning("pynput not installed — global emergency stop hotkey disabled")
        return

    with _active_lock:
        # Stop existing listener
        if _active_listener is not None:
            try:
                _active_listener.stop()
            except Exception:
                pass
            _active_listener = None

        _current_hotkey = pynput_hotkey

        def _run() -> None:
            global _active_listener
            try:
                listener = keyboard.GlobalHotKeys({pynput_hotkey: _on_emergency_stop})
                listener.start()
                with _active_lock:
                    _active_listener = listener
                logger.info("Global emergency stop hotkey active: %s", pynput_hotkey)
                listener.join()
            except Exception as e:
                # "cannot join thread before it is started" is expected when
                # the listener is stopped before join — ignore it.
                if "cannot join" not in str(e):
                    logger.error("Global hotkey listener failed: %s", e)

        thread = threading.Thread(target=_run, daemon=True, name="cu-emergency-stop")
        thread.start()


def update_hotkey(ui_format_key: str) -> str:
    """Update the global hotkey from UI format (e.g. 'meta+Escape').

    Returns the pynput format string that was applied.
    """
    pynput_key = _ui_to_pynput(ui_format_key)
    logger.info("Updating global hotkey: %s → %s", ui_format_key, pynput_key)
    _start_listener(pynput_key)
    return pynput_key


def get_current_hotkey() -> str:
    """Return the currently active hotkey in pynput format."""
    return _current_hotkey


def start_global_hotkey_listener() -> None:
    """Start the global hotkey listener with the default key combo.

    Called once from main.py on startup.
    """
    default_ui = os.getenv("OASIS_CU_PANIC_HOTKEY", "meta+Escape")
    update_hotkey(default_ui)
