"""Tests for the unified LLM client."""

from unittest.mock import patch
import json

import pytest

from packages.shared_utils.config import (
    DEFAULT_LEYLINE_BASE_URL,
    Settings,
    _load_active_project_overrides,
)
from packages.shared_utils.llm_client import LLMClient


@pytest.fixture
def anthropic_settings():
    return Settings(
        llm_provider="anthropic",
        llm_routing_provider="direct",
        anthropic_api_key="test-key",
        llm_model="claude-sonnet-4-20250514",
    )


@pytest.fixture
def openai_settings():
    return Settings(
        llm_provider="openai",
        llm_routing_provider="direct",
        openai_api_key="test-key",
        llm_model="gpt-4o",
    )


@pytest.fixture
def openai_custom_base_settings():
    return Settings(
        llm_provider="openai",
        llm_routing_provider="direct",
        openai_api_key="test-key",
        openai_base_url="http://localhost:11434/v1",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_settings():
    return Settings(
        llm_provider="ollama",
        llm_routing_provider="direct",
        ollama_host="http://localhost:11434",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_custom_host_settings():
    return Settings(
        llm_provider="ollama",
        llm_routing_provider="direct",
        ollama_host="http://gpu-server:11434",
        llm_model="mistral",
    )


def test_provider_selection_anthropic(anthropic_settings):
    client = LLMClient(anthropic_settings)
    assert client.provider == "anthropic"


def test_provider_selection_openai(openai_settings):
    client = LLMClient(openai_settings)
    assert client.provider == "openai"


def test_provider_selection_ollama(ollama_settings):
    client = LLMClient(ollama_settings)
    assert client.provider == "ollama"


def test_leyline_routes_any_provider_through_openai():
    settings = Settings(
        _env_file=None,
        llm_provider="ollama",
        llm_model="qwen3:8b",
        leyline_base_url="http://host.docker.internal:3417/",
        leyline_max_budget_usd=0.25,
        leyline_daily_budget_usd=5.0,
    )
    client = LLMClient(settings)
    assert client.provider == "openai"
    assert client._effective_openai_base_url() == "http://host.docker.internal:3417"
    assert client._leyline_budget_headers() == {
        "X-Leyline-Max-Budget-USD": "0.25",
        "X-Leyline-Daily-Budget-USD": "5.0",
    }


def test_leyline_is_default_but_direct_provider_can_be_pinned():
    leyline = LLMClient(Settings(_env_file=None, llm_provider="anthropic"))
    assert leyline.provider == "openai"

    direct = LLMClient(Settings(
        _env_file=None,
        llm_provider="anthropic",
        llm_routing_provider="direct",
    ))
    assert direct.provider == "anthropic"


def test_leyline_provider_and_model_override():
    client = LLMClient(Settings(
        _env_file=None,
        leyline_provider="anthropic",
        leyline_model="claude-sonnet",
    ))
    assert client._leyline_budget_headers() == {"X-Leyline-Provider": "anthropic"}
    assert client._effective_model(None) == "claude-sonnet"


def test_settings_has_configurable_leyline_default():
    settings = Settings(_env_file=None)
    assert settings.leyline_base_url == DEFAULT_LEYLINE_BASE_URL
    assert LLMClient(settings).provider == "openai"


def test_blank_leyline_budgets_emit_no_headers():
    settings = Settings(
        _env_file=None,
        leyline_base_url="http://host.docker.internal:3417/v1",
        leyline_max_budget_usd=0,
        leyline_daily_budget_usd=0,
    )
    assert LLMClient(settings)._leyline_budget_headers() == {}


def test_without_leyline_preserves_direct_provider(openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    assert client.provider == "openai"
    assert client._effective_openai_base_url() == "http://localhost:11434/v1"
    assert client._leyline_budget_headers() == {}


@patch("packages.shared_utils.llm_client.LLMClient._call_anthropic", return_value="mocked response")
def test_chat_routes_to_anthropic(mock_call, anthropic_settings):
    client = LLMClient(anthropic_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "mocked response"
    mock_call.assert_called_once()


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="mocked openai response")
def test_chat_routes_to_openai(mock_call, openai_settings):
    client = LLMClient(openai_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "mocked openai response"
    mock_call.assert_called_once()


@patch("packages.shared_utils.llm_client.LLMClient._call_openai_vision", return_value="vision ok")
def test_chat_with_images_routes_to_openai(mock_vision, openai_settings):
    client = LLMClient(openai_settings)
    result = client.chat_with_images(
        system="sys",
        user_message="what is this",
        images=["Zm9v"],  # raw base64 fragment; only routing is under test
        model="gpt-4o",
    )
    assert result == "vision ok"
    mock_vision.assert_called_once()


@patch("packages.shared_utils.llm_client.LLMClient._call_ollama", return_value="ollama response")
def test_chat_routes_to_ollama(mock_call, ollama_settings):
    client = LLMClient(ollama_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "ollama response"
    mock_call.assert_called_once_with("sys", "hello", "llama3", 512, None)


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="local model response")
def test_chat_with_custom_base_url(mock_call, openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "local model response"
    mock_call.assert_called_once_with("sys", "hello", "llama3", 512, None)


def test_active_project_overrides_use_oasis_host_home(tmp_path, monkeypatch):
    project_id = "project-host-home"
    project_dir = tmp_path / ".oasis" / "projects" / project_id
    project_dir.mkdir(parents=True)
    (tmp_path / ".oasis" / "active-project.json").write_text(
        json.dumps({"project_id": project_id}), encoding="utf-8"
    )
    (project_dir / "settings.json").write_text(
        json.dumps({"llm_model": "host-model", "context_window": 12345}),
        encoding="utf-8",
    )
    monkeypatch.setenv("OASIS_HOST_HOME", str(tmp_path))
    # LLM settings never leak from project persistence.
    assert _load_active_project_overrides() == {}


def test_openai_custom_base_url_stored(openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    assert client._settings.openai_base_url == "http://localhost:11434/v1"
    assert client._settings.llm_model == "llama3"


def test_ollama_custom_host(ollama_custom_host_settings):
    client = LLMClient(ollama_custom_host_settings)
    assert client._settings.ollama_host == "http://gpu-server:11434"
    assert client._settings.llm_model == "mistral"
