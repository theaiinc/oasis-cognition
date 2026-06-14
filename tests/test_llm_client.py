"""Tests for the unified LLM client."""

from unittest.mock import patch

import pytest

from packages.shared_utils.config import Settings
from packages.shared_utils.llm_client import LLMClient


@pytest.fixture
def anthropic_settings():
    return Settings(
        llm_provider="anthropic",
        anthropic_api_key="test-key",
        llm_model="claude-sonnet-4-20250514",
    )


@pytest.fixture
def openai_settings():
    return Settings(
        llm_provider="openai",
        openai_api_key="test-key",
        llm_model="gpt-4o",
    )


@pytest.fixture
def openai_custom_base_settings():
    return Settings(
        llm_provider="openai",
        openai_api_key="test-key",
        openai_base_url="http://localhost:11434/v1",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_settings():
    return Settings(
        llm_provider="ollama",
        ollama_host="http://localhost:11434",
        llm_model="llama3",
    )


@pytest.fixture
def ollama_custom_host_settings():
    return Settings(
        llm_provider="ollama",
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
    mock_call.assert_called_once_with("sys", "hello", "llama3", 8192, None)


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="local model response")
def test_chat_with_custom_base_url(mock_call, openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "local model response"
    mock_call.assert_called_once_with("sys", "hello", "llama3", 8192, None)


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
@patch("packages.shared_utils.llm_client.LLMClient._call_openai_async", return_value="async openai response")
async def test_chat_async_routes_to_openai(mock_call, openai_settings):
    client = LLMClient(openai_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async openai response"
    mock_call.assert_called_once_with("sys", "hello", "gpt-4o", 8192, None)


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_ollama_async", return_value="async ollama response")
async def test_chat_async_routes_to_ollama(mock_call, ollama_settings):
    client = LLMClient(ollama_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async ollama response"
    mock_call.assert_called_once_with("sys", "hello", "llama3", 8192, None)


@pytest.mark.asyncio
@patch("packages.shared_utils.llm_client.LLMClient._call_anthropic_async", return_value="async claude response")
async def test_chat_async_routes_to_anthropic(mock_call, anthropic_settings):
    client = LLMClient(anthropic_settings)
    result = await client.chat_async(system="sys", user_message="hello")
    assert result == "async claude response"
    mock_call.assert_called_once_with("sys", "hello", "claude-sonnet-4-20250514", 8192, None)


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
