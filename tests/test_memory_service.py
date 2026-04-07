"""Tests for the memory service (uses in-memory fallback when Neo4j unavailable)."""

import pytest

from packages.reasoning_schema.enums import MemoryType
from packages.reasoning_schema.models import MemoryEntry, ReasoningGraph, ProblemNode
from services.memory_service.service import MemoryService
from packages.shared_utils.config import Settings


@pytest.fixture
def memory_svc():
    """Create a memory service that falls back to in-memory (no Neo4j needed)."""
    settings = Settings(neo4j_uri="bolt://localhost:99999")  # force fallback
    return MemoryService(settings)


@pytest.mark.asyncio
async def test_store_and_retrieve(memory_svc):
    entry = MemoryEntry(
        memory_type=MemoryType.SEMANTIC,
        content={"topic": "database optimization", "notes": "connection pooling helps"},
        tags=["database", "optimization"],
    )
    await memory_svc.store(entry)

    results = await memory_svc.retrieve("database")
    assert len(results) == 1
    assert results[0].memory_id == entry.memory_id


@pytest.mark.asyncio
async def test_store_graph(memory_svc):
    graph = ReasoningGraph(session_id="test-session")
    graph.add_node(ProblemNode(title="API latency"))

    await memory_svc.store_graph(graph)

    results = await memory_svc.retrieve("API latency")
    assert len(results) == 1


@pytest.mark.asyncio
async def test_store_and_retrieve_rules(memory_svc):
    await memory_svc.store_rule("database locking exists", "caching ineffective", 0.9)
    rules = await memory_svc.retrieve_rules(["database"])
    assert len(rules) == 1
    assert rules[0]["confidence"] == 0.9


@pytest.mark.asyncio
async def test_apply_feedback(memory_svc):
    await memory_svc.apply_feedback(
        session_id="sess-1",
        node_id="node-1",
        feedback_type="correction",
        comment="Caching will not fix this issue.",
    )

    results = await memory_svc.retrieve("feedback")
    assert len(results) >= 1
