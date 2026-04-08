"""Reusable async task queue with SSE pub/sub, position tracking, and concurrency control.

Two flavours:
  - ``BackgroundTaskQueue``  — fire-and-forget tasks (artifact processing)
  - ``RequestQueue``         — callers wait for a result (LLM requests)

Both share the same SSE subscriber & position-tracking infrastructure.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")  # result type


# ── SSE Pub/Sub mixin ──────────────────────────────────────────────────

class SSEBroadcaster:
    """Manage SSE subscriber queues and broadcast events."""

    def __init__(self) -> None:
        self._sse_subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._sse_subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._sse_subscribers.discard(q)

    async def broadcast(self, data: dict) -> None:
        dead: list[asyncio.Queue] = []
        for q in self._sse_subscribers:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._sse_subscribers.discard(q)


# ── Background Task Queue (fire-and-forget) ───────────────────────────

class BackgroundTaskQueue(SSEBroadcaster):
    """Process string-keyed tasks one-at-a-time via a background worker.

    Re-usable replacement for the inline queue in artifact_service.
    Callers enqueue a key; a worker pulls keys and calls the provided
    ``process_fn(key)`` coroutine.
    """

    def __init__(self, name: str = "task") -> None:
        super().__init__()
        self.name = name
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._queue_order: list[str] = []
        self._lock = asyncio.Lock()
        self._current: str | None = None
        self._worker_task: asyncio.Task | None = None

    # -- public API --

    async def enqueue(self, key: str) -> int:
        """Add *key* to the queue. Returns position (1-based). Skips duplicates."""
        async with self._lock:
            if key in self._queue_order or key == self._current:
                return 0  # already present
            self._queue_order.append(key)
            position = len(self._queue_order)
        await self._queue.put(key)
        await self.broadcast({"event": "status", f"{self.name}_id": key, "status": "queued", "position": position})
        return position

    async def start(
        self,
        process_fn: Callable[[str], Awaitable[None]],
        pre_check_fn: Callable[[str], Awaitable[bool]] | None = None,
    ) -> None:
        """Start the background worker.

        *process_fn*: async callable that processes a single key.
        *pre_check_fn*: optional guard — return False to skip (e.g. deleted).
        """
        self._worker_task = asyncio.create_task(self._run(process_fn, pre_check_fn))

    async def stop(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass

    @property
    def current(self) -> str | None:
        return self._current

    @property
    def pending(self) -> list[str]:
        return list(self._queue_order)

    def status(self) -> dict:
        return {"current_processing": self._current, "queue": list(self._queue_order)}

    # -- worker loop --

    async def _run(
        self,
        process_fn: Callable[[str], Awaitable[None]],
        pre_check_fn: Callable[[str], Awaitable[bool]] | None,
    ) -> None:
        logger.info("[%s-queue] Worker started", self.name)
        while True:
            key = await self._queue.get()
            try:
                async with self._lock:
                    if key in self._queue_order:
                        self._queue_order.remove(key)
                    self._current = key
                    for i, qid in enumerate(self._queue_order):
                        await self.broadcast({"event": "status", f"{self.name}_id": qid, "status": "queued", "position": i + 1})

                # Optional pre-check (e.g. was artifact deleted?)
                if pre_check_fn and not await pre_check_fn(key):
                    logger.info("[%s-queue] Skipping %s (pre-check failed)", self.name, key)
                    await self.broadcast({"event": "status", f"{self.name}_id": key, "status": "skipped"})
                    continue

                await self.broadcast({"event": "status", f"{self.name}_id": key, "status": "processing"})
                await process_fn(key)

            except Exception as e:
                logger.error("[%s-queue] Failed processing %s: %s", self.name, key, e, exc_info=True)
                await self.broadcast({"event": "status", f"{self.name}_id": key, "status": "error", "message": str(e)})
            finally:
                self._current = None
                self._queue.task_done()


# ── Request Queue (caller waits for result) ────────────────────────────

@dataclass
class _PendingRequest(Generic[T]):
    """Internal wrapper for a queued request with a future for the result."""
    request_id: str
    payload: Any
    future: asyncio.Future[T] = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    enqueued_at: float = field(default_factory=time.monotonic)


class RequestQueue(SSEBroadcaster, Generic[T]):
    """Serialise async requests through a single worker, returning results to callers.

    Usage::

        q = RequestQueue[str](name="llm", concurrency=1)
        await q.start()
        result = await q.submit("req-123", payload={"prompt": "..."})
    """

    def __init__(self, name: str = "request", concurrency: int = 1) -> None:
        super().__init__()
        self.name = name
        self._concurrency = concurrency
        self._queue: asyncio.Queue[_PendingRequest[T]] = asyncio.Queue()
        self._pending_order: list[str] = []
        self._lock = asyncio.Lock()
        self._current: list[str] = []
        self._worker_tasks: list[asyncio.Task] = []
        self._process_fn: Callable[[Any], Awaitable[T]] | None = None

    async def start(self, process_fn: Callable[[Any], Awaitable[T]]) -> None:
        """Start worker(s). *process_fn* receives the payload and must return T."""
        self._process_fn = process_fn
        for i in range(self._concurrency):
            self._worker_tasks.append(asyncio.create_task(self._run(i)))

    async def stop(self) -> None:
        for t in self._worker_tasks:
            t.cancel()
        for t in self._worker_tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        self._worker_tasks.clear()

    async def submit(self, request_id: str, payload: Any, timeout: float = 600.0) -> T:
        """Submit a request and wait for the result. Raises on timeout or processing error."""
        req = _PendingRequest[T](request_id=request_id, payload=payload)

        async with self._lock:
            self._pending_order.append(request_id)
            position = len(self._pending_order) + len(self._current)

        await self._queue.put(req)
        await self.broadcast({
            "event": "queued", "request_id": request_id,
            "position": position, "queue_depth": len(self._pending_order),
        })
        logger.debug("[%s-queue] Submitted %s (position %d)", self.name, request_id, position)

        try:
            return await asyncio.wait_for(req.future, timeout=timeout)
        except asyncio.TimeoutError:
            req.future.cancel()
            raise

    def status(self) -> dict:
        return {
            "current_processing": list(self._current),
            "queue": list(self._pending_order),
            "queue_depth": len(self._pending_order),
            "concurrency": self._concurrency,
        }

    async def _run(self, worker_id: int) -> None:
        logger.info("[%s-queue] Worker %d started (concurrency=%d)", self.name, worker_id, self._concurrency)
        while True:
            req = await self._queue.get()
            try:
                async with self._lock:
                    if req.request_id in self._pending_order:
                        self._pending_order.remove(req.request_id)
                    self._current.append(req.request_id)
                    # Broadcast updated positions
                    for i, rid in enumerate(self._pending_order):
                        await self.broadcast({"event": "queued", "request_id": rid, "position": i + 1})

                await self.broadcast({"event": "processing", "request_id": req.request_id})
                result = await self._process_fn(req.payload)  # type: ignore[misc]

                if not req.future.cancelled():
                    req.future.set_result(result)

                elapsed = time.monotonic() - req.enqueued_at
                await self.broadcast({
                    "event": "completed", "request_id": req.request_id,
                    "duration_ms": int(elapsed * 1000),
                    "queue_depth": len(self._pending_order),
                })

            except Exception as e:
                if not req.future.done():
                    req.future.set_exception(e)
                await self.broadcast({"event": "error", "request_id": req.request_id, "message": str(e)})
            finally:
                if req.request_id in self._current:
                    self._current.remove(req.request_id)
                self._queue.task_done()
