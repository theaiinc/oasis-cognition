"""Observer Agent microservice — validates goal completion for tool_use.

Holds the task graph, updates it with tool results, and uses the logic engine
(Brain) to validate whether the goal is met. Returns feedback for the
Execution Agent when the goal is not yet complete.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

from packages.reasoning_schema.models import SemanticStructure
from packages.shared_utils.logging import setup_logging

logger = logging.getLogger(__name__)

GRAPH_BUILDER_URL = os.getenv("GRAPH_BUILDER_URL", "http://localhost:8002")
LOGIC_ENGINE_URL = os.getenv("LOGIC_ENGINE_URL", "http://localhost:8003")

# Per-hop timeout for graph-builder / logic-engine. Large task_graph JSON or slow hosts can exceed 30s.
_obs_http = float(os.getenv("OBSERVER_HTTP_TIMEOUT_SECONDS", "120"))
_obs_connect = float(os.getenv("OBSERVER_HTTP_CONNECT_TIMEOUT_SECONDS", "15"))
HTTPX_TIMEOUT = httpx.Timeout(_obs_http, connect=_obs_connect)


class ValidateRequest(BaseModel):
    user_goal: str
    semantic_structure: dict[str, Any] | None = None
    task_graph: dict[str, Any] | None = None
    tool_results: list[dict[str, Any]] = []
    plan: dict[str, Any] | None = None
    session_id: str = ""
    memory_context: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []
    memory_stale_hint: str | None = None
    validated_thoughts: list[dict[str, Any]] = []
    proposed_final_answer: str | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(os.getenv("OASIS_LOG_LEVEL", "INFO"))
    logger.info("Observer service started")
    yield


app = FastAPI(title="Oasis Observer Service", lifespan=lifespan)


@app.post("/internal/observer/validate")
async def validate(req: ValidateRequest) -> dict[str, Any]:
    """Validate whether the goal is met. Updates task graph and returns goal_met, feedback."""
    semantic_dict = req.semantic_structure or {
        "problem": req.user_goal,
        "raw_input": req.user_goal,
        "intent": "",
        "route": "tool_use",
    }
    plan = req.plan or {}
    plan_steps = plan.get("steps", [])
    if plan_steps and isinstance(plan_steps[0], str):
        plan_steps = [{"step_index": i, "description": s} for i, s in enumerate(plan_steps)]
    success_criteria = plan.get("success_criteria", [])

    semantic = SemanticStructure(**semantic_dict)
    existing_graph = req.task_graph
    tool_results = req.tool_results or []

    # 1. Build/update task graph via graph-builder
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            build_res = await client.post(
                f"{GRAPH_BUILDER_URL}/internal/graph/build-task",
                json={
                    "semantic_structure": semantic_dict,
                    "plan_steps": plan_steps,
                    "session_id": req.session_id,
                    "tool_results": tool_results,
                    "existing_graph": existing_graph,
                },
            )
            build_res.raise_for_status()
            task_graph = build_res.json().get("task_graph", {})
    except Exception as e:
        logger.warning("Graph builder call failed: %s — using minimal graph", e)
        task_graph = existing_graph or {
            "session_id": req.session_id,
            "nodes": [],
            "edges": [],
        }

    # 2. Validate goal via logic-engine (with memory + rules for grounded validation)
    try:
        async with httpx.AsyncClient(timeout=HTTPX_TIMEOUT) as client:
            validate_res = await client.post(
                f"{LOGIC_ENGINE_URL}/internal/validate-goal",
                json={
                    "task_graph": task_graph,
                    "success_criteria": success_criteria if success_criteria else None,
                    "plan_steps": plan_steps if plan_steps else None,
                    "memory_context": req.memory_context or [],
                    "rules": req.rules or [],
                    "memory_stale_hint": req.memory_stale_hint,
                    "validated_thoughts": req.validated_thoughts,
                    "proposed_final_answer": req.proposed_final_answer,
                },
            )
            validate_res.raise_for_status()
            result = validate_res.json()
            goal_met = result.get("goal_met", False)
            feedback = result.get("feedback", "")
            
            # 3. Detect overthinking: if thoughts exist but no tools were used in this round
            # or if the agent keeps thinking without acting.
            has_new_tools = len(tool_results) > 0
            has_thoughts = len(req.validated_thoughts) > 0
            
            if not goal_met and has_thoughts and not has_new_tools:
                logger.warning("Overthinking detected: thoughts present but no tool actions taken.")
                if feedback:
                    feedback = (
                        f"OVERTHINKING DETECTED. {feedback} You MUST take a concrete tool action "
                        "(grep, read_file, list_dir, or — if the goal requires code changes — create_worktree / apply_patch / edit_file) "
                        "in the next step. Do not just reason."
                    )
                else:
                    feedback = (
                        "OVERTHINKING DETECTED. You have generated thoughts but taken no action. "
                        "You MUST call a tool (e.g., grep or read_file) to progress, "
                        "or start implementation (create_worktree) if exploration is done. "
                        "Actions speak louder than thoughts."
                    )

            return {
                "goal_met": goal_met,
                "feedback": feedback,
                "confidence": result.get("confidence", 0.0),
                "updated_graph": result.get("updated_graph", task_graph),
                "revise_plan": bool(result.get("revise_plan", False)),
            }
    except Exception as e:
        logger.warning("Logic engine validate failed: %s — defaulting to not met", e)
        return {
            "goal_met": False,
            "feedback": "Validation unavailable. Continue working on the task.",
            "confidence": 0.0,
            "updated_graph": task_graph,
            "revise_plan": False,
        }


@app.get("/health")
async def health():
    return {"status": "ok", "service": "observer"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8009)
