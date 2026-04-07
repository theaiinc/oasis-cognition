"""Tests for the graph builder service."""

import pytest

from packages.reasoning_schema.enums import GraphTier, NodeType
from packages.reasoning_schema.models import SemanticStructure
from services.graph_builder.service import GraphBuilderService


@pytest.mark.asyncio
async def test_build_graph_basic():
    builder = GraphBuilderService()
    semantic = SemanticStructure(
        problem="API latency",
        trigger="high concurrency",
        entities={"threshold": 2000, "metric": "response time"},
        intent="diagnose",
        raw_input="My API becomes slow when traffic reaches 2000 users.",
    )

    graph = await builder.build_graph(semantic, session_id="test-1")

    assert len(graph.nodes) >= 2  # problem + trigger
    assert len(graph.edges) >= 1  # trigger -> problem
    assert graph.session_id == "test-1"

    problems = graph.get_nodes_by_type(NodeType.PROBLEM)
    assert len(problems) == 1
    assert problems[0].title == "API latency"

    triggers = graph.get_nodes_by_type(NodeType.TRIGGER)
    assert len(triggers) == 1
    assert triggers[0].title == "high concurrency"


@pytest.mark.asyncio
async def test_build_graph_with_entities():
    builder = GraphBuilderService()
    semantic = SemanticStructure(
        problem="Memory leak",
        trigger="",
        entities={"heap_size": "4GB", "uptime": "72h"},
        intent="diagnose",
        raw_input="Memory leak after 72 hours",
    )

    graph = await builder.build_graph(semantic, session_id="test-2")

    evidence = graph.get_nodes_by_type(NodeType.EVIDENCE)
    assert len(evidence) == 2  # heap_size + uptime


@pytest.mark.asyncio
async def test_build_graph_assigns_foundational_tiers():
    """All nodes created by build_graph should be FOUNDATIONAL tier."""
    builder = GraphBuilderService()
    semantic = SemanticStructure(
        problem="Disk full",
        trigger="log rotation disabled",
        entities={"disk_usage": "98%"},
        intent="diagnose",
        raw_input="Disk is full because log rotation was disabled.",
    )

    graph = await builder.build_graph(semantic, session_id="tier-test")

    for node in graph.nodes:
        assert node.tier == GraphTier.FOUNDATIONAL, (
            f"{node.node_type.value} should be FOUNDATIONAL but got {node.tier}"
        )


@pytest.mark.asyncio
async def test_build_task_graph_assigns_active_tiers():
    """GoalNode and PlanNodes from build_task_graph should be ACTIVE tier."""
    builder = GraphBuilderService()
    semantic = SemanticStructure(
        problem="Refactor auth module",
        intent="refactor",
        raw_input="Refactor the auth module",
    )

    graph = await builder.build_task_graph(
        semantic,
        plan_steps=[{"description": "Extract middleware"}, {"description": "Add tests"}],
        session_id="tier-test",
    )

    goals = graph.get_nodes_by_type(NodeType.GOAL)
    plans = graph.get_nodes_by_type(NodeType.PLAN)

    assert len(goals) >= 1
    for g in goals:
        assert g.tier == GraphTier.ACTIVE

    assert len(plans) >= 1
    for p in plans:
        assert p.tier == GraphTier.ACTIVE
