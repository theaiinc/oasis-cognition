"""Tests for the logic engine service."""

import pytest

from packages.reasoning_schema.enums import EdgeType, NodeType
from packages.reasoning_schema.models import (
    ProblemNode,
    ReasoningEdge,
    ReasoningGraph,
    TriggerNode,
)
from packages.shared_utils.config import Settings
from services.logic_engine.service import LogicEngineService


@pytest.mark.asyncio
async def test_reason_api_latency():
    settings = Settings()
    engine = LogicEngineService(settings)

    graph = ReasoningGraph(session_id="test")
    problem = ProblemNode(
        title="API latency",
        description="My API becomes slow when traffic reaches 2000 users",
    )
    trigger = TriggerNode(title="high concurrency")
    graph.add_node(problem)
    graph.add_node(trigger)
    graph.add_edge(ReasoningEdge(
        source_node=trigger.id,
        target_node=problem.id,
        edge_type=EdgeType.TRIGGERS,
    ))

    decision = await engine.reason(graph)

    assert decision.conclusion
    assert decision.confidence > 0
    assert len(decision.hypotheses) > 0
    assert len(decision.reasoning_trace) > 0
    assert any("database" in h["title"].lower() or "pool" in h["title"].lower() for h in decision.hypotheses)


@pytest.mark.asyncio
async def test_reason_unknown_problem():
    settings = Settings()
    engine = LogicEngineService(settings)

    graph = ReasoningGraph(session_id="test")
    problem = ProblemNode(title="Something weird happened")
    graph.add_node(problem)

    decision = await engine.reason(graph)

    assert decision.conclusion
    assert len(decision.hypotheses) >= 1


@pytest.mark.asyncio
async def test_reason_with_memory_context():
    settings = Settings()
    engine = LogicEngineService(settings)

    graph = ReasoningGraph(session_id="test")
    problem = ProblemNode(
        title="API latency",
        description="slow response",
    )
    trigger = TriggerNode(title="high concurrency")
    graph.add_node(problem)
    graph.add_node(trigger)
    graph.add_edge(ReasoningEdge(
        source_node=trigger.id,
        target_node=problem.id,
        edge_type=EdgeType.TRIGGERS,
    ))

    memory_context = [
        {"content": {"conclusion": "Database connection pool saturation"}, "memory_type": "episodic"}
    ]

    decision = await engine.reason(graph, memory_context)

    assert decision.conclusion
    assert decision.confidence > 0
