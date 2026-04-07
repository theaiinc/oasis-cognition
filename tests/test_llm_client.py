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
    mock_call.assert_called_once_with("sys", "hello", "llama3", 1024, None)


@patch("packages.shared_utils.llm_client.LLMClient._call_openai", return_value="local model response")
def test_chat_with_custom_base_url(mock_call, openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    result = client.chat(system="sys", user_message="hello")
    assert result == "local model response"
    mock_call.assert_called_once_with("sys", "hello", "llama3", 1024, None)


def test_openai_custom_base_url_stored(openai_custom_base_settings):
    client = LLMClient(openai_custom_base_settings)
    assert client._settings.openai_base_url == "http://localhost:11434/v1"
    assert client._settings.llm_model == "llama3"


def test_ollama_custom_host(ollama_custom_host_settings):
    client = LLMClient(ollama_custom_host_settings)
    assert client._settings.ollama_host == "http://gpu-server:11434"
    assert client._settings.llm_model == "mistral"
