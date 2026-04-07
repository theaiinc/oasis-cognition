"""OpenAI-compatible adapter for Oasis Cognition.

Exposes /v1/chat/completions and /v1/models so that Open WebUI
(or any OpenAI-compatible client) can talk to the Oasis reasoning pipeline.

Also logs every interaction to Langfuse for observability.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

OASIS_API_URL = os.getenv("OASIS_API_URL", "http://localhost:8000")
LANGFUSE_ENABLED = os.getenv("LANGFUSE_ENABLED", "true").lower() == "true"
LANGFUSE_HOST = os.getenv("LANGFUSE_HOST", "http://localhost:3100")
LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")

# Langfuse client (lazy init)
_langfuse = None


def get_langfuse():
    global _langfuse
    if _langfuse is None and LANGFUSE_ENABLED:
        try:
            from langfuse import Langfuse
            _langfuse = Langfuse(
                public_key=LANGFUSE_PUBLIC_KEY,
                secret_key=LANGFUSE_SECRET_KEY,
                host=LANGFUSE_HOST,
            )
            logger.info("Langfuse tracing enabled at %s", LANGFUSE_HOST)
        except Exception as e:
            logger.warning("Langfuse unavailable: %s", e)
    return _langfuse


# --- Models ---

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "oasis-cognition"
    messages: list[ChatMessage]
    stream: bool = False
    temperature: float = 0.7
    max_tokens: int | None = None


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChoiceMessage(BaseModel):
    role: str = "assistant"
    content: str


class Choice(BaseModel):
    index: int = 0
    message: ChoiceMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str = "oasis-cognition"
    choices: list[Choice]
    usage: Usage = Field(default_factory=Usage)


class StreamDelta(BaseModel):
    role: str | None = None
    content: str | None = None


class StreamChoice(BaseModel):
    index: int = 0
    delta: StreamDelta
    finish_reason: str | None = None


class StreamChunk(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    created: int
    model: str = "oasis-cognition"
    choices: list[StreamChoice]


# --- App ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(name)s | %(levelname)s | %(message)s")
    logger.info("OpenAI Adapter started (oasis_api=%s)", OASIS_API_URL)
    get_langfuse()
    yield
    lf = get_langfuse()
    if lf:
        lf.flush()


app = FastAPI(title="Oasis OpenAI Adapter", lifespan=lifespan)


def _extract_user_message(messages: list[ChatMessage]) -> str:
    """Extract the last user message from the conversation."""
    for msg in reversed(messages):
        if msg.role == "user":
            return msg.content
    return messages[-1].content if messages else ""


def _build_context(messages: list[ChatMessage]) -> dict[str, Any]:
    """Build context from conversation history."""
    history = []
    for msg in messages[:-1]:
        history.append({"role": msg.role, "content": msg.content})
    return {"conversation_history": history} if history else {}


def _parse_ndjson_interaction(text: str) -> dict[str, Any]:
    """Gateway streams NDJSON: keepalive lines and one final response object."""
    last: dict[str, Any] | None = None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            continue
        if obj.get("_oasis_keepalive"):
            continue
        if obj.get("_oasis_error"):
            body = obj.get("body") or {}
            if isinstance(body, dict):
                detail = body.get("detail", body.get("error", json.dumps(body)))
            else:
                detail = str(body)
            raise RuntimeError(str(detail))
        last = obj
    if not last:
        raise RuntimeError("empty interaction response")
    return last


async def _call_oasis(user_message: str, context: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Call the Oasis API gateway (NDJSON stream with keepalives for long tool runs)."""
    timeout = httpx.Timeout(connect=30.0, read=3600.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{OASIS_API_URL}/api/v1/interaction",
            json={
                "user_message": user_message,
                "session_id": session_id,
                "context": context,
            },
        )
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "ndjson" not in ct:
            return resp.json()
        return _parse_ndjson_interaction(resp.text)


def _trace_to_langfuse(
    session_id: str,
    user_message: str,
    oasis_response: dict[str, Any],
    latency_ms: float,
):
    """Log the full interaction to Langfuse."""
    lf = get_langfuse()
    if not lf:
        return

    try:
        trace = lf.trace(
            name="oasis-interaction",
            session_id=session_id,
            input=user_message,
            output=oasis_response.get("response", ""),
            metadata={
                "confidence": oasis_response.get("confidence", 0),
                "reasoning_trace": oasis_response.get("reasoning_trace", []),
                "latency_ms": latency_ms,
            },
        )

        # Log reasoning steps as spans
        reasoning_trace = oasis_response.get("reasoning_trace", [])
        for i, step in enumerate(reasoning_trace):
            trace.span(
                name=f"reasoning-step-{i}",
                input=step,
                metadata={"step_index": i},
            )

        # Log the reasoning graph summary
        graph = oasis_response.get("reasoning_graph", {})
        if graph:
            trace.span(
                name="reasoning-graph",
                input=json.dumps({
                    "node_count": len(graph.get("nodes", [])),
                    "edge_count": len(graph.get("edges", [])),
                }),
                metadata={"graph_id": graph.get("id", "")},
            )

        # Log as a generation for cost/token tracking
        trace.generation(
            name="oasis-response",
            model="oasis-cognition",
            input=user_message,
            output=oasis_response.get("response", ""),
            metadata={"confidence": oasis_response.get("confidence", 0)},
        )

    except Exception as e:
        logger.warning("Langfuse trace failed: %s", e)


# --- Endpoints ---

@app.get("/v1/models")
async def list_models():
    """List available models (OpenAI-compatible)."""
    return {
        "object": "list",
        "data": [
            {
                "id": "oasis-cognition",
                "object": "model",
                "created": 1700000000,
                "owned_by": "oasis",
            },
            {
                "id": "oasis-reasoning",
                "object": "model",
                "created": 1700000000,
                "owned_by": "oasis",
            },
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """OpenAI-compatible chat completions endpoint."""
    user_message = _extract_user_message(req.messages)
    context = _build_context(req.messages)
    session_id = str(uuid.uuid4())

    logger.info("Chat request: model=%s, message=%s...", req.model, user_message[:80])

    start = time.time()

    try:
        oasis_resp = await _call_oasis(user_message, context, session_id)
    except httpx.HTTPStatusError as e:
        error_detail = e.response.text if e.response else str(e)
        logger.error("Oasis API error: %s", error_detail)
        oasis_resp = {
            "response": f"I encountered an error processing your request. Details: {error_detail}",
            "confidence": 0,
            "reasoning_trace": [],
            "reasoning_graph": {},
            "session_id": session_id,
        }
    except Exception as e:
        logger.error("Oasis API unreachable: %s", e)
        oasis_resp = {
            "response": "The reasoning engine is currently unavailable. Please try again.",
            "confidence": 0,
            "reasoning_trace": [],
            "reasoning_graph": {},
            "session_id": session_id,
        }

    latency_ms = (time.time() - start) * 1000
    response_text = oasis_resp.get("response", "No response generated.")

    # Append reasoning metadata as a note
    confidence = oasis_resp.get("confidence", 0)
    reasoning_trace = oasis_resp.get("reasoning_trace", [])
    if reasoning_trace and confidence > 0:
        trace_summary = "\n".join(f"  {step}" for step in reasoning_trace[-3:])
        response_text += f"\n\n---\nConfidence: {confidence:.0%} | Session: {session_id}\nReasoning:\n{trace_summary}"

    # Log to Langfuse
    _trace_to_langfuse(session_id, user_message, oasis_resp, latency_ms)

    if req.stream:
        return _stream_response(response_text, session_id)

    return ChatCompletionResponse(
        model=req.model,
        choices=[
            Choice(message=ChoiceMessage(content=response_text))
        ],
        usage=Usage(
            prompt_tokens=len(user_message.split()),
            completion_tokens=len(response_text.split()),
            total_tokens=len(user_message.split()) + len(response_text.split()),
        ),
    )


def _stream_response(text: str, session_id: str):
    """Stream the response in SSE format (OpenAI-compatible)."""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())

    async def generate():
        # First chunk with role
        first = StreamChunk(
            id=chunk_id,
            created=created,
            choices=[StreamChoice(delta=StreamDelta(role="assistant"))],
        )
        yield f"data: {first.model_dump_json()}\n\n"

        # Stream text in chunks
        words = text.split(" ")
        for i in range(0, len(words), 3):
            chunk_text = " ".join(words[i:i + 3])
            if i > 0:
                chunk_text = " " + chunk_text
            chunk = StreamChunk(
                id=chunk_id,
                created=created,
                choices=[StreamChoice(delta=StreamDelta(content=chunk_text))],
            )
            yield f"data: {chunk.model_dump_json()}\n\n"

        # Final chunk
        final = StreamChunk(
            id=chunk_id,
            created=created,
            choices=[StreamChoice(delta=StreamDelta(), finish_reason="stop")],
        )
        yield f"data: {final.model_dump_json()}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "openai-adapter"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
