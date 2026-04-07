"""Event definitions for Oasis Cognition."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class BaseEvent(BaseModel):
    event_id: str = Field(default_factory=_uuid)
    event_type: str = ""
    session_id: str = ""
    timestamp: datetime = Field(default_factory=_utcnow)
    trace_id: str = Field(default_factory=_uuid)
    payload: dict[str, Any] = Field(default_factory=dict)


class InteractionReceivedEvent(BaseEvent):
    event_type: str = "InteractionReceived"


class SemanticParsedEvent(BaseEvent):
    event_type: str = "SemanticParsed"


class GraphConstructedEvent(BaseEvent):
    event_type: str = "GraphConstructed"


class ReasoningStartedEvent(BaseEvent):
    event_type: str = "ReasoningStarted"


class HypothesisGeneratedEvent(BaseEvent):
    event_type: str = "HypothesisGenerated"


class ConstraintEvaluatedEvent(BaseEvent):
    event_type: str = "ConstraintEvaluated"


class DecisionFinalizedEvent(BaseEvent):
    event_type: str = "DecisionFinalized"


class ResponseGeneratedEvent(BaseEvent):
    event_type: str = "ResponseGenerated"


class FeedbackReceivedEvent(BaseEvent):
    event_type: str = "FeedbackReceived"


class MemoryUpdatedEvent(BaseEvent):
    event_type: str = "MemoryUpdated"


class ToolPlanningStartedEvent(BaseEvent):
    event_type: str = "ToolPlanningStarted"


class ToolCallStartedEvent(BaseEvent):
    event_type: str = "ToolCallStarted"


class ToolCallCompletedEvent(BaseEvent):
    event_type: str = "ToolCallCompleted"


class ToolCallBlockedEvent(BaseEvent):
    event_type: str = "ToolCallBlocked"


class ToolUseCompleteEvent(BaseEvent):
    event_type: str = "ToolUseComplete"
