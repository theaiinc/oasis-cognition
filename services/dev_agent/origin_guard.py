"""Which browser pages may talk to the dev-agent.

The dev-agent runs bash, edits files and drives the screen, with no login of its
own. It used to answer CORS for every origin, so any website the user had open
could POST to its endpoints and write files or run commands on their machine.

A browser always names the page in the Origin header of a cross-origin request
and of a WebSocket handshake. This guard refuses one whose Origin isn't the local
Oasis UI (loopback hosts) before any route runs, so a "simple" request that skips
the CORS preflight is stopped too. Requests with no Origin (the gateway, the CLI,
curl, native apps) are not from a web page and pass as before.

An extension's chrome-extension:// origin may read /health; the bridge socket itself
takes only the Oasis Chrome Bridge (chrome_bridge.origin_allowed), not other
extensions or local pages.

DEV_AGENT_ALLOWED_ORIGINS (comma-separated) adds page origins, for a UI opened from
another address, e.g. http://192.168.1.20:3000.
"""

from __future__ import annotations

import os
import re
from typing import Any, Awaitable, Callable

_LOCAL_ORIGIN = re.compile(r"^(https?)://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.IGNORECASE)
_EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
# What an extension may open: the bridge socket, and /health for the popup's status.
EXTENSION_SOCKETS = ("/ws/chrome-bridge",)
EXTENSION_READS = ("/health",)


def _extra_origins() -> set[str]:
    return {o.strip().rstrip("/") for o in os.getenv("DEV_AGENT_ALLOWED_ORIGINS", "").split(",") if o.strip()}


def origin_allowed(origin: str | None, path: str = "", websocket: bool = False, method: str = "GET") -> bool:
    if origin is None:
        return True
    origin = origin.strip().rstrip("/")
    if _LOCAL_ORIGIN.match(origin) or origin in _extra_origins():
        return True
    if not _EXTENSION_ORIGIN.match(origin):
        return False
    return path in EXTENSION_SOCKETS if websocket else (path in EXTENSION_READS and method == "GET")


def cors_origin_regex() -> str:
    """For CORSMiddleware: answer preflights only for the pages the guard lets through."""
    extra = "|".join(re.escape(o) for o in sorted(_extra_origins()))
    base = r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?"
    return rf"^({base}{'|' + extra if extra else ''})$"


Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


class OriginGuard:
    """ASGI middleware: refuse HTTP requests and WebSocket handshakes from other web pages."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        origin = None
        for name, value in scope.get("headers") or []:
            if name == b"origin":
                origin = value.decode("latin-1")
                break
        # "null" (a sandboxed frame, a file: page) is a web page with no address: refused.
        if origin_allowed(origin, scope.get("path", ""), websocket=scope["type"] == "websocket", method=scope.get("method", "GET")):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b'{"error":"origin_not_allowed"}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
