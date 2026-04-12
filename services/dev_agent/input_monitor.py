"""User interference detection for CU agent sessions.

Monitors mouse and keyboard input to detect when the user is interacting
with the computer during a CU session. Distinguishes agent-initiated actions
from user input using an `_agent_acting` flag.

Usage:
    from services.dev_agent.input_monitor import input_monitor
    input_monitor.start("cu-xxx")
    # ... CU session runs ...
    if input_monitor.is_interference():
        # pause session, wait for silence
    input_monitor.stop()
"""

from __future__ import annotations

import logging
import math
import threading
import time

logger = logging.getLogger(__name__)


class InputMonitor:
    """Detects user interference during CU sessions."""

    # Config
    MOUSE_MOVE_THRESHOLD = 25   # pixels — ignore tiny jitter / sub-pixel drift
    RESUME_DELAY = 3.0          # seconds of silence before clearing interference
    COOLDOWN_AFTER_AGENT = 0.8  # seconds to ignore input after agent finishes an action

    def __init__(self):
        self._active = False
        self._session_id: str = ""
        self._agent_acting = False
        self._agent_done_at: float = 0  # timestamp when agent last finished acting
        self._interference_detected = False
        self._last_user_input_time: float = 0
        self._last_mouse_x: float = 0
        self._last_mouse_y: float = 0
        self._mouse_listener = None
        self._keyboard_listener = None
        self._silence_thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def start(self, session_id: str) -> None:
        """Start monitoring mouse + keyboard input for interference detection."""
        if self._active:
            self.stop()

        self._session_id = session_id
        self._active = True
        self._agent_acting = False
        self._interference_detected = False
        self._last_user_input_time = 0
        self._stop_event.clear()

        try:
            from pynput import mouse, keyboard

            # Mouse listener — detect movement and clicks
            self._mouse_listener = mouse.Listener(
                on_move=self._on_mouse_move,
                on_click=self._on_mouse_click,
            )
            self._mouse_listener.daemon = True
            self._mouse_listener.start()

            # Keyboard listener — detect key presses
            self._keyboard_listener = keyboard.Listener(
                on_press=self._on_key_press,
            )
            self._keyboard_listener.daemon = True
            self._keyboard_listener.start()

            # Silence watcher — auto-clear interference after RESUME_DELAY
            self._silence_thread = threading.Thread(
                target=self._silence_watcher, daemon=True,
            )
            self._silence_thread.start()

            logger.info("InputMonitor started for session %s", session_id)
        except Exception as e:
            logger.warning("InputMonitor failed to start: %s", e)
            self._active = False

    def stop(self) -> None:
        """Stop monitoring."""
        self._active = False
        self._stop_event.set()

        if self._mouse_listener:
            try:
                self._mouse_listener.stop()
            except Exception:
                pass
            self._mouse_listener = None

        if self._keyboard_listener:
            try:
                self._keyboard_listener.stop()
            except Exception:
                pass
            self._keyboard_listener = None

        self._silence_thread = None
        self._interference_detected = False
        logger.info("InputMonitor stopped for session %s", self._session_id)

    def set_agent_acting(self, acting: bool) -> None:
        """Called by computer_use.py before/after each agent action.

        While acting=True, all mouse/keyboard input is treated as agent-initiated
        and NOT flagged as user interference.
        """
        self._agent_acting = acting
        if not acting:
            self._agent_done_at = time.time()

    def is_interference(self) -> bool:
        """Check if user interference is currently detected."""
        return self._interference_detected and self._active

    def last_input_ago(self) -> float:
        """Seconds since last user input (0 if no input detected)."""
        if self._last_user_input_time == 0:
            return 0
        return time.time() - self._last_user_input_time

    def status(self) -> dict:
        """Current monitor status for the API endpoint."""
        return {
            "active": self._active,
            "session_id": self._session_id,
            "interference": self._interference_detected,
            "agent_acting": self._agent_acting,
            "last_input_ago": round(self.last_input_ago(), 1),
        }

    # ── Listeners ──────────────────────────────────────────────────────────

    def _should_ignore(self) -> bool:
        """Whether to ignore current input (agent is acting or cooldown period)."""
        if not self._active:
            return True
        if self._agent_acting:
            return True
        # Ignore input shortly after agent finishes (mouse settling, key release, etc.)
        if time.time() - self._agent_done_at < self.COOLDOWN_AFTER_AGENT:
            return True
        return False

    def _flag_interference(self, source: str) -> None:
        """Mark that user interference was detected."""
        if self._interference_detected:
            # Already flagged — just update timestamp
            self._last_user_input_time = time.time()
            return

        self._interference_detected = True
        self._last_user_input_time = time.time()
        logger.info("User interference detected (%s) during session %s",
                     source, self._session_id)

    def _on_mouse_move(self, x: float, y: float) -> None:
        if self._should_ignore():
            return

        # Check if movement exceeds threshold (ignore jitter)
        dx = abs(x - self._last_mouse_x)
        dy = abs(y - self._last_mouse_y)
        self._last_mouse_x = x
        self._last_mouse_y = y

        if math.sqrt(dx * dx + dy * dy) >= self.MOUSE_MOVE_THRESHOLD:
            self._flag_interference("mouse_move")

    def _on_mouse_click(self, x: float, y: float, button, pressed: bool) -> None:
        if self._should_ignore():
            return
        if pressed:  # Only on press, not release
            self._flag_interference("mouse_click")

    def _on_key_press(self, key) -> None:
        if self._should_ignore():
            return
        # Ignore modifier-only presses (Shift, Ctrl, Alt, Cmd) — they're often
        # accidental or part of the agent's hotkey combos settling
        try:
            from pynput.keyboard import Key
            if key in (Key.shift, Key.shift_r, Key.ctrl, Key.ctrl_r,
                       Key.alt, Key.alt_r, Key.cmd, Key.cmd_r):
                return
        except Exception:
            pass
        self._flag_interference("keyboard")

    # ── Silence watcher ────────────────────────────────────────────────────

    def _silence_watcher(self) -> None:
        """Background thread: clears interference flag after RESUME_DELAY of silence."""
        while not self._stop_event.is_set():
            self._stop_event.wait(0.5)  # Check every 500ms
            if not self._active or not self._interference_detected:
                continue
            if self._last_user_input_time == 0:
                continue

            silence_duration = time.time() - self._last_user_input_time
            if silence_duration >= self.RESUME_DELAY and not self._agent_acting:
                self._interference_detected = False
                logger.info("User interference cleared (%.1fs silence) — ready to resume session %s",
                             silence_duration, self._session_id)


# Singleton instance — shared across the dev-agent
input_monitor = InputMonitor()
