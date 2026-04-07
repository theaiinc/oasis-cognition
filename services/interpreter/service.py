"""Interpreter service: converts user text into SemanticStructure using an LLM."""

from __future__ import annotations

import json
import logging
from typing import Any

from packages.reasoning_schema.models import SemanticStructure
from packages.shared_utils.config import Settings
from packages.shared_utils.llm_client import LLMClient

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are a semantic interpreter for a reasoning system. Your job is to extract structured information from user messages and determine how they should be routed.

Given a user message, output a JSON object with exactly these fields:
{
  "route": "<casual | complex | teaching | tool_use>",
  "problem": "<short description of the core problem>",
  "trigger": "<what causes or triggers the problem>",
  "entities": {<key-value pairs of important entities, metrics, thresholds, etc.>},
  "intent": "<what the user wants: diagnose | explain | fix | compare | explore | teach | greet | execute | implement>",
  "is_simple": <true | false>,
  "context": {<any additional contextual information>}
}

Route classification rules:
- "casual": ONLY for simple greetings, thank you, how are you, goodbye, small talk with absolutely no technical substance.

"is_simple" classification:
- true: If the request is purely conversational, a simple greeting, a question that can be answered without tools, or a task that is clearly trivial and non-technical.
- false: If the request requires codebase inspection, tool use, multistep reasoning, or involves technical implementation.
- "complex": Deep analysis problems — architecture decisions, business strategy, trade-off analysis, system design reasoning that does NOT require looking at code or files. NEVER use complex for: adding features, enabling something, fixing code, or any request that implies modifying or inspecting the codebase.
- "teaching": The user is asserting a **permanent** fact, rule, or preference they want the system to learn and remember forever. Signals: "remember that...", "you should know...", "always do X", "never do Y", "the rule is...", corrections like "no, that's wrong because...", or statements of domain knowledge.
  **NOT teaching**: If the user is giving instructions or constraints for the CURRENT task (e.g., "keep in mind that the approver doesn't know technical details", "make sure to include X in the plan", "the audience is non-technical"), that is context for the task → use "complex" or "tool_use" based on the task, NOT "teaching".
- "tool_use": ANY question that could benefit from checking the actual codebase, files, system state, or running commands. This includes:
  * Questions about the project: "where are the components?", "how does X work?", "what does this file do?"
  * Code exploration: "find ...", "show me ...", "what's in ...", "list files"
  * System info: "what process is running", "disk space", "what version"
  * Code editing / feature work: "add ...", "fix ...", "change ...", "create ...", "update ...", "enable ...", "implement ...", "add X to the UI", "make the code view do Y"
  * Debugging: "why is X happening?", "what's wrong with ...", "check the logs"
  * ANY request to modify the codebase, add a feature, or change behavior — ALWAYS use tool_use (the agent must read and edit files)
  * ANY question that could be answered more accurately by reading actual code/files rather than guessing

Intent field (classify the user's goal — downstream logic uses this, do NOT rely on keyword lists elsewhere):
- "explore": read-only discovery (where is X, how does Y work, show structure) — no code change requested
- "explain": conceptual explanation, walkthrough — usually no edit
- "diagnose": figure out why something is wrong — may lead to fix but user asked for analysis first
- "compare": contrast options or implementations — usually read-only
- "create": generate a plan, document, proposal, outline, specification, or other substantial written content — expects a detailed, thorough response (use for "create a plan", "write a proposal", "draft a document", "make a spec", "plan the modules", "outline the architecture", etc.)
- "fix": bug fix or correcting broken behavior — expects code changes
- "implement": new feature, UI change, refactor that edits files — expects code changes (use for "add", "enable", "support", "wire up", etc.)
- "execute": run a command, script, or operational action (may or may not edit files)
- "teach", "greet": as before

Rules:
- Be concise. Each field should be a short phrase, not a paragraph.
- entities should capture concrete values (numbers, names, metrics).
- If something is not mentioned, use an empty string or empty object.
- PREFER tool_use over casual/complex for anything code or project related. The agent has access to the codebase and should look things up rather than guess.
- If the user wants to add, enable, implement, or change something in the codebase → ALWAYS use tool_use. Complex route does NOT run tools and will never produce code changes.
- Only use "casual" for pure social/conversational messages.
- Output ONLY valid JSON — no markdown, no explanation.
- **CRITICAL: Use RECENT_CHAT_HISTORY to resolve ambiguous messages.** If they say "continue", "do it", "pls fix", "fix that too", "also add tests", "yes", or any short follow-up — use the thread (including any `system:` line starting with "Conversation summary:") to infer WHAT they mean. The route and intent should match the ongoing task, not only the literal words of the latest message. A "continue" after a tool_use session → route=tool_use. A "yes" after a question about implementation → route=tool_use, intent=implement.
"""


def _is_conversation_summary_turn(turn: dict[str, str]) -> bool:
    role = str(turn.get("role", "")).lower()
    content = (turn.get("content") or "").lower()
    return role == "system" and "conversation summary:" in content


def _merge_interpreter_chat_history(
    chat_history: list[dict[str, str]],
    max_non_summary_turns: int = 6,
) -> list[dict[str, str]]:
    """Keep condensed thread summaries plus the most recent user/assistant turns."""
    summaries = [t for t in chat_history if _is_conversation_summary_turn(t)]
    rest = [t for t in chat_history if not _is_conversation_summary_turn(t)]
    recent_rest = rest[-max_non_summary_turns:]
    if summaries:
        return [summaries[-1], *recent_rest]
    return recent_rest


class InterpreterService:
    """Translates natural language into SemanticStructure."""

    def __init__(self, settings: Settings, llm: LLMClient | None = None) -> None:
        self._settings = settings
        self._llm = llm or LLMClient(settings)

    async def interpret(
        self,
        text: str,
        context: dict[str, Any] | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ) -> SemanticStructure:
        """Convert raw user text into a SemanticStructure."""
        logger.info("Interpreting input: %s", text[:120])

        user_message = text

        # Prepend a compact chat history summary so the interpreter can resolve
        # references like "continue", "do it", "fix that too", "also add tests".
        # Only include the last few turns to keep token usage low.
        if chat_history:
            recent = _merge_interpreter_chat_history(chat_history)
            history_lines = []
            for turn in recent:
                role = turn.get("role", "?")
                content = turn.get("content", "")
                # Truncate long assistant responses to just the first line
                if role == "assistant" and len(content) > 200:
                    content = content[:200] + "..."
                history_lines.append(f"  {role}: {content}")
            if history_lines:
                user_message = (
                    "RECENT_CHAT_HISTORY (includes conversation summary when present — use for vague follow-ups like 'pls fix', 'it', 'that', 'continue'):\n"
                    + "\n".join(history_lines)
                    + "\n\n"
                    + user_message
                )

        if context:
            # Strip large binary fields (e.g. base64 screen images) before sending to text-only LLM
            ctx_for_llm = {k: v for k, v in context.items() if k != "screen_image"}
            if ctx_for_llm:
                has_screen = "screen_image" in context
                if has_screen:
                    ctx_for_llm["screen_shared"] = True
                try:
                    context_json = json.dumps(ctx_for_llm, ensure_ascii=False)
                except Exception:
                    context_json = json.dumps({"raw": str(ctx_for_llm)}, ensure_ascii=False)

                user_message = (
                    "EXTERNAL_CONTEXT (may include screen-share status, UI state, or other metadata):\n"
                    f"{context_json}\n\n"
                    + user_message
                )

        try:
            parsed = self._llm.chat_json(system=SYSTEM_PROMPT, user_message=user_message)
        except Exception as e:
            # If the LLM returns non-JSON or parse fails, fall back to a safe default
            # instead of bubbling a 500 to the rest of the pipeline.
            logger.error("Failed to parse interpretation: %s", e)
            parsed = {
                "route": "complex",
                "problem": text[:200],
                "trigger": "",
                "entities": {},
                "intent": "diagnose",
                "context": {},
            }

        # Coerce fields that LLMs sometimes return as wrong types
        entities = parsed.get("entities", {})
        if not isinstance(entities, dict):
            entities = {"raw": str(entities)} if entities else {}

        context = parsed.get("context", {})
        if not isinstance(context, dict):
            context = {"raw": str(context)} if context else {}

        intent = parsed.get("intent", "diagnose")
        if not isinstance(intent, str):
            intent = "diagnose"

        route = parsed.get("route", "complex")
        if route not in ("casual", "complex", "teaching", "tool_use"):
            route = "complex"

        structure = SemanticStructure(
            problem=str(parsed.get("problem", "") or ""),
            trigger=str(parsed.get("trigger", "") or ""),
            entities=entities,
            intent=intent,
            context=context,
            raw_input=text,
            route=route,
            is_simple=bool(parsed.get("is_simple", False)),
        )
        logger.info("Interpretation: route=%s, problem=%s, trigger=%s", structure.route, structure.problem, structure.trigger)
        return structure
