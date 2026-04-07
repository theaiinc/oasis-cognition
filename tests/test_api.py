"""Integration tests for individual Python microservices."""

import pytest
from fastapi.testclient import TestClient


def test_graph_builder_health():
    from services.graph_builder.main import app
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["service"] == "graph-builder"


def test_graph_builder_build():
    from services.graph_builder.main import app
    client = TestClient(app)
    resp = client.post("/internal/graph/build", json={
        "semantic_structure": {
            "problem": "API latency",
            "trigger": "high concurrency",
            "entities": {"threshold": 2000},
            "intent": "diagnose",
            "context": {},
            "raw_input": "My API is slow at 2000 users",
        },
        "session_id": "test-1",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "reasoning_graph" in data
    graph = data["reasoning_graph"]
    assert len(graph["nodes"]) >= 2
    assert len(graph["edges"]) >= 1


def test_logic_engine_health():
    from services.logic_engine.main import app
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["service"] == "logic-engine"
