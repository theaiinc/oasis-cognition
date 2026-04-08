"""Unified LLM client supporting Anthropic, OpenAI, and Ollama."""

from __future__ import annotations

import logging
from typing import Any

from packages.shared_utils.config import Settings

logger = logging.getLogger(__name__)


class LLMClient:
    """Provider-agnostic LLM client.

    Supports:
      - "anthropic" — Anthropic Messages API
      - "openai"    — OpenAI Chat Completions API (also works with any
                       OpenAI-compatible endpoint via `openai_base_url`)
      - "ollama"    — Ollama native API (no API key needed)
    """

    def __init__(self, settings: Settings, timeout: int = 300) -> None:
        self._settings = settings
        self._timeout = timeout
        self._anthropic_client: Any = None
        self._openai_client: Any = None
        self._ollama_client: Any = None

    @property
    def provider(self) -> str:
        return self._settings.llm_provider

    # ------------------------------------------------------------------
    # Lazy client construction
    # ------------------------------------------------------------------

    def _get_anthropic(self) -> Any:
        if self._anthropic_client is None:
            import anthropic

            self._anthropic_client = anthropic.Anthropic(
                api_key=self._settings.anthropic_api_key,
                timeout=self._timeout,
            )
        return self._anthropic_client

    def _get_openai(self) -> Any:
        if self._openai_client is None:
            import openai

            kwargs: dict[str, Any] = {"api_key": self._settings.openai_api_key}
            if self._settings.openai_base_url:
                kwargs["base_url"] = self._settings.openai_base_url
            self._openai_client = openai.OpenAI(**kwargs, timeout=self._timeout)
        return self._openai_client

    def _get_ollama(self) -> Any:
        if self._ollama_client is None:
            import ollama

            self._ollama_client = ollama.Client(
                host=self._settings.ollama_host,
                timeout=self._timeout
            )
        return self._ollama_client

    # ------------------------------------------------------------------
    # Unified call
    # ------------------------------------------------------------------

    def chat(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """Send a chat and return the assistant text.

        If ``history`` is provided it should be a list of
        ``{"role": "user"|"assistant", "content": "..."}`` dicts representing
        prior conversation turns. They are inserted between the system prompt
        and the current ``user_message``.

        Works identically regardless of the configured provider.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            return self._call_openai(system, user_message, model, max_tokens, history)
        if self.provider == "ollama":
            return self._call_ollama(system, user_message, model, max_tokens, history)
        return self._call_anthropic(system, user_message, model, max_tokens, history)

    def stream_chat(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
    ):
        """Yield chat chunks as they arrive."""
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            yield from self._stream_openai(system, user_message, model, max_tokens, history)
        elif self.provider == "ollama":
            yield from self._stream_ollama(system, user_message, model, max_tokens, history)
        else:
            yield from self._stream_anthropic(system, user_message, model, max_tokens, history)

    def chat_with_images(
        self,
        *,
        system: str,
        user_message: str,
        images: list[str],
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """Send a single-turn chat with images and return the assistant text.

        - ``ollama``: base64 JPEG strings (raw or data URLs) via native vision messages.
        - ``openai`` (incl. OpenAI-compatible gateways): multimodal chat; images as
          data URLs (``data:image/jpeg;base64,...``) or raw base64 JPEG.
        - Other providers: text-only fallback.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            return self._call_openai_vision(system, user_message, images, model, max_tokens)
        if self.provider == "ollama":
            return self._call_ollama_vision(system, user_message, images, model, max_tokens)
        logger.warning("Vision not implemented for provider %s, falling back to text-only", self.provider)
        return self.chat(system=system, user_message=user_message, model=model, max_tokens=max_tokens)

    def chat_json(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> Any:
        """Send chat and extract JSON from the response."""
        from packages.shared_utils.json_utils import extract_json
        
        raw = self.chat(system=system, user_message=user_message, model=model, max_tokens=max_tokens)
        return extract_json(raw)

    # ------------------------------------------------------------------
    # Provider implementations
    # ------------------------------------------------------------------

    def _call_anthropic(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        client = self._get_anthropic()
        messages: list[dict[str, str]] = list(history or [])
        messages.append({"role": "user", "content": user_message})
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        return response.content[0].text.strip()

    def _call_openai(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        client = self._get_openai()
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=messages,
        )
        return response.choices[0].message.content.strip()

    @staticmethod
    def _image_url_for_openai(image_b64_or_url: str) -> str:
        s = (image_b64_or_url or "").strip()
        if s.startswith("data:"):
            return s
        return f"data:image/jpeg;base64,{s}"

    def _call_openai_vision(
        self,
        system: str,
        user_message: str,
        images: list[str],
        model: str,
        max_tokens: int,
    ) -> str:
        client = self._get_openai()
        # IMPORTANT: Image blocks MUST come BEFORE text blocks.
        # Some OpenAI-compatible gateways (e.g. llmapi.ai) serialize content
        # blocks as Go maps when text comes first, breaking vision entirely.
        # Also embed system instructions in the user text since some gateways
        # don't properly forward system messages for vision models.
        content: list[dict[str, Any]] = []
        for img in images:
            url = self._image_url_for_openai(img)
            content.append({"type": "image_url", "image_url": {"url": url}})
        # Combine system + user instructions in text block (after images)
        combined_text = f"{system}\n\n{user_message}" if system else user_message
        content.append({"type": "text", "text": combined_text})
        messages: list[dict[str, Any]] = [
            {"role": "user", "content": content},
        ]
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=messages,
        )
        raw = response.choices[0].message.content
        return (raw or "").strip()

    def _call_ollama(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        client = self._get_ollama()
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        response = client.chat(
            model=model,
            messages=messages,
            options={"num_predict": max_tokens},
        )
        return response.message.content.strip()

    def _call_ollama_vision(
        self, system: str, user_message: str, images: list[str], model: str, max_tokens: int
    ) -> str:
        """Call Ollama with base64 images (for vision models like llava).

        Falls back to llava:7b if the requested model is not available.
        """
        client = self._get_ollama()
        try:
            response = client.chat(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_message, "images": images},
                ],
                options={"num_predict": max_tokens},
            )
            return response.message.content.strip()
        except Exception as e:
            if model != "llava:7b":
                logger.warning("Vision model %s failed (%s), falling back to llava:7b", model, e)
                response = client.chat(
                    model="llava:7b",
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_message, "images": images},
                    ],
                    options={"num_predict": max_tokens},
                )
                return response.message.content.strip()
            raise
    def _stream_anthropic(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        client = self._get_anthropic()
        messages: list[dict[str, str]] = list(history or [])
        messages.append({"role": "user", "content": user_message})
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                yield text

    def _stream_openai(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        client = self._get_openai()
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=messages,
            stream=True,
        )
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    def _stream_ollama(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        client = self._get_ollama()
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        response = client.chat(
            model=model,
            messages=messages,
            options={"num_predict": max_tokens},
            stream=True,
        )
        for chunk in response:
            yield chunk['message']['content']
