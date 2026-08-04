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


def _settings(**kw: object) -> Settings:
    """Create test Settings without .env interference."""
    return Settings(_env_file=None, **kw)  # type: ignore[arg-type]


@pytest.fixture
def anthropic_settings():
    return _settings(
        llm_provider="anthropic",
        llm_routing_provider="direct",
        anthropic_api_key="test-key",
        llm_model="claude-sonnet-4-20250514",
    )


@pytest.fixture
def openai_settings():
    return _settings(
        llm_provider="openai",
        llm_routing_provider="direct",
        openai_api_key="test-key",
        llm_model="gpt-4o",
    )


@pytest.fixture
def openai_custom_base_settings():
    return _settings(
        llm_provider="openai",
        llm_routing_provider="direct",
        openai_api_key="test-key",
        openai_base_url="http://localhost:11434/v1",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_settings():
    return _settings(
        llm_provider="ollama",
        llm_routing_provider="direct",
        ollama_host="http://localhost:11434",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_custom_host_settings():
    return _settings(
        llm_provider="ollama",
        llm_routing_provider="direct",
        ollama_host="http://gpu-server:11434",
        llm_model="mistral",
    )


@pytest.fixture
def leyline_settings():
    return _settings(
        llm_provider="openai",
        openai_api_key="test-key",
        openai_base_url="http://host.docker.internal:1234/v1",
        llm_model="gemma-4-12b-coder",
        leyline_base_url="http://leyline:3000",
    )


@pytest.fixture
def leyline_budget_settings():
    return _settings(
        llm_provider="openai",
        openai_api_key="test-key",
        openai_base_url="http://host.docker.internal:1234/v1",
        llm_model="gemma-4-12b-coder",
        leyline_base_url="http://leyline:3000",
        leyline_max_budget_usd=0.05,
        leyline_daily_budget_usd=2.0,
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


def test_provider_selection_leyline_overrides_to_openai(leyline_settings):
    """When leyline_base_url is set, provider always resolves to 'openai'."""
    client = LLMClient(leyline_settings)
    assert client.provider == "openai"


def test_leyline_base_url_effective(leyline_settings):
    """When leyline_base_url is set, _effective_openai_base_url returns it."""
    client = LLMClient(leyline_settings)
    assert client._effective_openai_base_url() == "http://leyline:3000"


def test_leyline_not_set_falls_back_to_openai_base(openai_custom_base_settings):
    """Without leyline, _effective_openai_base_url returns configured openai_base_url."""
    client = LLMClient(openai_custom_base_settings)
    assert client._effective_openai_base_url() == "http://localhost:11434/v1"


def test_leyline_routing_flag(leyline_settings):
    """_is_routed_via_leyline reflects whether leyline is configured."""
    client = LLMClient(leyline_settings)
    assert client._is_routed_via_leyline() is True


def test_leyline_routing_flag_false(openai_settings):
    """_is_routed_via_leyline is False when leyline is not configured."""
    client = LLMClient(openai_settings)
    assert client._is_routed_via_leyline() is False


def test_leyline_budget_headers_no_budget(leyline_settings):
    """With default (0) budget, no budget headers are produced."""
    client = LLMClient(leyline_settings)
    assert client._leyline_budget_headers() == {}


def test_leyline_budget_headers_with_budget(leyline_budget_settings):
    """Budget headers are populated when max_budget is set."""
    client = LLMClient(leyline_budget_settings)
    hdrs = client._leyline_budget_headers()
    assert hdrs["X-Leyline-Max-Budget-USD"] == "0.05"
    assert hdrs["X-Leyline-Daily-Budget-USD"] == "2.0"


def test_leyline_openai_headers_includes_budget(leyline_budget_settings):
    """_openai_headers includes budget headers when Leyline is active."""
    client = LLMClient(leyline_budget_settings)
    hdrs = client._openai_headers()
    assert hdrs["Authorization"] == "Bearer test-key"
    assert hdrs["Content-Type"] == "application/json"
    assert hdrs["X-Leyline-Max-Budget-USD"] == "0.05"
    assert hdrs["X-Leyline-Daily-Budget-USD"] == "2.0"


def test_leyline_openai_headers_no_budget(leyline_settings):
    """_openai_headers works without budget headers."""
    client = LLMClient(leyline_settings)
    hdrs = client._openai_headers()
    assert hdrs["Authorization"] == "Bearer test-key"
    assert "X-Leyline-Max-Budget-USD" not in hdrs


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="leyline routed")
def test_chat_routes_to_openai_when_leyline_enabled(mock_call, leyline_settings):
    """When leyline is configured, all chat calls route to OpenAI methods."""
    client = LLMClient(leyline_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "leyline routed"
    mock_call.assert_called_once()


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
    mock_call.assert_called_once()


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="local model response")
def test_chat_with_custom_base_url(mock_call, openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "local model response"
    mock_call.assert_called_once()


def test_active_project_overrides_use_oasis_host_home(tmp_path, monkeypatch):
    """settings.json under OASIS_HOST_HOME is read via the host-home path,
    and only overridable fields are applied. LLM overrides (llm_model,
    context_window, etc.) are an intentional feature (the per-project
    Settings panel writes them) — unrelated/unknown keys are still ignored."""
    project_id = "project-host-home"
    project_dir = tmp_path / ".oasis" / "projects" / project_id
    project_dir.mkdir(parents=True)
    (tmp_path / ".oasis" / "active-project.json").write_text(
        json.dumps({"project_id": project_id}), encoding="utf-8"
    )
    (project_dir / "settings.json").write_text(
        json.dumps({"llm_model": "host-model", "context_window": 12345, "not_a_real_field": "x"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("OASIS_HOST_HOME", str(tmp_path))
    overrides = _load_active_project_overrides()
    assert overrides == {"llm_model": "host-model", "context_window": 12345}


def test_openai_custom_base_url_stored(openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    assert client._settings.openai_base_url == "http://localhost:11434/v1"
    assert client._settings.llm_model == "llama3"


def test_ollama_custom_host(ollama_custom_host_settings):
    client = LLMClient(ollama_custom_host_settings)
    assert client._settings.ollama_host == "http://gpu-server:11434"
    assert client._settings.llm_model == "mistral"


# ── Async cancellable method tests ──────────────────────────────────────

@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_openai_async", return_value="async leyline response")
async def test_chat_async_routes_to_openai_when_leyline_enabled(mock_call, leyline_settings):
    """Async chat routes to OpenAI when Leyline is configured."""
    client = LLMClient(leyline_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async leyline response"
    mock_call.assert_called_once()


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_openai_async", return_value="async openai response")
async def test_chat_async_routes_to_openai(mock_call, openai_settings):
    client = LLMClient(openai_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async openai response"
    mock_call.assert_called_once()


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_ollama_async", return_value="async ollama response")
async def test_chat_async_routes_to_ollama(mock_call, ollama_settings):
    client = LLMClient(ollama_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async ollama response"
    mock_call.assert_called_once()


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_anthropic_async", return_value="async claude response")
async def test_chat_async_routes_to_anthropic(mock_call, anthropic_settings):
    client = LLMClient(anthropic_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async claude response"
    mock_call.assert_called_once()


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient.chat_async", return_value='{"key": "value"}')
async def test_chat_json_async(mock_chat, openai_settings):
    client = LLMClient(openai_settings)
    result = await client.chat_json_async(system="sys", user_message="hello")
    assert result == {"key": "value"}


@pytest.mark.asyncio
async def test_chat_async_is_coroutine(openai_settings):
    """Verify chat_async returns a real coroutine (not thread-pool wrapper)."""
    import inspect
    client = LLMClient(openai_settings)
    assert inspect.iscoroutinefunction(client.chat_async)


@pytest.mark.asyncio
async def test_chat_json_async_is_coroutine(openai_settings):
    """Verify chat_json_async returns a real coroutine."""
    import inspect
    client = LLMClient(openai_settings)
    assert inspect.iscoroutinefunction(client.chat_json_async)


@pytest.mark.asyncio
async def test_stream_chat_async_is_asyncgen(openai_settings):
    """Verify stream_chat_async is an async generator function (cancellable)."""
    import inspect
    client = LLMClient(openai_settings)
    assert inspect.isasyncgenfunction(client.stream_chat_async)


@pytest.mark.asyncio
async def test_stream_chat_structured_async_is_asyncgen(openai_settings):
    """Verify stream_chat_structured_async is an async generator function."""
    import inspect
    client = LLMClient(openai_settings)
    assert inspect.isasyncgenfunction(client.stream_chat_structured_async)


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._stream_openai_async")
async def test_stream_chat_async_routes_to_openai(mock_stream, openai_settings):
    """Verify stream_chat_async yields from the right provider method."""
    async def _mock_gen(*args, **kwargs):
        yield "chunk1"
        yield "chunk2"
    mock_stream.return_value = _mock_gen()
    client = LLMClient(openai_settings)
    chunks = []
    async for chunk in client.stream_chat_async(system="sys", user_message="hello"):
        chunks.append(chunk)
    assert chunks == ["chunk1", "chunk2"]


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._stream_openai_async")
async def test_stream_chat_async_routes_to_openai_with_leyline(mock_stream, leyline_settings):
    """When leyline is configured, streaming still routes to OpenAI methods."""
    async def _mock_gen(*args, **kwargs):
        yield "leyline-chunk1"
        yield "leyline-chunk2"
    mock_stream.return_value = _mock_gen()
    client = LLMClient(leyline_settings)
    chunks = []
    async for chunk in client.stream_chat_async(system="sys", user_message="hello"):
        chunks.append(chunk)
    assert chunks == ["leyline-chunk1", "leyline-chunk2"]


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._stream_openai_structured_async")
async def test_stream_chat_structured_async_routes_to_openai(mock_stream, openai_settings):
    """Verify stream_chat_structured_async yields structured items."""
    async def _mock_gen(*args, **kwargs):
        yield {"type": "reasoning", "text": "thinking"}
        yield {"type": "content", "text": "response"}
    mock_stream.return_value = _mock_gen()
    client = LLMClient(openai_settings)
    items = []
    async for item in client.stream_chat_structured_async(system="sys", user_message="hello"):
        items.append(item)
    assert items == [
        {"type": "reasoning", "text": "thinking"},
        {"type": "content", "text": "response"},
    ]
