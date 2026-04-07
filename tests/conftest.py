"""Shared test fixtures."""

import sys
from pathlib import Path

import pytest

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from packages.shared_utils.config import Settings


@pytest.fixture
def settings():
    return Settings(
        llm_provider="ollama",
        llm_model="qwen3:8b",
        neo4j_uri="bolt://localhost:7687",
        neo4j_user="neo4j",
        neo4j_password="oasis-cognition",
    )
