"""Redis Streams event bus for Oasis Cognition."""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as aioredis

from packages.event_types.events import BaseEvent

logger = logging.getLogger(__name__)

STREAM_KEY = "oasis:events"


class RedisEventBus:
    """Event bus backed by Redis Streams."""

    def __init__(self, redis_url: str = "redis://localhost:6379") -> None:
        self._redis_url = redis_url
        self._redis: aioredis.Redis | None = None

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = aioredis.from_url(self._redis_url, decode_responses=True)
        return self._redis

    async def publish(self, event: BaseEvent) -> str:
        """Publish an event to the Redis stream. Returns the message ID."""
        r = await self._get_redis()
        data = {
            "event_id": event.event_id,
            "event_type": event.event_type,
            "session_id": event.session_id,
            "trace_id": event.trace_id,
            "timestamp": event.timestamp.isoformat(),
            "payload": json.dumps(event.payload),
        }
        msg_id = await r.xadd(STREAM_KEY, data)
        logger.debug("Event published to Redis: %s (%s)", event.event_type, msg_id)
        return msg_id

    async def read_events(
        self,
        last_id: str = "0-0",
        count: int = 100,
    ) -> list[dict[str, Any]]:
        """Read events from the stream."""
        r = await self._get_redis()
        messages = await r.xrange(STREAM_KEY, min=last_id, count=count)
        events = []
        for msg_id, data in messages:
            data["payload"] = json.loads(data.get("payload", "{}"))
            data["_msg_id"] = msg_id
            events.append(data)
        return events

    async def read_by_session(self, session_id: str, count: int = 100) -> list[dict[str, Any]]:
        """Read events for a specific session."""
        all_events = await self.read_events(count=count * 10)
        return [e for e in all_events if e.get("session_id") == session_id][:count]

    async def close(self) -> None:
        if self._redis:
            await self._redis.close()
            self._redis = None
