"""Logic Engine microservice — POST /internal/reason"""

from __future__ import annotations

import logging
import sys
import os
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any

from packages.reasoning_schema.models import ReasoningGraph
from packages.shared_utils.config import get_settings
from packages.shared_utils.logging import setup_logging
from services.logic_engine.service import LogicEngineService

logger = logging.getLogger(__name__)

_settings = get_settings()
engine = LogicEngineService(_settings)


class ReasonRequest(BaseModel):
    reasoning_graph: dict[str, Any]
    memory_context: list[dict[str, Any]] = []
    memory_stale_hint: str | None = None


class ValidateGoalRequest(BaseModel):
    task_graph: dict[str, Any]
    success_criteria: list[str] | None = None
    plan_steps: list[dict[str, Any]] | None = None
    memory_context: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []
    memory_stale_hint: str | None = None
    validated_thoughts: list[dict[str, Any]] | None = None
    proposed_final_answer: str | None = None

class ValidateThoughtsRequest(BaseModel):
    thoughts: list[dict[str, Any]]
    memory_context: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []
    walls_hit: list[str] = []
    tool_results: list[dict[str, Any]] = []

class AssessFeasibilityRequest(BaseModel):
    user_goal: str
    memory_context: list[dict[str, Any]] = []
    walls: list[str] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info("Logic Engine service started")
    yield


app = FastAPI(title="Oasis Logic Engine Service", lifespan=lifespan)


@app.post("/internal/reason")
async def reason(req: ReasonRequest):
    graph = ReasoningGraph(**req.reasoning_graph)
    decision = await engine.reason(
        graph,
        req.memory_context,
        memory_stale_hint=req.memory_stale_hint,
    )
    return {
        "decision_tree": decision.model_dump(mode="json"),
        "confidence": decision.confidence,
    }


@app.post("/internal/validate-goal")
async def validate_goal(req: ValidateGoalRequest):
    """Validate whether the goal in a task graph is met (Observer Agent)."""
    graph = ReasoningGraph(**req.task_graph)
    result = await engine.validate_goal(
        graph,
        success_criteria=req.success_criteria,
        plan_steps=req.plan_steps,
        memory_context=req.memory_context,
        rules=req.rules,
        memory_stale_hint=req.memory_stale_hint,
        validated_thoughts=req.validated_thoughts,
        proposed_final_answer=req.proposed_final_answer,
    )
    return result.model_dump(mode="json")


@app.post("/internal/reason/validate-thoughts")
async def validate_thoughts(req: ValidateThoughtsRequest):
    result = engine.validate_thoughts(
        req.thoughts,
        memory_context=req.memory_context,
        rules=req.rules,
        walls_hit=req.walls_hit,
        tool_results=req.tool_results,
    )
    return result

@app.post("/internal/assess-feasibility")
async def assess_feasibility(req: AssessFeasibilityRequest):
    """Assess whether a task is achievable based on memory and walls."""
    result = engine.assess_feasibility(
        user_goal=req.user_goal,
        memory_context=req.memory_context,
        walls=req.walls,
    )
    return result


@app.get("/health")
async def health():
    return {"status": "ok", "service": "logic-engine"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)
