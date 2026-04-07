"""Chrome Bridge — WebSocket bridge to the Oasis Chrome Bridge extension.

Singleton that holds the active WebSocket connection and provides a
coroutine-based request/response API with UUID correlation.

When the extension is connected, computer_use.py routes Chrome actions
(get_page_text, chrome_navigate, chrome_set_url) through here instead
of AppleScript.  When disconnected, callers fall back to AppleScript.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ChromeBridge:
    """WebSocket bridge to the Oasis Chrome Bridge extension."""

    def __init__(self) -> None:
        self.ws: WebSocket | None = None
        self.connected: bool = False
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}

    # ------------------------------------------------------------------
    # Connection lifecycle (called from the WS endpoint in main.py)
    # ------------------------------------------------------------------

    async def accept(self, ws: WebSocket) -> None:
        """Accept and register a new extension connection."""
        await ws.accept()
        self.ws = ws
        self.connected = True
        logger.info("Chrome Bridge extension connected")

    def disconnect(self) -> None:
        """Mark the bridge as disconnected and cancel pending futures."""
        self.ws = None
        self.connected = False
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("Chrome Bridge disconnected"))
        self._pending.clear()
        logger.info("Chrome Bridge extension disconnected")

    # ------------------------------------------------------------------
    # Message handling (called from the WS read loop in main.py)
    # ------------------------------------------------------------------

    def handle_message(self, data: dict[str, Any]) -> None:
        """Resolve a pending future when a response arrives."""
        msg_id = data.get("id")
        if not msg_id or msg_id not in self._pending:
            logger.debug("Ignoring message with unknown id: %s", msg_id)
            return
        fut = self._pending.pop(msg_id)
        if not fut.done():
            fut.set_result(data)

    # ------------------------------------------------------------------
    # Command API (called from computer_use.py)
    # ------------------------------------------------------------------

    async def send_command(
        self,
        command: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        """Send a command to the extension and await the response.

        Raises ``ConnectionError`` if not connected.
        Raises ``asyncio.TimeoutError`` if the extension doesn't respond.
        """
        if not self.connected or self.ws is None:
            raise ConnectionError("Chrome Bridge not connected")

        msg_id = str(uuid.uuid4())
        msg = {
            "id": msg_id,
            "type": "request",
            "command": command,
            "payload": payload or {},
        }

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[msg_id] = fut

        try:
            await self.ws.send_json(msg)
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise
        except Exception:
            self._pending.pop(msg_id, None)
            raise


# Module-level singleton — imported by computer_use.py and main.py
chrome_bridge = ChromeBridge()
