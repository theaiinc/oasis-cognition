"""Unified LLM client supporting Anthropic, OpenAI, and Ollama."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from packages.shared_utils.config import Settings

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

    def stream_chat_structured(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ):
        """Yield structured dicts as they stream from the LLM.

        Yields:
        - ``{"type": "reasoning", "text": "..."}`` — thinking/reasoning tokens
        - ``{"type": "content", "text": "..."}`` — visible response text
        - ``{"type": "tool_call", "id": "...", "function": {"name": "...", "arguments": "..."}}``
          — tool call requests (only when ``tools`` is provided)

        ``tools`` is an optional list of OpenAI tool definitions
        (``{"type": "function", "function": {"name": "...", "parameters": {...}}}``).
        When provided, the LLM can request tool calls; these are yielded as
        ``tool_call`` items.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            yield from self._stream_openai_structured(system, user_message, model, max_tokens, history, tools)
        elif self.provider == "ollama":
            # Ollama returns reasoning in the normal message content for thinking models
            yield from self._stream_ollama_structured(system, user_message, model, max_tokens, history)
        else:
            # Anthropic doesn't expose separate reasoning tokens in streaming
            for chunk in self._stream_anthropic(system, user_message, model, max_tokens, history):
                yield {"type": "content", "text": chunk}

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
    # Async wrappers — use raw httpx.AsyncClient so cancellation propagates
    # all the way to LM Studio (unlike asyncio.to_thread which can't be killed).
    # ------------------------------------------------------------------

    async def chat_async(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """Async chat — uses httpx.AsyncClient so the HTTP connection to the
        LLM backend is cancellable when the caller task is cancelled."""
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            return await self._call_openai_async(system, user_message, model, max_tokens, history)
        if self.provider == "ollama":
            return await self._call_ollama_async(system, user_message, model, max_tokens, history)
        return await self._call_anthropic_async(system, user_message, model, max_tokens, history)

    async def chat_json_async(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> Any:
        """Async chat returning parsed JSON — cancellable HTTP."""
        from packages.shared_utils.json_utils import extract_json
        raw = await self.chat_async(system=system, user_message=user_message, model=model, max_tokens=max_tokens)
        return extract_json(raw)

    async def chat_structured_async(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ) -> dict:
        """Non-streaming async chat with tools (native function calling).

        Returns a dict:
          ``{"type": "text", "content": "..."}`` — no tool calls (final_answer)
          ``{"type": "tool_calls", "calls": [...], "content": "..."}`` — has tool calls
            where each call is ``{"id": "...", "function": {"name": "...", "arguments": "..."}}``

        Only works with OpenAI-compatible and Ollama providers.
        Falls back to ``chat_async`` for Anthropic.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            return await self._call_openai_structured_async(
                system, user_message, model, max_tokens, history, tools,
            )
        if self.provider == "ollama":
            return await self._call_ollama_structured_async(
                system, user_message, model, max_tokens, history, tools,
            )
        # Anthropic fallback: tools not supported, just text
        text = await self._call_anthropic_async(system, user_message, model, max_tokens, history)
        return {"type": "text", "content": text}

    async def stream_chat_async(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
    ):
        """Async generator that streams from the LLM using httpx.AsyncClient.

        Cancellation-safe: when the caller is cancelled, the underlying HTTP
        connection to the LLM backend (e.g. LM Studio) is closed immediately,
        stopping the model from computing.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            async for chunk in self._stream_openai_async(system, user_message, model, max_tokens, history):
                yield chunk
        elif self.provider == "ollama":
            async for chunk in self._stream_ollama_async(system, user_message, model, max_tokens, history):
                yield chunk
        else:
            async for chunk in self._stream_anthropic_async(system, user_message, model, max_tokens, history):
                yield chunk

    async def stream_chat_structured_async(
        self,
        *,
        system: str,
        user_message: str,
        model: str | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ):
        """Async generator that streams structured items from the LLM using httpx.AsyncClient.

        Cancellation-safe: when the caller is cancelled, the underlying HTTP
        connection to the LLM backend is closed immediately.
        """
        model = model or self._settings.llm_model
        max_tokens = max_tokens or self._settings.llm_max_tokens

        if self.provider == "openai":
            async for item in self._stream_openai_structured_async(
                system, user_message, model, max_tokens, history, tools
            ):
                yield item
        elif self.provider == "ollama":
            # Ollama returns reasoning in content for thinking models
            async for item in self._stream_ollama_structured_async(
                system, user_message, model, max_tokens, history
            ):
                yield item
        else:
            async for item in self._stream_anthropic_async(
                system, user_message, model, max_tokens, history
            ):
                yield {"type": "content", "text": item}

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

    async def _call_anthropic_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """Cancellable async Anthropic call via httpx.AsyncClient."""
        import httpx
        messages: list[dict[str, str]] = list(history or [])
        messages.append({"role": "user", "content": user_message})
        base_url = "https://api.anthropic.com/v1"
        api_key = self._settings.anthropic_api_key
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
        async with httpx.AsyncClient(timeout=None) as http:
            resp = await http.post(f"{base_url}/messages", json=body, headers=headers)
            data = resp.json()
            return data["content"][0]["text"].strip()

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

    async def _call_openai_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """Cancellable async non-streaming OpenAI call via httpx.AsyncClient.
        When the caller task is cancelled (e.g. gateway aborted the HTTP request),
        this closes the connection to LM Studio so the model stops computing."""
        import httpx
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        body = {"model": model, "max_tokens": max_tokens, "messages": messages, "stream": False}

        async with httpx.AsyncClient(timeout=None) as http:
            resp = await http.post(f"{base_url}/chat/completions", json=body, headers=headers)
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()

    async def _call_openai_structured_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ) -> dict:
        """Non-streaming OpenAI call with native function calling support.

        Returns ``{"type": "text", "content": "..."}`` or
        ``{"type": "tool_calls", "calls": [...], "content": "..."}``.
        """
        import httpx
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
            "stream": False,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=None) as http:
            resp = await http.post(f"{base_url}/chat/completions", json=body, headers=headers)
            data = resp.json()

        choice = data["choices"][0]
        message = choice.get("message", {})
        content = (message.get("content") or "").strip()
        tc_list = message.get("tool_calls")

        if tc_list:
            calls = [
                {
                    "id": tc["id"],
                    "function": {
                        "name": tc["function"]["name"],
                        "arguments": tc["function"]["arguments"],
                    },
                }
                for tc in tc_list
            ]
            return {"type": "tool_calls", "calls": calls, "content": content}

        return {"type": "text", "content": content or ""}

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

    async def _call_ollama_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """Cancellable async Ollama call via httpx.AsyncClient."""
        import httpx
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        base_url = (self._settings.ollama_base_url or "http://localhost:11434").rstrip("/")
        async with httpx.AsyncClient(timeout=None) as http:
            resp = await http.post(
                f"{base_url}/api/chat",
                json={"model": model, "messages": messages, "options": {"num_predict": max_tokens}, "stream": False},
            )
            data = resp.json()
            return data["message"]["content"].strip()

    async def _call_ollama_structured_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ) -> dict:
        """Non-streaming Ollama call with native function calling support.

        Returns ``{"type": "text", "content": "..."}`` or
        ``{"type": "tool_calls", "calls": [...], "content": "..."}``.
        """
        import httpx
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        base_url = (self._settings.ollama_base_url or "http://localhost:11434").rstrip("/")

        body: dict = {
            "model": model,
            "messages": messages,
            "options": {"num_predict": max_tokens},
            "stream": False,
        }
        if tools:
            body["tools"] = tools

        async with httpx.AsyncClient(timeout=None) as http:
            resp = await http.post(f"{base_url}/api/chat", json=body)
            data = resp.json()

        msg = data.get("message", {}) or {}
        content = (msg.get("content") or "").strip()
        tc_list = msg.get("tool_calls")

        if tc_list:
            calls = [
                {
                    "id": tc.get("function", {}).get("name", f"ollama_{i}"),
                    "function": {
                        "name": tc["function"]["name"],
                        "arguments": json.dumps(tc["function"].get("arguments", {})),
                    },
                }
                for i, tc in enumerate(tc_list)
            ]
            return {"type": "tool_calls", "calls": calls, "content": content}

        return {"type": "text", "content": content or ""}

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
        """Stream from OpenAI-compatible endpoints using raw SSE parsing.

        This bypasses the OpenAI SDK's Pydantic layer (which strips non-standard
        fields like ``reasoning_content`` from LM Studio / thinking models).
        """
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": True,
        }
        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")

        with httpx.Client(timeout=self._timeout) as http:
            with http.stream("POST", f"{base_url}/chat/completions", json=body, headers=headers) as resp:
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})

                    # reasoning_content — non-standard extension field sent by
                    # LM Studio, DeepSeek, etc.  The OpenAI SDK strips this via
                    # Pydantic extra='ignore', but raw SSE preserves it.
                    reasoning = delta.get("reasoning_content")
                    if reasoning:
                        yield reasoning
                    content = delta.get("content")
                    if content:
                        yield content

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

    # ------------------------------------------------------------------
    # Structured streaming (reasoning + content separation)
    # ------------------------------------------------------------------

    def _stream_openai_structured(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ):
        """Stream from OpenAI-compatible endpoints using raw SSE parsing, yielding
        ``{"type": "reasoning"|"content"|"tool_call", ...}``.

        Uses raw SSE instead of the OpenAI SDK so non-standard fields like
        ``reasoning_content`` (LM Studio / thinking models) are preserved.
        When ``tools`` is provided, tool call deltas are accumulated across
        chunks and yielded as complete ``{"type": "tool_call", ...}`` items.
        """
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")

        # Accumulators for tool call deltas (tool calls arrive in pieces across chunks)
        tool_calls: dict[int, dict] = {}
        # Set of index -> (id, name) to track which tool calls have finished arguments
        finished_tool_calls: set[int] = set()

        with httpx.Client(timeout=self._timeout) as http:
            with http.stream("POST", f"{base_url}/chat/completions", json=body, headers=headers) as resp:
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    finish_reason = choices[0].get("finish_reason")

                    # reasoning_content — non-standard extension field
                    reasoning = delta.get("reasoning_content")
                    if reasoning:
                        yield {"type": "reasoning", "text": reasoning}

                    content = delta.get("content")
                    if content:
                        yield {"type": "content", "text": content}

                    # tool_calls — accumulate across chunks
                    tc_deltas = delta.get("tool_calls")
                    if tc_deltas:
                        for tc in tc_deltas:
                            idx = tc.get("index", 0)
                            if idx not in tool_calls:
                                tool_calls[idx] = {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                }
                            tc_entry = tool_calls[idx]
                            if tc.get("id"):
                                tc_entry["id"] = tc["id"]
                            fn = tc.get("function", {})
                            if fn.get("name"):
                                tc_entry["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                tc_entry["function"]["arguments"] += fn["arguments"]

                    # When finish_reason is "tool_calls", emit all accumulated tool calls
                    if finish_reason == "tool_calls" and tool_calls:
                        for idx in sorted(tool_calls.keys()):
                            tc = tool_calls[idx]
                            yield {
                                "type": "tool_call",
                                "id": tc["id"],
                                "function": {
                                    "name": tc["function"]["name"],
                                    "arguments": tc["function"]["arguments"],
                                },
                            }
                        tool_calls.clear()

    def _stream_ollama_structured(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        """Stream from Ollama, yielding ``{"type": "reasoning"|"content", "text": "..."}``.

        Ollama places reasoning in ``message.thought`` or returns it inline
        in ``message.content`` for thinking models.
        """
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
            msg = chunk.get('message', {}) or {}
            # Ollama thinking / chain-of-thought tunnel
            reasoning = msg.get('thought', '') or msg.get('reasoning_content', '')
            if reasoning:
                yield {"type": "reasoning", "text": reasoning}
            content = msg.get('content', '')
            if content:
                yield {"type": "content", "text": content}

    # ------------------------------------------------------------------
    # Async streaming — httpx.AsyncClient for cancellation-safe streaming
    # ------------------------------------------------------------------

    async def _stream_openai_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        """Cancellable async streaming from OpenAI-compatible endpoints."""
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": True,
        }
        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")

        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream("POST", f"{base_url}/chat/completions", json=body, headers=headers) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    reasoning = delta.get("reasoning_content")
                    if reasoning:
                        yield reasoning
                    content = delta.get("content")
                    if content:
                        yield content

    async def _stream_ollama_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        """Cancellable async streaming from Ollama."""
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        base_url = (self._settings.ollama_base_url or "http://localhost:11434").rstrip("/")

        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream(
                "POST",
                f"{base_url}/api/chat",
                json={"model": model, "messages": messages, "options": {"num_predict": max_tokens}, "stream": True},
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("done"):
                        break
                    content = chunk.get("message", {}).get("content", "")
                    if content:
                        yield content

    async def _stream_anthropic_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        """Cancellable async streaming from Anthropic."""
        import httpx

        msgs: list[dict[str, str]] = list(history or [])
        msgs.append({"role": "user", "content": user_message})
        base_url = "https://api.anthropic.com/v1"
        api_key = self._settings.anthropic_api_key
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": msgs, "stream": True}

        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream("POST", f"{base_url}/messages", json=body, headers=headers) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            yield delta.get("text", "")

    async def _stream_openai_structured_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
        tools: list[dict] | None = None,
    ):
        """Cancellable async structured streaming from OpenAI-compatible endpoints."""
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})

        headers = {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        base_url = (self._settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")

        tool_calls: dict[int, dict] = {}
        finished_tool_calls: set[int] = set()

        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream("POST", f"{base_url}/chat/completions", json=body, headers=headers) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    finish_reason = choices[0].get("finish_reason")

                    reasoning = delta.get("reasoning_content")
                    if reasoning:
                        yield {"type": "reasoning", "text": reasoning}

                    content = delta.get("content")
                    if content:
                        yield {"type": "content", "text": content}

                    tc_deltas = delta.get("tool_calls")
                    if tc_deltas:
                        for tc in tc_deltas:
                            idx = tc.get("index", 0)
                            if idx not in tool_calls:
                                tool_calls[idx] = {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                }
                            tc_entry = tool_calls[idx]
                            if tc.get("id"):
                                tc_entry["id"] = tc["id"]
                            fn = tc.get("function", {})
                            if fn.get("name"):
                                tc_entry["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                tc_entry["function"]["arguments"] += fn["arguments"]

                    if finish_reason == "tool_calls" and tool_calls:
                        for idx in sorted(tool_calls.keys()):
                            tc = tool_calls[idx]
                            yield {
                                "type": "tool_call",
                                "id": tc["id"],
                                "function": {
                                    "name": tc["function"]["name"],
                                    "arguments": tc["function"]["arguments"],
                                },
                            }
                        tool_calls.clear()

    async def _stream_ollama_structured_async(
        self, system: str, user_message: str, model: str, max_tokens: int,
        history: list[dict[str, str]] | None = None,
    ):
        """Cancellable async structured streaming from Ollama."""
        import httpx

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_message})
        base_url = (self._settings.ollama_base_url or "http://localhost:11434").rstrip("/")

        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream(
                "POST",
                f"{base_url}/api/chat",
                json={"model": model, "messages": messages, "options": {"num_predict": max_tokens}, "stream": True},
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("done"):
                        break
                    msg = chunk.get("message", {}) or {}
                    reasoning = msg.get("thought", "") or msg.get("reasoning_content", "")
                    if reasoning:
                        yield {"type": "reasoning", "text": reasoning}
                    content = msg.get("content", "")
                    if content:
                        yield {"type": "content", "text": content}
