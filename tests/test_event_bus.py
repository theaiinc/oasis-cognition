"""Tests for event types."""

from packages.event_types.events import (
    InteractionReceivedEvent,
    DecisionFinalizedEvent,
    SemanticParsedEvent,
)


def test_event_creation():
    event = InteractionReceivedEvent(
        session_id="test",
        payload={"user_message": "hello"},
    )
    assert event.event_type == "InteractionReceived"
    assert event.session_id == "test"
    assert event.event_id  # auto-generated
    assert event.trace_id  # auto-generated


def test_decision_event():
    event = DecisionFinalizedEvent(
        session_id="s1",
        payload={"decision": "database bottleneck", "confidence": 0.82},
    )
    assert event.event_type == "DecisionFinalized"
    assert event.payload["confidence"] == 0.82


def test_semantic_event():
    event = SemanticParsedEvent(
        session_id="s1",
        payload={"problem": "API latency", "trigger": "high concurrency"},
    )
    assert event.event_type == "SemanticParsed"
