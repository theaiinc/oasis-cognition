"""Application configuration via environment variables.

Supports per-project overrides: when an active project has settings saved
in ~/.oasis/projects/{project_id}/settings.json, those values override
the environment / .env defaults.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

_OASIS_CONFIG_DIR = Path.home() / ".oasis"
_ACTIVE_PROJECT_PATH = _OASIS_CONFIG_DIR / "active-project.json"
_PROJECTS_DIR = _OASIS_CONFIG_DIR / "projects"

# Fields that can be overridden per-project via project settings.
# Maps settings.json key → Settings field name.
PROJECT_OVERRIDABLE_FIELDS: set[str] = {
    "llm_provider",
    "llm_model",
    "llm_max_tokens",
    "openai_api_key",
    "openai_base_url",
    "anthropic_api_key",
    "ollama_host",
    "response_llm_provider",
    "response_llm_model",
    "tool_plan_llm_provider",
    "tool_plan_llm_model",
    "vision_llm_model",
    "computer_use_llm_model",
    "computer_use_llm_base_url",
    "context_window",
    "context_output_reserve",
    "embedding_model",
    "log_level",
}


class Settings(BaseSettings):
    # General
    app_name: str = "oasis-cognition"
    debug: bool = False
    log_level: str = "INFO"

    # LLM provider: "anthropic", "openai", or "ollama"
    llm_provider: str = "ollama"
    llm_model: str = "qwen3:8b"
    llm_max_tokens: int = 40000

    # Anthropic
    anthropic_api_key: str = ""

    # OpenAI (also works with any OpenAI-compatible endpoint)
    openai_api_key: str = ""
    openai_base_url: str = ""

    # Ollama
    ollama_host: str = "http://localhost:11434"

    # Response model (separate from interpreter model)
    response_llm_provider: str = "ollama"
    response_llm_model: str = "qwen3:8b"

    # Tool-plan model (separate for prompt-following / JSON reliability)
    # Used by response_generator to decide the next tool call and generate
    # the exact JSON params (including edit_file strings).
    tool_plan_llm_provider: str = "ollama"
    tool_plan_llm_model: str = "qwen3:8b"

    # Vision (screen-share / multimodal). OpenAI-compatible APIs: same base_url + key as text.
    # Empty: Ollama falls back to llava:13b in response-generator; OpenAI-compatible uses llm_model.
    vision_llm_model: str = ""

    # Computer-Use agent model (planning, sub-steps, observation, coordinate resolution).
    # When set, overrides vision_llm_model for all computer-use calls.
    # Can point to a local model (e.g. "http://localhost:8080/v1" endpoint) or a remote API model name.
    # Empty = uses vision_llm_model (default).
    computer_use_llm_model: str = ""
    # Optional separate base URL for the computer-use model (e.g. a local ScreenAI/CogAgent server).
    # Empty = uses the same base URL as the vision model.
    computer_use_llm_base_url: str = ""

    # Neo4j
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "oasis-cognition"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # Memory: max age (hours) before entries are considered stale — verify against ground truth
    memory_max_age_hours: float = 24.0

    # Context window size (tokens) — total model context; used for budgeting and summarization
    context_window: int = 100000

    # Reserve ratio: fraction of context_window reserved for output tokens (0.0–1.0)
    context_output_reserve: float = 0.4

    # Artifact storage
    artifact_storage_path: str = "/data/artifacts"
    artifact_service_url: str = "http://localhost:8012"

    # Embedding model (MTEB v2 compatible, configurable via env var)
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # GIPFormer (Vietnamese ASR) — native host service URL
    gipformer_service_url: str = "http://localhost:8098"
    gipformer_model_path: str = ""  # legacy, unused — model auto-downloaded by service

    # Transcription service URL (MLX Whisper)
    transcription_service_url: str = "http://localhost:8099"

    # Diarization service URL (FoxNoseTech/diarize — lightweight, CPU-only)
    diarization_service_url: str = "http://localhost:8097"

    # Memory service URL
    memory_service_url: str = "http://localhost:8004"

    # UI parser service URL (optional)
    ui_parser_url: str = "http://localhost:8011"

    # Scoring weights (logic engine)
    weight_evidence: float = 0.4
    weight_memory: float = 0.25
    weight_rule_match: float = 0.25
    weight_contradiction_penalty: float = 0.1

    model_config = {"env_prefix": "OASIS_", "env_file": ".env"}


def _load_active_project_overrides() -> dict[str, Any]:
    """Read the active project's settings and return overridable fields."""
    try:
        if not _ACTIVE_PROJECT_PATH.exists():
            return {}
        active = json.loads(_ACTIVE_PROJECT_PATH.read_text(encoding="utf-8"))
        pid = active.get("project_id")
        if not pid:
            return {}
        settings_path = _PROJECTS_DIR / pid / "settings.json"
        if not settings_path.exists():
            return {}
        project_settings = json.loads(settings_path.read_text(encoding="utf-8"))
        # Only return fields that are in the overridable set and have non-empty values
        overrides = {}
        for key, value in project_settings.items():
            if key in PROJECT_OVERRIDABLE_FIELDS and value not in (None, ""):
                overrides[key] = value
        if overrides:
            logger.info("Applying project overrides for %s: %s", pid, list(overrides.keys()))
        return overrides
    except Exception as e:
        logger.warning("Failed to load project overrides: %s", e)
        return {}


@lru_cache
def get_settings() -> Settings:
    """Build Settings from env/.env, then apply active project overrides."""
    base = Settings()
    overrides = _load_active_project_overrides()
    if overrides:
        # Create a new Settings instance with overrides applied on top
        base_dict = base.model_dump()
        base_dict.update(overrides)
        return Settings(**base_dict)
    return base


def reload_settings() -> Settings:
    """Force-reload settings (e.g. after project activation changes)."""
    get_settings.cache_clear()
    return get_settings()
