"""Teaching microservice — validates user assertions with web search and clarifying questions."""

from __future__ import annotations

import logging
import sys
import os
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any

from packages.shared_utils.config import get_settings
from packages.shared_utils.llm_client import LLMClient
from packages.shared_utils.logging import setup_logging
from services.teaching_service.service import TeachingService

logger = logging.getLogger(__name__)

_settings = get_settings()
_llm = LLMClient(_settings)
teaching = TeachingService(_settings, _llm)


class ValidateRequest(BaseModel):
    user_message: str
    semantic_structure: dict[str, Any] | None = None


class ContinueRequest(BaseModel):
    user_message: str
    assertion: dict[str, Any]
    search_query: str = ""
    prior_validation: dict[str, Any] | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info("Teaching service started (provider=%s, model=%s)", _settings.llm_provider, _settings.llm_model)
    yield


app = FastAPI(title="Oasis Teaching Service", lifespan=lifespan)


@app.post("/internal/teaching/validate")
async def validate_teaching(req: ValidateRequest):
    """Extract assertion from user message, search web, validate, return questions."""
    result = await teaching.extract_assertion(req.user_message, req.semantic_structure)
    # Be defensive in case extract_assertion ever changes its return shape.
    if isinstance(result, tuple) and len(result) >= 2:
        assertion, search_query = result[0], result[1]
    else:
        # Fallback: treat the whole result as the assertion and default search_query.
        from packages.reasoning_schema.models import TeachingAssertion

        if isinstance(result, TeachingAssertion):
            assertion = result
            search_query = result.assertion
        else:
            assertion = TeachingAssertion(assertion=str(result or req.user_message))
            search_query = assertion.assertion

    validation = await teaching.validate(assertion, search_query)

    return {
        "assertion": assertion.model_dump(),
        "search_query": search_query,
        "validation": validation.model_dump(),
    }

@app.post("/internal/teaching/continue")
async def continue_teaching(req: ContinueRequest):
    """Continue a pending teaching flow after user clarifies."""
    from packages.reasoning_schema.models import TeachingAssertion

    assertion = TeachingAssertion(**req.assertion)
    refined, search_query, validation = await teaching.continue_from_clarification(
        assertion=assertion,
        search_query=req.search_query,
        user_clarification=req.user_message,
        prior_validation=req.prior_validation,
    )
    return {
        "assertion": refined.model_dump(),
        "search_query": search_query,
        "validation": validation.model_dump(),
    }


@app.get("/health")
async def health():
    return {"status": "ok", "service": "teaching-service"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8006)
