"""Interpreter microservice — POST /internal/interpret"""

from __future__ import annotations

import logging
import sys
import os
from contextlib import asynccontextmanager
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI
from pydantic import BaseModel

from packages.shared_utils.config import get_settings
from packages.shared_utils.llm_client import LLMClient
from packages.shared_utils.logging import setup_logging
from services.interpreter.service import InterpreterService

logger = logging.getLogger(__name__)

_settings = get_settings()
_llm = LLMClient(_settings)
interpreter = InterpreterService(_settings, _llm)


class InterpretRequest(BaseModel):
    text: str
    context: dict[str, Any] | None = None
    chat_history: list[dict[str, str]] | None = None  # recent turns for reference resolution


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info("Interpreter service started (provider=%s, model=%s)", _settings.llm_provider, _settings.llm_model)
    yield


app = FastAPI(title="Oasis Interpreter Service", lifespan=lifespan)


@app.post("/internal/interpret")
async def interpret(req: InterpretRequest):
    result = await interpreter.interpret(req.text, context=req.context, chat_history=req.chat_history)
    return {"semantic_structure": result.model_dump()}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "interpreter"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
