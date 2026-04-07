"""Graph Builder microservice — POST /internal/graph/build"""

from __future__ import annotations

import logging
import sys
import os
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any

from packages.reasoning_schema.models import ReasoningGraph, SemanticStructure
from packages.shared_utils.logging import setup_logging
from services.graph_builder.service import GraphBuilderService

logger = logging.getLogger(__name__)

builder = GraphBuilderService()


class BuildRequest(BaseModel):
    semantic_structure: dict[str, Any]
    session_id: str = ""


class BuildTaskRequest(BaseModel):
    semantic_structure: dict[str, Any]
    plan_steps: list[dict[str, Any]] = []
    session_id: str = ""
    tool_results: list[dict[str, Any]] | None = None
    existing_graph: dict[str, Any] | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging("INFO")
    logger.info("Graph Builder service started")
    yield


app = FastAPI(title="Oasis Graph Builder Service", lifespan=lifespan)


@app.post("/internal/graph/build")
async def build_graph(req: BuildRequest):
    semantic = SemanticStructure(**req.semantic_structure)
    graph = await builder.build_graph(semantic, req.session_id)
    return {"reasoning_graph": graph.model_dump(mode="json")}


@app.post("/internal/graph/build-task")
async def build_task_graph(req: BuildTaskRequest):
    """Build or update task graph for tool_use (goal → plan → actions)."""
    semantic = SemanticStructure(**req.semantic_structure)
    existing = ReasoningGraph(**req.existing_graph) if req.existing_graph else None
    graph = await builder.build_task_graph(
        semantic,
        req.plan_steps,
        session_id=req.session_id,
        tool_results=req.tool_results,
        existing_graph=existing,
    )
    return {"task_graph": graph.model_dump(mode="json")}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "graph-builder"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
