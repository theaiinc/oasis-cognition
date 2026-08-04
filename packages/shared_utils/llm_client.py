"""Unified LLM client supporting Anthropic, OpenAI, and Ollama."""

from __future__ import annotations

import logging
from typing import Any

from packages.shared_utils.config import Settings, _load_active_project_overrides

logger = logging.getLogger(__name__)


class LLMClient:
    """Provider-agnostic LLM client.

    Supports:
      - "anthropic" — Anthropic Messages API
      - "openai"    — OpenAI Chat Completions API (also works with any
                       OpenAI-compatible endpoint via `openai_base_url`, e.g.
                       DeepSeek, LLM API, vLLM, Groq, etc.)
      - "ollama"    — Ollama native API (no API key needed)
    """

    def __init__(self, settings: Settings, timeout: int = 300) -> None:
        self._settings = settings
        self._timeout = timeout
        self._anthropic_client: Any = None
        self._openai_client: Any = None
        self._ollama_client: Any = None

    def _leyline_base_url(self) -> str | None:
        url = (self._settings.leyline_base_url or "").strip().rstrip("/")
        return url or None

    def _is_routed_via_leyline(self) -> bool:
        return (
            self._settings.llm_routing_provider == "leyline"
            and self._leyline_base_url() is not None
        )

    def _effective_openai_base_url(self) -> str:
        leyline_url = self._leyline_base_url() if self._is_routed_via_leyline() else None
        return leyline_url or (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")

    def _leyline_budget_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._settings.leyline_provider.strip():
            headers["X-Leyline-Provider"] = self._settings.leyline_provider.strip()
        if self._settings.leyline_max_budget_usd > 0:
            headers["X-Leyline-Max-Budget-USD"] = str(self._settings.leyline_max_budget_usd)
        if self._settings.leyline_daily_budget_usd > 0:
            headers["X-Leyline-Daily-Budget-USD"] = str(self._settings.leyline_daily_budget_usd)
        return headers

    def _refresh_project_overrides(self) -> None:
        """Pick up UI-saved active-project settings without exposing secrets."""
        for key, value in _load_active_project_overrides().items():
            if hasattr(self._settings, key):
                setattr(self._settings, key, value)
        # A changed endpoint/provider must not reuse a client created for the
        # previous configuration.
        self._openai_client = None
        self._anthropic_client = None
        self._ollama_client = None

    def apply_profile_config(self, config: dict[str, Any]) -> None:
        """Apply an internal agent-profile config without project persistence."""
        mapping = {
            "provider": "llm_provider",
            "model": "llm_model",
            "base_url": "openai_base_url",
            "max_tokens": "llm_max_tokens",
            "context_window": "context_window",
            "context_output_reserve": "context_output_reserve",
            "routing_provider": "llm_routing_provider",
            "leyline_base_url": "leyline_base_url",
            "leyline_provider": "leyline_provider",
            "leyline_model": "leyline_model",
            "leyline_max_budget_usd": "leyline_max_budget_usd",
            "leyline_daily_budget_usd": "leyline_daily_budget_usd",
            "openai_api_key": "openai_api_key",
            "anthropic_api_key": "anthropic_api_key",
        }
        for source, target in mapping.items():
            if source in config and config[source] is not None:
                setattr(self._settings, target, config[source])
        self._openai_client = None
        self._anthropic_client = None
        self._ollama_client = None

    @property
    def provider(self) -> str:
        if self._is_routed_via_leyline() and self._settings.llm_routing_provider == "leyline":
            return "openai"
        return self._settings.llm_provider

    def _effective_model(self, model: str | None) -> str:
        if model:
            return model
        if self._is_routed_via_leyline() and self._settings.leyline_model.strip():
            return self._settings.leyline_model.strip()
        return self._settings.llm_model

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

    @staticmethod
    def _is_max_tokens_unsupported_error(exc: Exception) -> bool:
        """True for the newer OpenAI-family models (o1/o3/gpt-5.x reasoning
        models) that reject `max_tokens` in favor of `max_completion_tokens`.
        Detected by message rather than a model-name allowlist so it keeps
        working as new models/providers are added behind Leyline."""
        message = str(getattr(exc, "message", "") or exc)
        return "max_tokens" in message and "max_completion_tokens" in message

    def _create_chat_completion(self, client: Any, **kwargs: Any) -> Any:
        """`client.chat.completions.create(...)` with one automatic retry
        using `max_completion_tokens` instead of `max_tokens` if the model
        rejects the latter."""
        try:
            return client.chat.completions.create(**kwargs)
        except Exception as e:
            if "max_tokens" in kwargs and self._is_max_tokens_unsupported_error(e):
                retry_kwargs = {k: v for k, v in kwargs.items() if k != "max_tokens"}
                retry_kwargs["max_completion_tokens"] = kwargs["max_tokens"]
                return client.chat.completions.create(**retry_kwargs)
            raise

    def _get_openai(self) -> Any:
        if self._openai_client is None:
            import openai

            kwargs: dict[str, Any] = {"api_key": self._settings.openai_api_key}
            kwargs["base_url"] = self._effective_openai_base_url()
            if self._leyline_budget_headers():
                kwargs["default_headers"] = self._leyline_budget_headers()
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
        self._refresh_project_overrides()
        model = self._effective_model(model)
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
        self._refresh_project_overrides()
        model = self._effective_model(model)
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
        self._refresh_project_overrides()
        model = self._effective_model(model)
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
        response = self._create_chat_completion(
            client,
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
        response = self._create_chat_completion(
            client,
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
        response = self._create_chat_completion(
            client,
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
