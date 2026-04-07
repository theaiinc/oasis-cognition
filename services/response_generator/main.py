"""Response Generator microservice — POST /internal/response/generate"""

from __future__ import annotations

import logging
import sys
import os
import uuid
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any

from packages.reasoning_schema.models import DecisionTree
from packages.shared_utils.config import get_settings, Settings
from packages.shared_utils.llm_client import LLMClient
from packages.shared_utils.logging import setup_logging
from packages.shared_utils.task_queue import RequestQueue
from services.response_generator.service import ResponseGeneratorService

logger = logging.getLogger(__name__)


def _tool_plan_raw_log_preview(raw: str, limit: int = 400) -> str:
    """One-line preview for logs (docker grep); not a security boundary — avoid logging secrets."""
    s = (raw or "").replace("\r", " ").replace("\n", " ")
    s = " ".join(s.split())
    if len(s) > limit:
        return s[:limit] + "…"
    return s

_settings = get_settings()
_response_settings = Settings(
    llm_provider=_settings.response_llm_provider,
    llm_model=_settings.response_llm_model,
    llm_max_tokens=_settings.llm_max_tokens,
    anthropic_api_key=_settings.anthropic_api_key,
    openai_api_key=_settings.openai_api_key,
    openai_base_url=_settings.openai_base_url,
    ollama_host=_settings.ollama_host,
    vision_llm_model=_settings.vision_llm_model,
)
_llm = LLMClient(_response_settings)

_tool_plan_settings = Settings(
    llm_provider=_settings.tool_plan_llm_provider,
    llm_model=_settings.tool_plan_llm_model,
    llm_max_tokens=_settings.llm_max_tokens,
    anthropic_api_key=_settings.anthropic_api_key,
    openai_api_key=_settings.openai_api_key,
    openai_base_url=_settings.openai_base_url,
    ollama_host=_settings.ollama_host,
)
_tool_plan_llm = LLMClient(_tool_plan_settings)

generator = ResponseGeneratorService(_response_settings, _llm, tool_plan_llm=_tool_plan_llm)

# ── LLM Request Queue ─────────────────────────────────────────────────
# Local LLM (llama.cpp / Bonsai) can only handle one request well at a time.
# Queue is enabled when OASIS_LLM_QUEUE_ENABLED=true (default: auto-detect
# based on provider — enabled for "openai" with localhost base URL, disabled
# for cloud APIs that handle concurrency themselves).
_llm_concurrency = int(os.environ.get("OASIS_LLM_CONCURRENCY", "1"))

def _should_enable_queue() -> bool:
    """Auto-detect whether LLM queue should be enabled."""
    explicit = os.environ.get("OASIS_LLM_QUEUE_ENABLED", "").lower()
    if explicit in ("true", "1", "yes"):
        return True
    if explicit in ("false", "0", "no"):
        return False
    # Auto: enable for local endpoints (localhost / host.docker.internal)
    base_url = (_settings.openai_base_url or "").lower()
    return any(host in base_url for host in ("localhost", "127.0.0.1", "host.docker.internal", "0.0.0.0"))

_llm_queue_enabled = _should_enable_queue()
_llm_queue: RequestQueue[Any] | None = RequestQueue(name="llm", concurrency=_llm_concurrency) if _llm_queue_enabled else None


async def _execute_llm_task(payload: dict[str, Any]) -> Any:
    """Execute a single LLM task from the queue."""
    import asyncio as _asyncio
    fn = payload["fn"]
    args = payload.get("args", ())
    kwargs = payload.get("kwargs", {})
    if _asyncio.iscoroutinefunction(fn):
        return await fn(*args, **kwargs)
    else:
        return await _asyncio.to_thread(fn, *args, **kwargs)


async def queued_call(fn, *args, **kwargs) -> Any:
    """Submit an LLM call through the request queue (if enabled) or call directly."""
    if _llm_queue is not None:
        request_id = str(uuid.uuid4())[:8]
        return await _llm_queue.submit(request_id, {"fn": fn, "args": args, "kwargs": kwargs})
    else:
        # No queue — call directly
        import asyncio as _asyncio
        if _asyncio.iscoroutinefunction(fn):
            return await fn(*args, **kwargs)
        else:
            return await _asyncio.to_thread(fn, *args, **kwargs)


class GenerateRequest(BaseModel):
    decision_tree: dict[str, Any]
    user_message: str | None = None
    context: dict[str, Any] | None = None
    chat_history: list[dict[str, str]] | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info(
        "Response Generator started (provider=%s, model=%s, vision=%s)",
        _response_settings.llm_provider,
        _response_settings.llm_model,
        _response_settings.vision_llm_model or "(default)",
    )
    logger.info(
        "Tool-plan model (provider=%s, model=%s)",
        _tool_plan_settings.llm_provider,
        _tool_plan_settings.llm_model,
    )
    if _llm_queue is not None:
        logger.info("LLM request queue ENABLED (concurrency=%d, local LLM detected)", _llm_concurrency)
        await _llm_queue.start(_execute_llm_task)
    else:
        logger.info("LLM request queue DISABLED (cloud API or explicitly off)")
    yield
    if _llm_queue is not None:
        await _llm_queue.stop()


app = FastAPI(title="Oasis Response Generator Service", lifespan=lifespan)


class ChatRequest(BaseModel):
    user_message: str
    context: dict[str, Any] | None = None
    chat_history: list[dict[str, str]] | None = None


@app.post("/internal/response/generate")
async def generate_response(req: GenerateRequest):
    decision = DecisionTree(**req.decision_tree)
    text = await queued_call(generator.format_response, decision, context=req.context, user_message=req.user_message, chat_history=req.chat_history)
    return {"response_text": text}


@app.post("/internal/response/generate-stream")
async def generate_response_stream(req: GenerateRequest):
    decision = DecisionTree(**req.decision_tree)
    def generate():
        for chunk in generator.stream_format_response(decision, context=req.context, user_message=req.user_message, chat_history=req.chat_history):
            yield chunk
    return StreamingResponse(generate(), media_type="text/plain")


@app.post("/internal/response/chat")
async def casual_chat(req: ChatRequest):
    try:
        text = await queued_call(generator.casual_response, req.user_message, context=req.context, chat_history=req.chat_history)
        return {"response_text": text}
    except Exception as e:
        logger.warning("Casual response failed (e.g. Ollama unavailable): %s", e)
        return {"response_text": "I'm having trouble with the language model right now. Please try again in a moment or switch to a reasoning query."}


@app.post("/internal/response/chat-stream")
async def casual_chat_stream(req: ChatRequest):
    def generate():
        try:
            for chunk in generator.stream_casual_response(req.user_message, context=req.context, chat_history=req.chat_history):
                yield chunk
        except Exception as e:
            logger.warning("Casual stream failed: %s", e)
            yield "I'm having trouble with the language model right now."
    return StreamingResponse(generate(), media_type="text/plain")


class ToolPlanRequest(BaseModel):
    user_message: str
    tool_results: list[dict[str, Any]] | None = None
    chat_history: list[dict[str, str]] | None = None
    upfront_plan: dict[str, Any] | None = None
    active_step_index: int | None = None
    active_step_description: str | None = None
    observer_feedback: str | None = None
    knowledge_summary: str | None = None
    memory_context: list[dict[str, Any]] | None = None
    rules: list[dict[str, Any]] | None = None
    memory_stale_hint: str | None = None
    walls_hit: list[str] | None = None  # wall/aha moments from this session — do NOT retry
    task_graph: dict[str, Any] | None = None  # current task graph for context
    validated_thoughts: list[dict[str, Any]] | None = None
    free_thoughts: str | None = None
    active_worktree_id: str | None = None  # session's active worktree — prevents duplicate creates
    tool_history_digest: list[str] | None = None  # compact one-liner per successful call from ALL toolResults
    artifact_search_results: list[dict[str, Any]] | None = None
    artifact_context: str | None = None

class ThoughtGenerateRequest(BaseModel):
    user_message: str
    tool_results: list[dict[str, Any]] | None = None
    upfront_plan: dict[str, Any] | None = None
    memory_context: list[dict[str, Any]] | None = None
    rules: list[dict[str, Any]] | None = None
    walls_hit: list[str] | None = None
    observer_feedback: str | None = None

class SelfTeachingPlanRequest(BaseModel):
    topic: str
    llm_thoughts: list[dict[str, Any]] = []
    logic_solution: dict[str, Any] = {}
    user_comment: str | None = None
    prior_plan: dict[str, Any] | None = None

class PlanToolUseRequest(BaseModel):
    user_message: str
    semantic_structure: dict[str, Any] | None = None
    memory_context: list[dict[str, Any]] | None = None
    rules: list[dict[str, Any]] | None = None
    memory_stale_hint: str | None = None
    free_thoughts: str | None = None
    observer_feedback: str | None = None
    previous_plan: dict[str, Any] | None = None
    replan_after_observer: bool = False
    artifact_search_results: list[dict[str, Any]] | None = None
    artifact_context: str | None = None


class ToolSummarizeRequest(BaseModel):
    user_message: str
    tool_results: list[dict[str, Any]]


class ThoughtReasonRequest(BaseModel):
    user_message: str
    context: dict[str, Any] | None = None
    chat_history: list[dict[str, str]] | None = None
    tool_results: list[dict[str, Any]] | None = None
    observer_feedback: str | None = None


class JsonRepairRequest(BaseModel):
    malformed_json: str


@app.post("/internal/response/tool-plan")
async def tool_plan(req: ToolPlanRequest):
    """Plan the next tool call or produce a final answer."""
    try:
        result = await queued_call(
            generator.plan_tool_calls,
            req.user_message,
            tool_results=req.tool_results,
            chat_history=req.chat_history,
            upfront_plan=req.upfront_plan,
            active_step_index=req.active_step_index,
            active_step_description=req.active_step_description,
            observer_feedback=req.observer_feedback,
            knowledge_summary=req.knowledge_summary,
            memory_context=req.memory_context,
            rules=req.rules,
            memory_stale_hint=req.memory_stale_hint,
            walls_hit=req.walls_hit,
            task_graph=req.task_graph,
            validated_thoughts=req.validated_thoughts,
            free_thoughts=req.free_thoughts,
            active_worktree_id=req.active_worktree_id,
            tool_history_digest=req.tool_history_digest,
        )
        # Attach context budget info so the gateway can relay to the UI
        if generator._last_context_budget:
            result["_context_budget"] = generator._last_context_budget
        return result
    except Exception as e:
        logger.warning("Tool planning failed: %s", e)
        return {"action": "final_answer", "answer": f"I couldn't plan tool calls right now: {e}"}


@app.get("/internal/response/context-budget")
async def get_context_budget():
    """Return the last computed context budget breakdown."""
    return generator._last_context_budget or {"error": "No budget computed yet"}


class ToolPlanParseRawRequest(BaseModel):
    raw: str


@app.post("/internal/response/tool-plan/parse-raw")
async def tool_plan_parse_raw(req: ToolPlanParseRawRequest):
    """Parse streamed (or non-streamed) tool-plan text: flat lines first, then JSON + repair."""
    try:
        plan = await generator.parse_tool_plan_raw(req.raw)
        return {"plan": plan}
    except ValueError as e:
        preview = _tool_plan_raw_log_preview(req.raw)
        logger.info(
            "tool-plan parse-raw rejected: %s | raw_len=%d preview=%s",
            e,
            len(req.raw or ""),
            preview,
        )
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        logger.warning("tool-plan parse-raw failed: %s", e)
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.post("/internal/response/tool-plan-stream")
async def tool_plan_stream(req: ToolPlanRequest):
    """Stream the planning of the next tool call."""
    def generate():
        for chunk in generator.stream_tool_plan(
            req.user_message,
            tool_results=req.tool_results,
            chat_history=req.chat_history,
            upfront_plan=req.upfront_plan,
            active_step_index=req.active_step_index,
            active_step_description=req.active_step_description,
            observer_feedback=req.observer_feedback,
            knowledge_summary=req.knowledge_summary,
            memory_context=req.memory_context,
            rules=req.rules,
            memory_stale_hint=req.memory_stale_hint,
            walls_hit=req.walls_hit,
            task_graph=req.task_graph,
            validated_thoughts=req.validated_thoughts,
            free_thoughts=req.free_thoughts,
            active_worktree_id=req.active_worktree_id,
            tool_history_digest=req.tool_history_digest,
            artifact_search_results=req.artifact_search_results,
            artifact_context=req.artifact_context,
        ):
            yield chunk
    return StreamingResponse(generate(), media_type="text/plain")


class DecisionRequest(BaseModel):
    thoughts: list[dict[str, Any]] | str
    user_message: str
    context: dict[str, Any] | None = None
    memory_context: list[dict[str, Any]] | None = None


@app.post("/internal/decision")
async def make_decision(req: DecisionRequest):
    return await queued_call(
        generator.make_decision,
        thoughts=req.thoughts,
        user_message=req.user_message,
        context=req.context,
        memory_context=req.memory_context,
    )


class PuntCheckRequest(BaseModel):
    user_goal: str
    proposed_answer: str
    has_code_edits: bool = False


@app.post("/internal/response/punt-check")
async def punt_check(req: PuntCheckRequest):
    """Fast LLM check: is the proposed answer actually doing the work, or punting?"""
    return await queued_call(
        generator.check_punt,
        user_goal=req.user_goal,
        proposed_answer=req.proposed_answer,
        has_code_edits=req.has_code_edits,
    )


@app.post("/internal/thought/generate")
async def generate_thoughts(req: ThoughtGenerateRequest):
    """Generate candidate thoughts for the next step."""
    try:
        result = await queued_call(
            generator.generate_thoughts,
            req.user_message,
            tool_results=req.tool_results,
            upfront_plan=req.upfront_plan,
            memory_context=req.memory_context,
            rules=req.rules,
            walls_hit=req.walls_hit,
            observer_feedback=req.observer_feedback,
        )
        return result
    except Exception as e:
        logger.warning("Thought generation failed: %s", e)
        return {"thoughts": []}


@app.post("/internal/self-teaching/plan")
async def self_teaching_plan(req: SelfTeachingPlanRequest):
    """Propose a teaching plan (training material + rule actions) for self-teaching."""
    try:
        return await queued_call(
            generator.propose_self_teaching_plan,
            topic=req.topic,
            llm_thoughts=req.llm_thoughts,
            logic_solution=req.logic_solution,
            user_comment=req.user_comment,
            prior_plan=req.prior_plan,
        )
    except Exception as e:
        logger.warning("Self-teaching plan generation failed: %s", e)
        return {
            "teaching_material": "",
            "achievement_flow": "",
            "subtopics": [],
            "teaching_paths": [],
            "rule_actions": [],
        }


from fastapi.responses import StreamingResponse

@app.post("/internal/thought/reason-stream")
async def reasoning_layer_stream(req: ThoughtReasonRequest):
    """Stream a free-form reasoning thought trace (Free Thoughts)."""
    def generate():
        for chunk in generator.stream_free_thoughts(
            req.user_message,
            context=req.context,
            chat_history=req.chat_history,
            tool_results=req.tool_results,
            observer_feedback=req.observer_feedback,
        ):
            yield chunk

    return StreamingResponse(generate(), media_type="text/plain")


@app.post("/internal/thought/reason")
async def reasoning_layer(req: ThoughtReasonRequest):
    """Generate a free-form reasoning thought trace (Free Thoughts)."""
    try:
        text = await queued_call(
            generator.generate_free_thoughts,
            req.user_message,
            context=req.context,
            chat_history=req.chat_history,
            tool_results=req.tool_results,
            observer_feedback=req.observer_feedback,
        )
        return {"thoughts": text}
    except Exception as e:
        logger.warning("Reasoning layer failed: %s", e)
        return {"thoughts": "I'm having trouble thinking clearly right now."}


@app.post("/internal/json/repair")
async def repair_json(req: JsonRepairRequest):
    """Attempt to repair a malformed JSON object."""
    result = await queued_call(generator.repair_json, req.malformed_json)
    return result



@app.post("/internal/plan/tool-use")
async def plan_tool_use(req: PlanToolUseRequest):
    """Create upfront plan for tool_use (Planning Agent)."""
    try:
        result = await generator.plan_tool_use(
            req.user_message,
            semantic_structure=req.semantic_structure,
            memory_context=req.memory_context,
            rules=req.rules,
            memory_stale_hint=req.memory_stale_hint,
            free_thoughts=req.free_thoughts,
            observer_feedback=req.observer_feedback,
            previous_plan=req.previous_plan,
            replan_after_observer=req.replan_after_observer,
            artifact_search_results=req.artifact_search_results,
            artifact_context=req.artifact_context,
        )
        return result
    except Exception as e:
        logger.warning("Plan tool use failed: %s", e)
        return {"steps": [{"step_index": 0, "description": "Address the user's request"}], "success_criteria": []}


@app.post("/internal/response/tool-summarize")
async def tool_summarize(req: ToolSummarizeRequest):
    """Summarize tool execution results into natural language."""
    try:
        text = await queued_call(generator.summarize_tool_results, req.user_message, req.tool_results)
        return {"response_text": text}
    except Exception as e:
        logger.warning("Tool summarization failed: %s", e)
        return {"response_text": "I gathered some information but had trouble summarizing it."}


class SummarizeHistoryRequest(BaseModel):
    messages: list[dict[str, str]]  # [{ role, content }, ...]


@app.post("/internal/response/summarize-history")
async def summarize_history(req: SummarizeHistoryRequest):
    """Summarize older conversation messages into a concise summary for context window management."""
    try:
        summary = await queued_call(generator.summarize_history, req.messages)
        return {"summary": summary}
    except Exception as e:
        logger.warning("Summarize history failed: %s", e)
        return {"summary": "[Conversation summary unavailable]"}


class TranscriptCleanupRequest(BaseModel):
    raw_text: str


@app.post("/internal/response/transcript-cleanup")
async def transcript_cleanup(req: TranscriptCleanupRequest):
    cleaned = await queued_call(generator.cleanup_transcript, req.raw_text)
    return {"cleaned_text": cleaned}


@app.get("/internal/response/llm-queue")
async def llm_queue_status():
    """Current LLM request queue state."""
    if _llm_queue is None:
        return {"enabled": False, "message": "Queue disabled (cloud API)"}
    return {"enabled": True, **_llm_queue.status()}


@app.post("/workspace/switch")
async def switch_workspace(body: dict):
    """Switch the active project context.

    Called by the dev-agent when the user switches projects.
    Updates PROJECT_ROOT env so _load_project_context() picks up the new
    .oasis-context.md from the /host-home mount.
    """
    project_path = body.get("project_path") or body.get("workspace_path") or ""
    if not project_path:
        return {"success": False, "error": "project_path is required"}
    os.environ["PROJECT_ROOT"] = project_path
    # Force re-read of project context on next call
    from services.response_generator.service import _force_reload_project_context
    _force_reload_project_context()
    logger.info("Response-generator workspace switched to %s", project_path)
    return {"success": True, "project_root": project_path}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "response-generator"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8005)
