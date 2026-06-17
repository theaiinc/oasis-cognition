"""Response Generator: converts DecisionTree into natural language using an LLM."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from packages.reasoning_schema.models import DecisionTree
from packages.shared_utils.config import Settings
from packages.shared_utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


# ── Model capability resolver ────────────────────────────────────
# Instead of tiering prompts, we tier capabilities.
# The CORE_TOOL_PLAN_PROMPT is identical for all models.
# We only filter which tools are *listed* as available based on model size.
# A 2B model simply cannot see delegate_tasks, mission_create, etc.
#
# Model size inference (same prefixes as before, kept for capability gating)
_MODEL_PARAM_HINTS: dict[str, int] = {
    "google/gemma-4-e2b": 2,
    "google/gemma-4-4b": 4,
    "google/gemma-4-12b": 12,
    "google/gemma-4-26b": 26,
    "qwen3:8b": 8,
    "qwen3:14b": 14,
    "qwen3:32b": 32,
    "deepseek-v4-flash": 0,
    "deepseek-v3": 0,
}


def _estimate_model_param_size(model_str: str | None) -> int:
    """Return estimated parameter size in billions, or 0 for unknown/proprietary."""
    if not model_str:
        return 0
    model_lower = model_str.strip().lower()
    best = 0
    best_len = 0
    for prefix, size in _MODEL_PARAM_HINTS.items():
        if model_lower.startswith(prefix) and len(prefix) > best_len:
            best = size
            best_len = len(prefix)
    return best


def resolve_available_tools(model_override: str | None) -> list[str]:
    """Return the list of tool names available to this model based on parameter size.

    Tiering:
      ≤3B  → UTILITY: core only (search, read, edit, bash). NO delegation, NO workflows, NO missions.
      ≤6B  → OPERATIONAL: core + get_rule + delegate_tasks + delegation tools.
      >6B  → COGNITIVE: full — standard + workflow_create/update/delete + triggers + computer_action + node_catalog + all missions.
      0 (unknown) → full (safest default for proprietary models).
    """
    param_size = _estimate_model_param_size(model_override)

    # Tools available to ALL models (universal core)
    universal = [
        "search_artifacts", "read_artifact",
        "bash", "read_file", "list_dir", "grep", "find_files",
        "browse_url", "web_search",
        "create_worktree", "apply_patch", "write_file", "edit_file",
        "read_worktree_file", "get_diff",
        "teach_rule", "update_rule", "delete_rule",
        "think",
        # Discovery tools — available to ALL models
        "search_mcp",
        "search_skills",
    ]

    if param_size == 0:
        return None  # None = use TOOL_PLAN_ALLOWED_TOOLS (full set)
    if param_size <= 3:
        return universal  # 2B/2B: utility — core only
    if param_size <= 6:
        # 4B/6B: operational — + delegation + get_rule
        return universal + [
            "get_rule",
            "delegate_tasks", "delegate_job_status",
            "delegate_job_cancel", "delegate_job_results",
        ]
    # >6B (12B+): cognitive — full kit
    return None  # None = use TOOL_PLAN_ALLOWED_TOOLS (full set)

# ── Tool descriptions for prompt injection ──────────────────────
# Short one-liners so the model understands what each tool does.
_TOOL_DESCRIPTIONS: dict[str, str] = {
    "search_artifacts": "Search indexed documents/artifacts by keyword.",
    "read_artifact": "Read a specific artifact by ID.",
    "bash": "Run a bash command on the host dev-agent. For installs, MUST use worktree.",
    "read_file": "Read a file at /workspace/<path>.",
    "list_dir": "List directory contents at /workspace/<path>.",
    "grep": "Search file contents by pattern at /workspace/<path>.",
    "find_files": "Find files by name glob at /workspace/<path>.",
    "browse_url": "Fetch a URL and return rendered text.",
    "web_search": "Search the web for information.",
    "create_worktree": "Create a working directory for edits. Call once per session.",
    "apply_patch": "Apply a unified diff patch to a file. Preferred edit method.",
    "write_file": "Create a NEW file (new files only — do NOT use for edits).",
    "edit_file": "Edit a file via old_string/new_string. Last resort after patch fails.",
    "read_worktree_file": "Read a file inside the active worktree.",
    "get_diff": "Show uncommitted diff in the worktree.",
    "teach_rule": "Teach a persistent rule (condition + conclusion + confidence).",
    "update_rule": "Update an existing rule by rule_id.",
    "delete_rule": "Delete a rule by rule_id.",
    "get_rule": "Request a rule pack by name (tool_rules, coding_rules, delegation_rules, etc.).",
    "think": "Reason about a complex problem before acting. Call with PARAM_REASON describing what you need to figure out (plan, debug, analyze, decide). Use sparingly — most actions don't need thinking.",
    "search_mcp": "Discover MCP tools by query (e.g. 'github create issue'). Returns matching tools with names, descriptions, and categories.",
    "search_skills": "Discover skills by goal/query (e.g. 'facebook post', 'analyze bug'). Returns matching skill guidance.",
    "computer_action": "Control desktop mouse/keyboard/screen.",
    # Workflow tools
    "workflow_list": "List workflows.",
    "workflow_get": "Get a workflow by ID.",
    "workflow_create": "Create a new workflow.",
    "workflow_update": "Update a workflow.",
    "workflow_delete": "Delete a workflow.",
    "workflow_run": "Run a workflow.",
    "workflow_runs_list": "List recent workflow runs.",
    "workflow_get_run": "Get a specific workflow run.",
    "workflow_cancel_run": "Cancel a running workflow.",
    "workflow_add_node": "Add a node to a workflow.",
    "workflow_add_edge": "Add an edge to a workflow.",
    "workflow_remove_node": "Remove a node from a workflow.",
    "node_catalog": "List available workflow node types.",
    "trigger_create": "Create a trigger for scheduled/reactive execution.",
    "trigger_list": "List triggers.",
    "trigger_update": "Update a trigger.",
    "trigger_delete": "Delete a trigger.",
    # Mission tools
    "mission_create": "Create a recurring background mission (auto-heal, monitoring, etc.).",
    "mission_list": "List missions.",
    "mission_get": "Get mission details.",
    "mission_update": "Update a mission.",
    "mission_delete": "Delete a mission.",
    "mission_pause": "Pause a mission.",
    "mission_resume": "Resume a paused mission.",
    "mission_run": "Trigger an immediate mission run.",
    # Coordinator tools
    "delegate_tasks": "Delegate independent sub-tasks to parallel sub-agents.",
    "delegate_job_status": "Check the status of a delegation job.",
    "delegate_job_cancel": "Cancel a delegation job.",
    "delegate_job_results": "Fetch results of a completed delegation job.",
}


# ── Tool parameter schemas for native function calling ──────────────
# Each tool describes its parameters as JSON Schema so the LLM can emit
# native tool_calls rather than the flat text format.
_TOOL_PARAM_SCHEMAS: dict[str, dict] = {
    # ── Read-only (container) ──
    "read_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path at /workspace/<path>."},
            "start_line": {"type": "integer", "description": "Optional start line (1-indexed)."},
            "end_line": {"type": "integer", "description": "Optional end line (inclusive)."},
        },
        "required": ["path"],
    },
    "list_dir": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Directory path at /workspace/<path>."},
            "recursive": {"type": "boolean", "description": "List recursively."},
        },
        "required": ["path"],
    },
    "grep": {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Regex or text pattern to search."},
            "path": {"type": "string", "description": "Directory/file to search."},
        },
        "required": ["pattern"],
    },
    "find_files": {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Glob pattern (e.g. '*.tsx', 'CodeBlock*')."},
            "path": {"type": "string", "description": "Directory to search in."},
            "file_type": {"type": "string", "description": "Optional type filter."},
        },
        "required": ["pattern"],
    },
    "browse_url": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Full URL to fetch."},
        },
        "required": ["url"],
    },
    "web_search": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
        },
        "required": ["query"],
    },
    # ── Host / Worktree ──
    "bash": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command to run on host."},
            "worktree_id": {"type": "string", "description": "Optional worktree ID if install inside worktree."},
        },
        "required": ["command"],
    },
    "create_worktree": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short name for the worktree."},
        },
    },
    "write_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (repo-relative)."},
            "content": {"type": "string", "description": "Full file content."},
            "worktree_id": {"type": "string", "description": "Active worktree ID."},
        },
        "required": ["path", "content"],
    },
    "edit_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (repo-relative)."},
            "old_string": {"type": "string", "description": "Exact text to replace."},
            "new_string": {"type": "string", "description": "Replacement text."},
            "worktree_id": {"type": "string", "description": "Active worktree ID."},
        },
        "required": ["path", "old_string", "new_string"],
    },
    "apply_patch": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (repo-relative)."},
            "patch": {"type": "string", "description": "Unified diff patch content."},
            "worktree_id": {"type": "string", "description": "Active worktree ID."},
        },
        "required": ["path", "patch"],
    },
    "read_worktree_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (repo-relative)."},
            "worktree_id": {"type": "string", "description": "Active worktree ID."},
            "start_line": {"type": "integer", "description": "Optional start line (1-indexed)."},
            "end_line": {"type": "integer", "description": "Optional end line (inclusive)."},
        },
        "required": ["path"],
    },
    "get_diff": {
        "type": "object",
        "properties": {
            "worktree_id": {"type": "string", "description": "Active worktree ID."},
        },
    },
    # ── Knowledge ──
    "search_artifacts": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Keyword search query."},
            "limit": {"type": "integer", "description": "Max results."},
        },
        "required": ["query"],
    },
    "read_artifact": {
        "type": "object",
        "properties": {
            "artifact_id": {"type": "string", "description": "Artifact ID from search results."},
        },
        "required": ["artifact_id"],
    },
    # ── System actions (special tools) ──
    "teach_rule": {
        "type": "object",
        "properties": {
            "condition": {"type": "string", "description": "When this rule applies."},
            "conclusion": {"type": "string", "description": "What to do / believe."},
            "confidence": {"type": "number", "description": "Confidence 0.0-1.0."},
        },
        "required": ["condition", "conclusion"],
    },
    "update_rule": {
        "type": "object",
        "properties": {
            "rule_id": {"type": "string", "description": "ID of rule to update."},
            "condition": {"type": "string", "description": "Updated condition."},
            "conclusion": {"type": "string", "description": "Updated conclusion."},
            "confidence": {"type": "number", "description": "Updated confidence 0.0-1.0."},
        },
        "required": ["rule_id"],
    },
    "delete_rule": {
        "type": "object",
        "properties": {
            "rule_id": {"type": "string", "description": "ID of rule to delete."},
        },
        "required": ["rule_id"],
    },
    "get_rule": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Rule pack name (tool_rules, coding_rules, delegation_rules, etc.)."},
        },
        "required": ["name"],
    },
    "think": {
        "type": "object",
        "properties": {
            "reason": {"type": "string", "description": "What you need to reason about (plan, debug, analyze, decide)."},
        },
        "required": ["reason"],
    },
    "search_mcp": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query (e.g. 'github create issue')."},
        },
        "required": ["query"],
    },
    "search_skills": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Describe what you want to accomplish (e.g. 'facebook post', 'analyze bug')."},
        },
        "required": ["query"],
    },
    # ── Computer use ──
    "computer_action": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "description": "Action type: type, click, double_click, move, scroll, screenshot, key, etc."},
            "x": {"type": "integer", "description": "X coordinate for mouse actions."},
            "y": {"type": "integer", "description": "Y coordinate for mouse actions."},
            "text": {"type": "string", "description": "Text to type."},
            "key": {"type": "string", "description": "Key to press."},
            "keys": {"type": "array", "items": {"type": "string"}, "description": "Multiple keys to press."},
            "button": {"type": "string", "description": "Mouse button: left, right, middle."},
            "direction": {"type": "string", "description": "Scroll direction: up, down, left, right."},
            "amount": {"type": "integer", "description": "Scroll amount in clicks."},
            "clicks": {"type": "integer", "description": "Number of clicks."},
        },
        "required": ["action"],
    },
    # ── Coordinator / Delegation ──
    "delegate_tasks": {
        "type": "object",
        "properties": {
            "goal": {"type": "string", "description": "Overall goal for the delegation."},
            "tasks": {"type": "string", "description": "JSON array of task objects [{id, goal, depends_on?, resource_class?}]."},
        },
        "required": ["goal", "tasks"],
    },
    "delegate_job_status": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Delegation job ID."},
        },
        "required": ["job_id"],
    },
    "delegate_job_cancel": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Delegation job ID."},
        },
        "required": ["job_id"],
    },
    "delegate_job_results": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Delegation job ID."},
        },
        "required": ["job_id"],
    },
}

# Compat aliases for FC: some models emit slightly different names
_TOOL_NAME_ALIASES_FC: dict[str, str] = {
    "edit": "edit_file",
    "search_replace": "edit_file",
    "replace": "edit_file",
    "patch": "apply_patch",
    "unified_diff": "apply_patch",
    "listdir": "list_dir",
    "read_dir": "list_dir",
    "dir_list": "list_dir",
    "search_files": "grep",
    "file_search": "grep",
    "find": "find_files",
    "glob": "find_files",
    "web": "web_search",
    "internet_search": "web_search",
    "google": "web_search",
    "fetch_url": "browse_url",
    "http_get": "browse_url",
    "read_url": "browse_url",
    "open_url": "browse_url",
    "discover_mcp": "search_mcp",
    "find_mcp": "search_mcp",
    "mcp_search": "search_mcp",
    "discover_skills": "search_skills",
    "find_skills": "search_skills",
    "skill_search": "search_skills",
    "cancel_job": "delegate_job_cancel",
    "cancel_task": "delegate_job_cancel",
    "get_results": "delegate_job_results",
    "job_results": "delegate_job_results",
    "task_results": "delegate_job_results",
    "aggregate_results": "delegate_job_results",
}


def _build_tool_definitions(available_tools: list[str]) -> list[dict]:
    """Build OpenAI-compatible tool/function definitions from available tool names."""
    definitions: list[dict] = []
    for name in sorted(available_tools):
        desc = _TOOL_DESCRIPTIONS.get(name, "")
        param_schema = _TOOL_PARAM_SCHEMAS.get(name, {
            "type": "object",
            "properties": {},
        })
        definitions.append({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": param_schema,
            },
        })
    return definitions


def _canonicalize_fc_tool_name(raw: str) -> tuple[str | None, str | None]:
    """Resolve a possibly-aliased FC tool name to canonical name."""
    if not raw or not str(raw).strip():
        return None, "Missing tool name."
    key = str(raw).strip().lower()
    if key in _TOOL_NAME_ALIASES_FC:
        key = _TOOL_NAME_ALIASES_FC[key]
    if key in _TOOL_DESCRIPTIONS or key == "final_answer":
        return key, None
    # Check in TOOL_PLAN_ALLOWED_TOOLS
    if key in TOOL_PLAN_ALLOWED_TOOLS:
        return key, None
    allowed = ", ".join(sorted(_TOOL_DESCRIPTIONS.keys()))
    return None, f"Unknown tool {raw!r}. Must be one of: {allowed}."


def _fc_response_to_plan(response: dict) -> dict[str, Any]:
    """Convert a native function calling response into the standard plan dict.

    ``response`` should be a dict from ``chat_structured_async``:
      ``{"type": "text", "content": "..."}`` or
      ``{"type": "tool_calls", "calls": [...], "content": "..."}``
    """
    response_type = response.get("type", "text")
    content = response.get("content", "")

    if response_type != "tool_calls" or not response.get("calls"):
        # No tool calls = final_answer
        text = (content or "").strip()
        if text:
            return {"action": "final_answer", "answer": text}
        return {"action": "final_answer", "answer": "Task completed (no tool calls required)."}

    # We only handle the first tool call (system executes one tool at a time)
    tc = response["calls"][0]
    raw_name = tc.get("function", {}).get("name", "")
    canonical, err = _canonicalize_fc_tool_name(raw_name)
    if err:
        return {
            "action": "final_answer",
            "answer": f"[INTERNAL: INVALID_TOOL] {err}",
            "_retry_hint": True,
        }

    raw_args_str = tc.get("function", {}).get("arguments", "{}")
    try:
        args = json.loads(raw_args_str) if isinstance(raw_args_str, str) else raw_args_str
    except json.JSONDecodeError:
        args = {}

    # Map to param keys matching the existing plan dict convention
    # FC tools use short param names (path, command, etc.). Map them to plan keys.
    param_whitelist = {
        "path", "command", "pattern", "url", "worktree_id", "content",
        "old_string", "new_string", "patch", "name", "recursive", "file_type",
        "query", "limit", "artifact_id",
        "condition", "conclusion", "confidence", "rule_id",
        "reason",
        "action", "x", "y", "text", "key", "keys", "button", "direction",
        "amount", "clicks",
        "goal", "tasks",
        "description", "enabled", "input", "workflow_id", "workflow_json",
        "run_id", "trigger_id", "trigger_type", "trigger_config",
        "node_id", "node_type", "node_params",
        "from_node", "from_port", "to_node", "to_port",
    }

    # Determine action type from the tool name
    if canonical in ("teach_rule", "update_rule", "delete_rule"):
        plan: dict[str, Any] = {"action": canonical}
        # Pass through all relevant params
        for pk in param_whitelist:
            if pk in args and args[pk] is not None:
                plan[pk] = args[pk]
        return plan

    if canonical == "get_rule":
        pack_name = args.get("name", "")
        return {"action": "get_rule", "name": pack_name}

    # Standard call_tool
    plan = {"action": "call_tool", "tool": canonical, "reasoning": content}

    # Map params from FC args to plan keys
    for pk in param_whitelist:
        if pk in args and args[pk] is not None:
            plan[pk] = args[pk]

    # Defaults (matching existing behavior)
    if canonical in ("read_file", "list_dir", "grep", "find_files") and "path" not in plan:
        plan["path"] = "/workspace"
    if canonical == "grep" and "pattern" not in plan:
        plan["pattern"] = "pattern"
    if canonical == "create_worktree" and "name" not in plan:
        plan["name"] = "workspace"

    return plan


def _format_tool_list(tool_names: list[str]) -> str:
    """Format tool names + descriptions + required params for the flat-text prompt."""
    # Build a compact param hint for each tool from its schema
    _PARAM_HINTS: dict[str, str] = {}
    for t, schema in _TOOL_PARAM_SCHEMAS.items():
        required = schema.get("required", [])
        props = schema.get("properties", {})
        if not required:
            _PARAM_HINTS[t] = ""
            continue
        param_names = []
        for r in required:
            ptype = props.get(r, {}).get("type", "string")
            pname = "PARAM_" + r.upper()
            param_names.append(f"{pname}")
            # Also show commonly-expected optional params for key tools
        extras = []
        if t in ("write_file", "edit_file", "apply_patch", "read_worktree_file", "bash"):
            extras.append("PARAM_WORKTREE_ID")
        if t == "edit_file":
            pass  # old_string/new_string already covered
        all_params = param_names + extras
        _PARAM_HINTS[t] = " Params: " + ", ".join(all_params) + "."

    lines: list[str] = []
    for t in sorted(tool_names):
        desc = _TOOL_DESCRIPTIONS.get(t, "")
        hint = _PARAM_HINTS.get(t, "")
        if desc:
            line = f"  {t} — {desc}"
            if hint:
                line += hint
            lines.append(line)
        else:
            lines.append(f"  {t}")
    return "\n".join(lines)


# ── FC-optimized prompt (no output format instructions — tools are defined via API) ──
CORE_TOOL_PLAN_PROMPT_FC = """\
═══ IDENTITY ═══
You are Oasis Cognition, an autonomous coding agent. You solve technical tasks by calling the available functions.

═══ SCOPE ═══
Read-only tools run in a container at `/workspace`.
**bash** runs on the **host dev-agent** — for `npm install`/`pip install` you MUST have a worktree first (create_worktree).

═══ RULES ═══
- Bias to ACTION, not exploration. After 2 read-only tools, implement.
- Never repeat the exact same tool call.
- NEVER tell the user to do it themselves.
- Be truthful. Use tools when needed. Complete the task.
- Use `think` only when you need to plan, debug, analyze, or decide between approaches.
  For simple actions (read a file, search, run bash), just call the tool directly.
- **PREFER `edit_file` OVER `apply_patch`.** `edit_file` uses old_string→new_string replacement (simple, reliable). `apply_patch` requires correct unified diffs which models often get wrong. Only use `apply_patch` as a last resort if `edit_file` fails repeatedly.
"""


# ── Router Agent prompt (tiny — 2B model, <20 output tokens) ─────
ROUTER_PROMPT = """\
You classify user requests.

Output EXACTLY 3 lines (no extra text):

COMPLEXITY: simple | medium | complex
DOMAIN: chat | coding | planning | workflow | memory | extraction
REASONING: true | false

Definitions:
simple — retrieval, factual questions, extraction, summarization, casual conversation.
medium — code generation, SQL, transformations, drafting, moderate analysis.
complex — debugging, architecture, multi-step planning, workflow design, root-cause analysis.
REASONING=true when the request requires deliberate planning, evaluation of alternatives, debugging, or causal analysis."""


async def route_request(
    user_message: str,
    chat_history: list[dict[str, str]] | None = None,
    llm_client: "LLMClient" | None = None,
) -> dict[str, str]:
    """Classify a user request using the smallest available model (2B).

    Returns descriptive classification (no model assignment):
      {"complexity": "simple"|"medium"|"complex",
       "domain": "chat"|"coding"|"planning"|"workflow"|"memory"|"extraction",
       "reasoning": "true"|"false"}

    Model selection is done by the calling orchestration layer as a policy decision.
    """
    from packages.shared_utils.llm_client import LLMClient

    cl = llm_client
    if cl is None:
        from packages.shared_utils.config import get_settings
        settings = get_settings()
        router_model = (settings.router_model or "").strip() or None
        cl = LLMClient(settings)
        if router_model:
            model_override = router_model
        else:
            model_override = settings.llm_model

    # Build a tiny context with the last user message + recent history
    context_parts = [user_message]
    if chat_history:
        recent = chat_history[-4:]
        for m in recent:
            role = m.get("role", "?").upper()
            content = (m.get("content", "") or "")[:200]
            context_parts.append(f"{role}: {content}")
    combined = "\n\n".join(context_parts)

    try:
        raw = await cl.chat_async(
            system=ROUTER_PROMPT,
            user_message=combined,
            model=model_override if router_model else settings.llm_model,
            max_tokens=64,
            stop=["\n\n"],   # cut off at first blank line — router only needs 3 lines
            temperature=0,
        )
    except Exception as e:
        logger.warning("Route request LLM call failed: %s", e)
        # Safe fallback — route as simple chat (2B, cheapest)
        return {"complexity": "simple", "domain": "chat", "reasoning": "false"}

    return _parse_router_output(raw)


def _parse_router_output(raw: str) -> dict[str, str]:
    """Parse the router's 3-line structured output."""
    result = {"complexity": "simple", "domain": "chat", "reasoning": "false"}
    for line in (raw or "").splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().upper()
        val = val.strip().lower()
        if key == "COMPLEXITY" and val in ("simple", "medium", "complex"):
            result["complexity"] = val
        elif key == "DOMAIN" and val in ("chat", "coding", "planning", "workflow", "memory", "extraction"):
            result["domain"] = val
        elif key == "REASONING" and val in ("true", "false"):
            result["reasoning"] = val
    return result
# Instead of a single monolithic prompt (previously ~500+ lines),
# we use a ~50-line CORE_PROMPT + injected rule packs.
# Rule packs are added just-in-time based on the model's planned action,
# keeping the per-iteration context small—especially for 2B-8B models.
# Model can also proactively look up rules using the get_rule tool.

RULE_PACKS: dict[str, str] = {}

# ── TOOL_RULES: tool selection, patch format, chunked reads, worktree discipline ──
TOOL_RULES = """\
Tool priority: edit_file >> write_file (new files only) >> apply_patch (last resort — models struggle with unified diffs).
Path: repo-relative for worktree tools (e.g. apps/foo/bar.tsx), /workspace/ prefix for read-only (read_file, grep, list_dir).
read_worktree_file MANDATORY before every edit. Use chunked reads (start_line/end_line).
If truncated at N of M lines, immediately read next chunk (start_line=N+1).
edit_file: use old_string→new_string with EXACT text copied from read_worktree_file output.
apply_patch (last resort): unified diff format:
--- a/<repo-relative-path>
+++ b/<repo-relative-path>
@@ -START,COUNT +START,COUNT @@
 context line (leading space)
-removed line
+added line
Always a/ b/ prefixes. Accurate @@ counts. Leading space on context. End with newline.
ONE worktree per session. Extract id from create_worktree output. Reuse for ALL edits.
For bash with npm/pnpm/yarn/pip install: MUST have worktree (create_worktree first), then PARAM_WORKTREE_ID.
"""

# ── DELEGATION_RULES: when/how to delegate_tasks, missions, workflows ──
DELEGATION_RULES = """\
delegate_tasks: use for 3+ independent files/modifications. Each task runs in own sub-agent.
  PARAM_GOAL: overall goal; PARAM_TASKS: JSON array [{id, goal, depends_on?, resource_class?}]
  Tasks without depends_on run in parallel.
  After submit, check delegate_job_status, then delegate_job_results.
  NOT for: simple single-file edits, tightly-coupled work.
mission_create: recurring background goal with cron schedule. PARAM_GOAL + PARAM_SCHEDULE (5-field cron).
  mission_id auto-inherited after creation: omit on subsequent mission_* calls.
workflow_create: DAG of nodes (input, output, mcp_tool, http, delay, branch, filter, transform).
  Prefer incremental: workflow_create(PARAM_NAME only) then workflow_add_node / workflow_add_edge.
  workflow_id auto-inherited after creation.
"""

# ── MEMORY_RULES: knowledge graph, self-teaching rules ──
MEMORY_RULES = """\
Use knowledge graph for code symbols, import relationships, component hierarchies.
Knowledge graph summary = session memory. Trust it; don't re-explore.
Self-teaching: teach_rule after discovering facts, after failed attempts, or after successful impl.
  Atomic: ONE fact per rule. General: not codebase-specific paths. Verifiable from docs.
update_rule / delete_rule: modify existing rules.
"""

# ── SAFETY_RULES: destructive ops, approval, protected paths ──
SAFETY_RULES = """\
Destructive filesystem operations (rm -rf, sudo, etc.) require alternative approaches.
Protected directories: /etc, /usr, /bin, /sbin, /var — avoid.
Blocked commands: try without sudo, use worktree edits instead.
Read-only sandbox at /workspace; bash runs on host dev-agent.
NEVER give up because a command was blocked; find another way.
"""

# ── RECOVERY_RULES: what to do when tools fail ──
RECOVERY_RULES = """\
edit_file failed: read_worktree_file target section with start_line/end_line, copy EXACT old_string from output, retry.
File not found: find_files or list_dir to discover correct path. Do NOT retry same path.
old_string not found: double-check indentation and whitespace. Read the exact lines again and copy character-for-character.
No grep results: try different keywords, broader path, or find_files instead.
Blocked command: try different approach (e.g., edit package.json instead of npm install).
WALLS list = paths that already failed; do NOT retry.
Prefer FIX AND RETRY over abandoning mid-edit.
"""

# ── FINAL_ANSWER_RULES: verification before answering ──
FINAL_ANSWER_RULES = """\
Before final_answer: verify completion by checking files, running tests, showing diff.
Do NOT self-assign additional work beyond the user's request.
Answer in second person (you/your). Keep concise (2-5 sentences).
Only answer when: (1) user's request addressed AND (2) no pending observer feedback.
NEVER give instructions for the user to do something themselves.
"""

# ── CODING_RULES: apply_patch format, edit ordering ──
CODING_RULES = """\
Edit workflow: grep → read_file → create_worktree → read_worktree_file → edit_file → verify → get_diff.
edit_file is DEFAULT. write_file for new files only. apply_patch last resort (models often generate corrupt diffs).
Chunked reads ALWAYS. Never full-file read files over 100 lines.
Phase 1 (before worktree): read_file from /workspace. Phase 2 (after worktree): read_worktree_file.
CRITICAL: Copy context lines EXACTLY from read output — indentation matters.
For edit_file: old_string must match EXACTLY (including whitespace). Copy-paste from read_worktree_file output.
MAXIMUM 2 read-only tools before creating worktree and editing.
"""

# ── PLANNING_RULES: upfront plan structure, step sequencing ──
PLANNING_RULES = """\
Upfront plan is your roadmap. Follow steps sequentially.
Observer feedback = THE BOSS. If observer is unsatisfied, continue; do NOT final_answer.
Agent Thoughts = BINDING COMMITMENTS. Execute actions identified in thoughts.
IMPLEMENT WITH PARTIAL INFO: Better to edit with 80% confidence than explore 5 more times.
After 2 read-only tools (grep, list_dir, read_file), MUST switch to action (create_worktree → edit).
"""

# Populate the RULE_PACKS registry so JIT injection can look them up by name.
RULE_PACKS["tool_rules"] = TOOL_RULES
RULE_PACKS["delegation_rules"] = DELEGATION_RULES
RULE_PACKS["memory_rules"] = MEMORY_RULES
RULE_PACKS["safety_rules"] = SAFETY_RULES
RULE_PACKS["recovery_rules"] = RECOVERY_RULES
RULE_PACKS["final_answer_rules"] = FINAL_ANSWER_RULES
RULE_PACKS["coding_rules"] = CODING_RULES
RULE_PACKS["planning_rules"] = PLANNING_RULES

from packages.shared_utils.json_utils import extract_json


# ---------------------------------------------------------------------------
# Token estimation & context budget
# ---------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English / mixed code."""
    return max(1, len(text or "") // 4)


def _compute_input_budget(settings: Settings) -> int:
    """Max tokens available for the *input* (system + user message).

    input_budget = context_window − max_output_tokens
    We also subtract a small safety margin (256 tokens) so the model
    never gets a request that is exactly at the edge.
    """
    cw = settings.context_window
    out_reserve = int(cw * settings.context_output_reserve)
    # Ensure we at least reserve llm_max_tokens for output
    out_reserve = max(out_reserve, settings.llm_max_tokens)
    budget = cw - out_reserve - 256
    return max(settings.llm_max_tokens, budget)  # never less than llm_max_tokens tokens


def _truncate_to_budget(text: str, max_tokens: int) -> str:
    """Truncate *text* so it fits within *max_tokens* (approximate)."""
    if estimate_tokens(text) <= max_tokens:
        return text
    max_chars = max_tokens * 4
    return text[:max_chars] + "\n... [truncated to fit context budget]"


class ContextBudget:
    """Tracks how much of the input budget is consumed and truncates sections."""

    def __init__(self, settings: Settings):
        self._settings = settings
        self.total = _compute_input_budget(settings)
        self.used = 0
        self._breakdown: dict[str, int] = {}

    @property
    def remaining(self) -> int:
        return max(0, self.total - self.used)

    def allocate(self, label: str, text: str, max_share: float = 1.0) -> str:
        """Return (possibly truncated) text that fits within *max_share* of total budget.

        Records the actual tokens consumed under *label*.
        """
        cap = int(self.total * max_share)
        available = min(cap, self.remaining)
        result = _truncate_to_budget(text, available)
        tokens = estimate_tokens(result)
        self.used += tokens
        self._breakdown[label] = self._breakdown.get(label, 0) + tokens
        return result

    def record(self, label: str, text: str) -> None:
        """Record consumption without truncating (for parts we cannot shrink)."""
        tokens = estimate_tokens(text)
        self.used += tokens
        self._breakdown[label] = self._breakdown.get(label, 0) + tokens

    def as_dict(self) -> dict:
        return {
            "context_window": self._settings.context_window,
            "input_budget": self.total,
            "input_used": self.used,
            "input_remaining": self.remaining,
            "breakdown": dict(self._breakdown),
        }


def _extract_fallback_keyword(user_message: str) -> str | None:
    """Extract a simple keyword for a deterministic fallback tool-plan."""
    tokens = re.findall(r"[A-Za-z0-9_]{4,}", user_message or "")
    if not tokens:
        return None
    # Escape so the keyword is safe as a regex pattern.
    return re.escape(tokens[0])


_STATIC_PROJECT_CONTEXT_PATHS = [
    Path(__file__).resolve().parent.parent.parent / ".oasis-context.md",
    Path("/workspace/.oasis-context.md"),
]
_project_context_cache: str = ""
_project_context_mtime: float = 0.0


def _get_project_context_paths() -> list[Path]:
    """Build context paths dynamically so PROJECT_ROOT changes are picked up.

    Priority: active-project paths first, then static fallbacks.
    This ensures that when the user switches projects, the new project's
    context is loaded instead of the default oasis-cognition context.
    """
    paths: list[Path] = []

    # 1. Dynamic paths — highest priority (active project)
    project_root = os.environ.get("PROJECT_ROOT", "")
    if project_root:
        paths.append(Path(project_root) / ".oasis-context.md")

    # 2. Docker /host-home translation of the active project
    host_home = os.environ.get("OASIS_HOST_HOME", "")
    if host_home and project_root:
        # project_root might be a host path like /Users/stevetran/gs-tinh-cds
        if project_root.startswith(host_home):
            docker_path = "/host-home" + project_root[len(host_home):]
            paths.append(Path(docker_path) / ".oasis-context.md")
        elif not project_root.startswith("/host-home"):
            # Try common home prefixes
            for prefix in ("/Users/", "/home/"):
                if project_root.startswith(prefix):
                    # e.g. /Users/stevetran/gs-tinh-cds → /host-home/gs-tinh-cds
                    # when HOME=/Users/stevetran, strip HOME prefix
                    remainder = project_root[len(host_home):] if project_root.startswith(host_home) else None
                    if remainder:
                        paths.append(Path("/host-home" + remainder) / ".oasis-context.md")
                    break

    # 3. Static fallbacks (default oasis-cognition context)
    paths.extend(_STATIC_PROJECT_CONTEXT_PATHS)

    return paths


def _load_project_context() -> str:
    """Load project context from .oasis-context.md if available.

    Hot-reloads: re-reads the file when its mtime changes so the Docker
    volume-mounted copy is picked up without a container restart.
    """
    global _project_context_cache, _project_context_mtime
    for candidate in _get_project_context_paths():
        if candidate.is_file():
            try:
                mtime = candidate.stat().st_mtime
                if mtime != _project_context_mtime or not _project_context_cache:
                    text = candidate.read_text().strip()
                    _project_context_cache = f"\n\n--- PROJECT CONTEXT (for your awareness) ---\n{text}\n--- END PROJECT CONTEXT ---\n"
                    _project_context_mtime = mtime
                    logger.info(
                        "Loaded project context from %s (%d chars, mtime=%.0f)",
                        candidate,
                        len(text),
                        mtime,
                    )
                return _project_context_cache
            except Exception as e:
                logger.warning(
                    "Failed to read project context from %s: %s", candidate, e
                )
    if not _project_context_cache:
        logger.info("No .oasis-context.md found — running without project context")
    return _project_context_cache


def _force_reload_project_context() -> None:
    """Reset the cache so the next call to _load_project_context() re-reads from disk."""
    global _project_context_cache, _project_context_mtime
    _project_context_cache = ""
    _project_context_mtime = 0.0
    logger.info("Project context cache cleared — will reload on next request")


PROJECT_CONTEXT = _load_project_context()

# Exact strings allowed in {"action":"call_tool","tool":"..."} (plus teach/update/delete as actions).
TOOL_PLAN_ALLOWED_TOOLS: tuple[str, ...] = (
    "search_artifacts",
    "read_artifact",
    "bash",
    "read_file",
    "list_dir",
    "grep",
    "find_files",
    "browse_url",
    "create_worktree",
    "write_file",
    "edit_file",
    "apply_patch",
    "read_worktree_file",
    "get_diff",
    "computer_action",
    "web_search",
    # Workflow + trigger tools (authored in-chat, executed by the workflow engine)
    "workflow_list",
    "workflow_get",
    "workflow_create",
    "workflow_update",
    "workflow_delete",
    "workflow_run",
    "workflow_runs_list",
    "workflow_get_run",
    "workflow_cancel_run",
    "node_catalog",
    "trigger_create",
    "trigger_list",
    "trigger_update",
    "trigger_delete",
    "workflow_add_node",
    "workflow_add_edge",
    "workflow_remove_node",
    # Mission tools — recurring background tasks the agent owns on the user's behalf.
    "mission_create",
    "mission_list",
    "mission_get",
    "mission_update",
    "mission_delete",
    "mission_pause",
    "mission_resume",
    "mission_run",
    # Coordinator tools — parallel sub-agent delegation.
    "delegate_tasks",
    "delegate_job_status",
    "delegate_job_cancel",
    "delegate_job_results",
    # JIT rule retrieval — model can request rule packs on demand
    "get_rule",
    # Explicit thinking — model uses this instead of automatic pre-thinking
    "think",
    # Tool discovery — search for MCP tools and skills on demand
    "search_mcp",
    "search_skills",
)


def _norm_tool_key(s: str) -> str:
    return s.strip().lower().replace("-", "_")


_ALLOWED_TOOL_BY_KEY: dict[str, str] = {
    _norm_tool_key(t): t for t in TOOL_PLAN_ALLOWED_TOOLS
}

# LLM aliases → canonical executor tool name (values must match TOOL_PLAN_ALLOWED_TOOLS).
_TOOL_NAME_ALIASES: dict[str, str] = {
    _norm_tool_key(k): v
    for k, v in {
        "edit": "edit_file",
        "search_replace": "edit_file",
        "apply_patch": "apply_patch",
        "patch": "apply_patch",
        "unified_diff": "apply_patch",
        "replace": "edit_file",
        "read_dir": "list_dir",
        "listdir": "list_dir",
        "dir_list": "list_dir",
        "open_file": "read_file",
        "file_search": "find_files",
        "glob": "find_files",
        "glob_file_search": "find_files",
        "rg": "grep",
        "ripgrep": "grep",
        "shell": "bash",
        "terminal": "bash",
        "run_terminal_cmd": "bash",
        "run_terminal": "bash",
        "worktree_create": "create_worktree",
        "wt_read": "read_worktree_file",
        "read_worktree": "read_worktree_file",
        "show_diff": "get_diff",
        "diff": "get_diff",
        "computer": "computer_action",
        "mouse_click": "computer_action",
        "screen": "computer_action",
        "screenshot": "computer_action",
        "click": "computer_action",
        "type_text": "computer_action",
        "key_press": "computer_action",
        "get_artifact": "read_artifact",
        "fetch_artifact": "read_artifact",
        "artifact_content": "read_artifact",
        "view_artifact": "read_artifact",
        "delegate": "delegate_tasks",
        "parallel_tasks": "delegate_tasks",
        "parallel": "delegate_tasks",
        "spawn": "delegate_tasks",
        "spawn_subagents": "delegate_tasks",
        "subagent": "delegate_tasks",
        "job_status": "delegate_job_status",
        "task_status": "delegate_job_status",
        "cancel_job": "delegate_job_cancel",
        "cancel_task": "delegate_job_cancel",
        "get_results": "delegate_job_results",
        "job_results": "delegate_job_results",
        "task_results": "delegate_job_results",
        "aggregate_results": "delegate_job_results",
    }.items()
}


def _extract_tool_name_from_prose(s: str) -> str | None:
    """If ACTION is a sentence ('Use the `grep` tool to…'), infer the executor tool name."""
    if not s or not str(s).strip():
        return None
    text = str(s)
    candidates: list[tuple[int, str]] = []

    for m in re.finditer(r"`([a-z][a-z0-9_]*)`", text, re.I):
        w = m.group(1).lower()
        k = _norm_tool_key(w)
        if k in _TOOL_NAME_ALIASES:
            k = _norm_tool_key(_TOOL_NAME_ALIASES[k])
        if k in _ALLOWED_TOOL_BY_KEY:
            candidates.append((m.start(), _ALLOWED_TOOL_BY_KEY[k]))

    for t in TOOL_PLAN_ALLOWED_TOOLS:
        pat = r"(?i)\b" + re.escape(t).replace(r"\_", r"[_]") + r"\b"
        for m in re.finditer(pat, text):
            candidates.append((m.start(), t))
        parts = t.split("_")
        if len(parts) > 1:
            inner = r"[_\s]+".join(re.escape(p) for p in parts)
            pat2 = r"(?i)\b" + inner + r"\b"
            for m in re.finditer(pat2, text):
                candidates.append((m.start(), t))

    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], -len(x[1])))
    return candidates[0][1]


def _canonicalize_tool_name(raw: str) -> tuple[str | None, str | None]:
    """Return (canonical_tool, None) or (None, error_message for retry hint)."""
    if raw is None or not str(raw).strip():
        return None, "Missing tool name."
    s = str(raw).strip()
    key = _norm_tool_key(s)
    compact = key.replace("_", "")
    # No desktop IDE / editor integrations — models often hallucinate these.
    for marker in (
        "vscode",
        "visualstudio",
        "sublime",
        "jetbrains",
        "intellij",
        "webstorm",
        "pycharm",
        "atomeditor",
        "zededitor",
        "eclipse",
        "xcode",
    ):
        if marker in compact:
            return None, (
                f"You used {s!r} — there is NO integration with desktop IDEs or editors. "
                "The only way to change code is create_worktree → edit_file or write_file → get_diff."
            )
    if key in _TOOL_NAME_ALIASES:
        key = _norm_tool_key(_TOOL_NAME_ALIASES[key])
    if key in _ALLOWED_TOOL_BY_KEY:
        return _ALLOWED_TOOL_BY_KEY[key], None

    extracted = _extract_tool_name_from_prose(s)
    if extracted:
        ekey = _norm_tool_key(extracted)
        if ekey in _TOOL_NAME_ALIASES:
            ekey = _norm_tool_key(_TOOL_NAME_ALIASES[ekey])
        if ekey in _ALLOWED_TOOL_BY_KEY:
            return _ALLOWED_TOOL_BY_KEY[ekey], None

    allowed = ", ".join(TOOL_PLAN_ALLOWED_TOOLS)
    return (
        None,
        f"Unknown tool {s!r}. You MUST use one of: {allowed}. For search-replace edits use edit_file (not 'edit').",
    )


def _normalize_tool_plan_output(parsed: dict[str, Any]) -> dict[str, Any]:
    """Normalize common LLM mistakes in tool-plan JSON output."""
    # Already valid
    if parsed.get("action") in (
        "call_tool",
        "final_answer",
        "teach_rule",
        "update_rule",
        "delete_rule",
    ):
        plan = parsed
    else:
        # tool_id -> action: call_tool, tool
        tool = parsed.get("tool") or parsed.get("tool_id")
        if tool and isinstance(tool, str):
            plan = {
                "action": "call_tool",
                "tool": tool,
                "reasoning": str(
                    parsed.get("description", parsed.get("reasoning", ""))
                ),
            }
            for key in (
                "path",
                "command",
                "pattern",
                "url",
                "worktree_id",
                "content",
                "old_string",
                "new_string",
                "patch",
                "name",
                "recursive",
                "file_type",
                "condition",
                "conclusion",
                "confidence",
                "rule_id",
                # ── Workflow + trigger tool params ──
                "description",
                "enabled",
                "limit",
                "input",
                "workflow_id",
                "workflow_json",
                "run_id",
                "trigger_id",
                "trigger_type",
                "trigger_config",
                "node_id",
                "node_type",
                "node_params",
                "from_node",
                "from_port",
                "to_node",
                "to_port",
                # ── Computer-use action shape (passed through unchanged) ──
                "action",
                "x",
                "y",
                "text",
                "key",
                "keys",
                "button",
                "direction",
                "amount",
                "clicks",
                # ── Common LLM extras ──
                "start_line",
                "end_line",
                "query",
                "artifact_id",
            ):
                if parsed.get(key) is not None:
                    plan[key] = parsed[key]
            # Default path for path-based tools
            if (
                tool in ("read_file", "list_dir", "grep", "find_files")
                and "path" not in plan
            ):
                plan["path"] = "/workspace"
            if tool == "grep" and "pattern" not in plan:
                plan["pattern"] = (
                    parsed.get("args", ["pattern"])[0]
                    if parsed.get("args")
                    else "pattern"
                )
        else:
            # Has "answer" or "output" -> treat as final_answer
            answer = parsed.get("answer") or parsed.get("output")
            if isinstance(answer, str) and len(answer) > 10:
                return {"action": "final_answer", "answer": answer}
            return parsed

    # ── Validate required params and auto-fix common mistakes ──
    if plan.get("action") == "call_tool":
        raw_tool = plan.get("tool", "")
        canonical, tool_err = _canonicalize_tool_name(
            str(raw_tool) if raw_tool is not None else ""
        )
        if tool_err:
            return {
                "action": "final_answer",
                "answer": f"[INTERNAL: INVALID_TOOL] {tool_err}",
                "_retry_hint": True,
            }
        plan["tool"] = canonical
        tool = canonical
        # edit_file: path + strings required; worktree_id filled by API gateway from last create_worktree if omitted
        if tool == "edit_file":
            # new_string may be "" (delete old_string); only None/absent is invalid.
            missing = []
            if not str(plan.get("path") or "").strip():
                missing.append("path")
            if plan.get("old_string") is None or str(plan.get("old_string", "")) == "":
                missing.append("old_string")
            if plan.get("new_string") is None:
                missing.append("new_string")
            if missing:
                return {
                    "action": "final_answer",
                    "answer": f"[INTERNAL: edit_file missing required params: {', '.join(missing)}. "
                    f"You must provide path, old_string, and new_string (exact text from read_worktree_file — do NOT include line numbers from the read output).]",
                    "_retry_hint": True,
                }
            # Remind about worktree_id if missing
            if not plan.get("worktree_id"):
                return {
                    "action": "final_answer",
                    "answer": "[INTERNAL: edit_file requires PARAM_WORKTREE_ID. "
                    "Extract the worktree id from the create_worktree output (e.g., 'feat-highlight' from 'Worktree feat-highlight created'). "
                    "Use: PARAM_WORKTREE_ID: <the-id-from-create_worktree>]",
                    "_retry_hint": True,
                }
        # write_file: worktree_id optional at parse time (gateway coalesces)
        elif tool == "write_file":
            missing = []
            if not str(plan.get("path") or "").strip():
                missing.append("path")
            if plan.get("content") is None:
                missing.append("content")
            if missing:
                return {
                    "action": "final_answer",
                    "answer": f"[INTERNAL: write_file missing required params: {', '.join(missing)}. "
                    f"You must provide path and content.]",
                    "_retry_hint": True,
                }
            # Remind about worktree_id if missing
            if not plan.get("worktree_id"):
                return {
                    "action": "final_answer",
                    "answer": "[INTERNAL: write_file requires PARAM_WORKTREE_ID. "
                    "Extract the worktree id from the create_worktree output (e.g., 'feat-highlight' from 'Worktree feat-highlight created'). "
                    "Use: PARAM_WORKTREE_ID: <the-id-from-create_worktree>]",
                    "_retry_hint": True,
                }
        elif tool == "apply_patch":
            if plan.get("patch") is None or not str(plan.get("patch", "")).strip():
                return {
                    "action": "final_answer",
                    "answer": (
                        "[INTERNAL: apply_patch requires patch: a unified diff string (---/+++ hunks). "
                        "Use repo-relative paths like apps/foo.tsx (not /workspace/...). "
                        "Prefer edit_file over apply_patch — models often generate corrupt unified diffs. "
                        "For multi-line edits, use edit_file with exact old_string copied from read_worktree_file output.]"
                    ),
                    "_retry_hint": True,
                }
            # Remind about worktree_id if missing
            if not plan.get("worktree_id"):
                return {
                    "action": "final_answer",
                    "answer": "[INTERNAL: apply_patch requires PARAM_WORKTREE_ID. "
                    "Extract the worktree id from the create_worktree output (e.g., 'feat-highlight' from 'Worktree feat-highlight created'). "
                    "Use: PARAM_WORKTREE_ID: <the-id-from-create-worktree>]",
                    "_retry_hint": True,
                }
        # read_worktree_file: worktree_id optional at parse time (gateway coalesces)
        elif tool == "read_worktree_file":
            if not plan.get("path"):
                return {
                    "action": "final_answer",
                    "answer": "[INTERNAL: read_worktree_file requires path. PARAM_WORKTREE_ID is filled from the session worktree if omitted.]",
                    "_retry_hint": True,
                }
        # create_worktree: must have name
        elif tool == "create_worktree":
            if not plan.get("name"):
                plan["name"] = "workspace"  # auto-fix with default name
        # find_files: must have pattern
        elif tool == "find_files":
            if not plan.get("pattern"):
                return {
                    "action": "final_answer",
                    "answer": "[INTERNAL: find_files requires a pattern (e.g. '*.tsx', 'CodeBlock*').]",
                    "_retry_hint": True,
                }

    return plan


# ── Flat tool-plan format (LLM emits key: value lines; system maps to JSON plan) ──


def parse_flat_tool_plan_lines(text: str) -> dict[str, str]:
    """Parse `KEY: value` lines (one key per line). Keys are normalized to UPPER.

    Handles multi-line values for PARAM_CONTENT, PARAM_PATCH, PARAM_OLD_STRING,
    PARAM_NEW_STRING by continuing to read until the next KEY: line.
    """
    out: dict[str, str] = {}
    lines = (text or "").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Skip empty lines and comments
        if not stripped or stripped.startswith("#"):
            i += 1
            continue

        # Check if this is a KEY: value line
        if ":" not in stripped:
            i += 1
            continue

        idx = stripped.index(":")
        key = stripped[:idx].strip().upper()
        val = stripped[idx + 1 :].strip()

        if not key:
            i += 1
            continue

        # Multi-line content params that should capture until next KEY:
        multiline_params = {
            "PARAM_CONTENT",
            "PARAM_PATCH",
            "PARAM_OLD_STRING",
            "PARAM_NEW_STRING",
        }

        if key in multiline_params:
            # Collect all lines until we hit the next KEY: line
            content_lines = [val] if val else []
            i += 1
            while i < len(lines):
                next_line = lines[i]
                next_stripped = next_line.strip()
                # Check if next line starts a new KEY:
                if next_stripped and ":" in next_stripped:
                    potential_key = (
                        next_stripped[: next_stripped.index(":")].strip().upper()
                    )
                    if potential_key and (
                        potential_key in multiline_params
                        or potential_key
                        in {
                            "REASONING",
                            "DECISION",
                            "ACTION",
                            "ANSWER",
                            "QUESTION",
                            "OPTIONS",
                            "MESSAGE",
                            "RESPONSE",
                        }
                        or potential_key.startswith("PARAM_")
                    ):
                        break
                # This line is part of the content
                content_lines.append(next_line)  # Keep original indentation
                i += 1
            out[key] = "\n".join(content_lines)
        else:
            out[key] = val
            i += 1

    return out


# First line that looks like a tool-plan key (models sometimes prepend echoed user context).
_TOOL_PLAN_KEY_LINE = re.compile(
    r"(?m)^\s*\*{0,2}(REASONING|DECISION|ACTION|ANSWER|QUESTION|OPTIONS|MESSAGE|RESPONSE|PARAM_[A-Z0-9_]+)(?:\*{0,2})?\s*:",
    re.I,
)


def _strip_tool_plan_preamble(text: str) -> str:
    """Drop leading prose so flat parse sees REASONING:/DECISION: first."""
    if not text:
        return ""
    m = _TOOL_PLAN_KEY_LINE.search(text)
    if not m:
        return text
    return text[m.start() :].lstrip()


def _unescape_flat_param_value(v: str) -> str:
    """Minimal unescape for PARAM values that contain literal \\n in one line."""
    if not v:
        return v
    return v.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')


def _flat_truthy(v: str) -> bool | None:
    s = (v or "").strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off", ""):
        return False
    return None


def _flat_collect_params(flat: dict[str, str]) -> dict[str, Any]:
    """Collect PARAM_* into snake_case keys (PARAM_WORKTREE_ID → worktree_id)."""
    params: dict[str, Any] = {}
    for k, v in flat.items():
        if not k.startswith("PARAM_"):
            continue
        name = k[6:].lower()
        raw = _unescape_flat_param_value(v.strip())
        if name == "recursive":
            tv = _flat_truthy(raw)
            params[name] = tv if tv is not None else raw
        elif name == "confidence":
            try:
                params[name] = float(raw)
            except ValueError:
                params[name] = raw
        else:
            params[name] = raw
    return params


def _normalize_flat_decision(raw: str) -> str:
    """Map DECISION line to exactly ACT | ANSWER_DIRECTLY | NEED_MORE_INFO.

    Models often emit prose (e.g. 'PROCEED WITH SEARCHING…') instead of the enum.
    """
    s = (raw or "").strip().upper()
    if not s:
        return "INVALID"
    if s in ("ACT", "ANSWER_DIRECTLY", "NEED_MORE_INFO"):
        return s
    # Prefix match: "ACT.", "ACT —", "ACT:"
    if re.match(r"^ACT\b", s):
        return "ACT"
    if re.match(r"^ANSWER_DIRECTLY\b", s):
        return "ANSWER_DIRECTLY"
    if re.match(r"^NEED_MORE_INFO\b", s):
        return "NEED_MORE_INFO"
    # Synonyms / short forms
    if s in ("ANSWER", "RESPOND", "RESPONSE", "FINAL", "FINALIZE"):
        return "ANSWER_DIRECTLY"
    if s in ("ASK", "QUESTION", "CLARIFY", "MORE_INFO"):
        return "NEED_MORE_INFO"

    # Phrase heuristics (order: clarify first, then finish, then explore)
    if re.search(
        r"\b(NEED MORE INFO|NEED CLARIFICATION|ASK THE USER|CLARIFYING QUESTION|MORE INFORMATION FROM USER)\b",
        s,
    ):
        return "NEED_MORE_INFO"
    if re.search(
        r"\b(ANSWER DIRECTLY|DONE WITH TASK|READY TO RESPOND|FINAL RESPONSE|TASK COMPLETE|SUMMARIZE FOR USER)\b",
        s,
    ):
        return "ANSWER_DIRECTLY"
    if re.search(
        r"\b(PROCEED|CONTINUE|KEEP (GOING|EXPLORING)|NEXT TOOL|NEXT STEP|"
        r"SEARCH(ING)?|LOOK(ING)? FOR|FIND(ING)?|LOCATE|INVESTIGATE|EXPLORE|"
        r"GREP|LIST.?DIR|READ.?FILE|IMPLEMENT|EXECUTE|RUN (THE )?(COMMAND|TOOL)|"
        r"USE (THE )?(TOOL|BASH|GREP)|CREATE.?WORKTREE|EDIT.?FILE|WRITE.?FILE)\b",
        s,
    ):
        return "ACT"
    # Long prose that still implies tooling / exploration
    if (
        len(s) > 10
        and re.search(
            r"\b(CODEBASE|WORKSPACE|FILES?|COMPONENTS?|REPOSITORY|EXISTING IMPLEMENTATION)\b",
            s,
        )
        and not re.search(r"\b(USER ASKED|FINAL ANSWER|TELL THE USER)\b", s)
    ):
        return "ACT"

    return "INVALID"


def flat_dict_to_plan(flat: dict[str, str]) -> dict[str, Any]:
    """Convert flat key-value intent into the same shape as JSON tool-plan output."""
    decision_raw = (flat.get("DECISION") or "").strip()
    decision = _normalize_flat_decision(decision_raw)
    reasoning = (flat.get("REASONING") or "").strip()
    params = _flat_collect_params(flat)

    if decision == "INVALID":
        return {
            "action": "final_answer",
            "answer": (
                f"[INTERNAL: invalid DECISION {decision_raw!r}; "
                "use exactly one of: ACT, ANSWER_DIRECTLY, NEED_MORE_INFO — no other text on the line]"
            ),
            "_retry_hint": True,
            "reasoning": reasoning,
        }

    if decision == "ANSWER_DIRECTLY":
        ans = (
            flat.get("ANSWER")
            or flat.get("MESSAGE")
            or flat.get("RESPONSE")
            or params.get("answer")
            or ""
        )
        if isinstance(ans, str):
            ans = ans.strip()
        return {"action": "final_answer", "answer": str(ans), "reasoning": reasoning}

    if decision == "NEED_MORE_INFO":
        q = (
            flat.get("QUESTION")
            or flat.get("MESSAGE")
            or flat.get("ANSWER")
            or "What additional detail should I use to proceed?"
        )
        return {
            "action": "final_answer",
            "answer": str(q).strip(),
            "reasoning": reasoning,
        }

    # decision is ACT (only remaining value after INVALID / ANSWER_DIRECTLY / NEED_MORE_INFO)
    raw_action = (flat.get("ACTION") or "").strip()
    if not raw_action:
        return {
            "action": "final_answer",
            "answer": "[INTERNAL: DECISION is ACT but ACTION is missing]",
            "_retry_hint": True,
            "reasoning": reasoning,
        }

    act_key = _norm_tool_key(raw_action)

    if act_key in ("teach_rule", "teach"):
        conclusion = str(
            params.get("conclusion") or params.get("assertion") or ""
        ).strip()
        if not conclusion:
            return {
                "action": "final_answer",
                "answer": "[INTERNAL: teach_rule requires PARAM_CONCLUSION or PARAM_ASSERTION]",
                "_retry_hint": True,
                "reasoning": reasoning,
            }
        conf_f = 0.8
        if (
            params.get("confidence") is not None
            and str(params.get("confidence")).strip()
        ):
            try:
                conf_f = float(params["confidence"])
            except (TypeError, ValueError):
                conf_f = 0.8
        return {
            "action": "teach_rule",
            "condition": str(
                params.get("condition") or params.get("underlying_concept") or ""
            ),
            "conclusion": conclusion,
            "category": str(params.get("category") or "rule"),
            "domain": str(params.get("domain") or "general"),
            "confidence": conf_f,
            "reasoning": reasoning,
        }

    if act_key == "update_rule":
        rid = str(params.get("rule_id") or "").strip()
        if not rid:
            return {
                "action": "final_answer",
                "answer": "[INTERNAL: update_rule requires PARAM_RULE_ID]",
                "_retry_hint": True,
                "reasoning": reasoning,
            }
        out: dict[str, Any] = {
            "action": "update_rule",
            "rule_id": rid,
            "reasoning": reasoning,
        }
        if params.get("condition") is not None:
            out["condition"] = str(params["condition"])
        if params.get("conclusion") is not None:
            out["conclusion"] = str(params["conclusion"])
        if isinstance(params.get("confidence"), (int, float)):
            out["confidence"] = float(params["confidence"])
        return out

    if act_key == "delete_rule":
        rid = str(params.get("rule_id") or "").strip()
        if not rid:
            return {
                "action": "final_answer",
                "answer": "[INTERNAL: delete_rule requires PARAM_RULE_ID]",
                "_retry_hint": True,
                "reasoning": reasoning,
            }
        return {"action": "delete_rule", "rule_id": rid, "reasoning": reasoning}

    # call_tool: ACTION is executor tool name
    canonical, tool_err = _canonicalize_tool_name(raw_action)
    if tool_err:
        return {
            "action": "final_answer",
            "answer": f"[INTERNAL: INVALID_TOOL] {tool_err}",
            "_retry_hint": True,
            "reasoning": reasoning,
        }
    plan: dict[str, Any] = {
        "action": "call_tool",
        "tool": canonical,
        "reasoning": reasoning,
    }
    param_key_whitelist = (
        "path",
        "command",
        "pattern",
        "url",
        "worktree_id",
        "content",
        "old_string",
        "new_string",
        "patch",
        "name",
        "recursive",
        "file_type",
        "query",
        "limit",
        "artifact_id",
        # Workflow + trigger tool params
        "description",
        "enabled",
        "input",
        "workflow_id",
        "workflow_json",
        "run_id",
        "trigger_id",
        "trigger_type",
        "trigger_config",
        "node_id",
        "node_type",
        "node_params",
        "from_node",
        "from_port",
        "to_node",
        "to_port",
        # Computer-use action fields
        "action",
        "x",
        "y",
        "text",
        "key",
        "keys",
        "button",
        "direction",
        "amount",
        "clicks",
        # Rules
        "condition",
        "conclusion",
        "confidence",
        "rule_id",
        # Chunked reads
        "start_line",
        "end_line",
    )
    for pk in param_key_whitelist:
        if pk not in params or params[pk] is None:
            continue
        if pk == "patch":
            plan[pk] = params[pk]
        elif str(params[pk]).strip() != "":
            plan[pk] = params[pk]
    # Defaults consistent with JSON path
    if (
        canonical in ("read_file", "list_dir", "grep", "find_files")
        and "path" not in plan
    ):
        plan["path"] = "/workspace"
    if canonical == "grep" and "pattern" not in plan:
        plan["pattern"] = "pattern"
    if canonical == "create_worktree" and "name" not in plan:
        plan["name"] = "workspace"
    return plan


def _memory_to_str(m: dict) -> str:
    """Extract a readable string from a memory entry (graph or semantic)."""
    content = m.get("content", m)
    if isinstance(content, str):
        return content[:500]
    if isinstance(content, dict):
        nodes = content.get("nodes", [])
        if nodes:
            return " | ".join(
                n.get("title", n.get("description", str(n)))[:80] for n in nodes[:5]
            )
        return str(content)[:500]
    return str(m)[:500]


def _categorize_walls(walls: list[str]) -> str:
    """Group walls by tool category and path pattern — a table of contents with drill-down instructions."""
    if not walls:
        return ""
    from collections import Counter
    by_tool: dict[str, list[str]] = {}
    for w in walls:
        w_lower = w.lower()
        if w_lower.startswith("path does not exist"):
            by_tool.setdefault("MISSING PATHS", []).append(w)
        elif w_lower.startswith("path/pattern not found"):
            by_tool.setdefault("BASH NOT FOUND", []).append(w)
        elif w_lower.startswith("grep for"):
            by_tool.setdefault("GREP NO MATCH", []).append(w)
        elif w_lower.startswith("edit_file"):
            by_tool.setdefault("EDIT FAILED", []).append(w)
        elif w_lower.startswith("apply_patch"):
            by_tool.setdefault("PATCH FAILED", []).append(w)
        elif w_lower.startswith("blocked"):
            by_tool.setdefault("BLOCKED", []).append(w)
        else:
            by_tool.setdefault("OTHER", []).append(w)
    lines: list[str] = [
        "═══ WALLS TOC (grouped failures — DO NOT RETRY blindly) ═══",
        f"Total: {len(walls)} failure(s). To inspect any failed path, use read_worktree_file or list_dir with the exact path to see its current state.",
    ]
    for category in ("EDIT FAILED", "PATCH FAILED", "MISSING PATHS", "GREP NO MATCH", "BASH NOT FOUND", "BLOCKED", "OTHER"):
        entries = by_tool.pop(category, [])
        if not entries:
            continue
        counts: Counter[str] = Counter()
        retrieve_instructions: list[str] = []
        for e in entries:
            path_part = e.split(":", 1)[-1].strip() if ":" in e else e[:60]
            counts[path_part] += 1
            if path_part not in retrieve_instructions and not path_part.startswith("'") and len(path_part) < 100:
                retrieve_instructions.append(path_part)
        if retrieve_instructions:
            drill = "; ".join(f"read_worktree_file {p}" for p in retrieve_instructions[:3])
            drill_hint = f" | drill down: {drill}"
        else:
            drill_hint = ""
        if len(entries) <= 2:
            detail = "; ".join(e.split(":", 1)[-1].strip()[:80] if ":" in e else e[:80] for e in entries)
            lines.append(f"  {category} ({len(entries)}x): {detail}{drill_hint}")
        else:
            counts_str = ", ".join(f"'{p[:60]}' x{c}" for p, c in counts.most_common(3))
            lines.append(f"  {category} ({len(entries)}x): {counts_str}{drill_hint}")
    leftover = by_tool.pop("OTHER", [])
    if leftover:
        lines.append(f"  OTHER ({len(leftover)}x): {'; '.join(e[:80] for e in leftover[:3])}")
    return "\n".join(lines)


def _format_rule(r: dict) -> str:
    """Format a single rule as IF/THEN so the model knows when to activate it."""
    cond = (r.get("condition") or "").strip()
    concl = (r.get("conclusion") or r.get("assertion") or "").strip()
    if not concl:
        return str(r)
    if cond and not cond.lower().startswith("general"):
        return f"- IF {cond[:120]} → {concl[:160]}"
    return f"- {concl[:180]}"


def _format_rules_list(rules: list[dict]) -> str:
    """Format multiple rules with IF/THEN triggers."""
    return "\n".join(_format_rule(r) for r in rules)


def _summarize_knowledge(
    memory: list[dict] | None,
    rules: list[dict] | None,
    knowledge_summary: str | None,
    walls_count: int,
) -> str:
    """Condense into a table of contents with drill-down instructions.

    Each rule is shown as "IF <condition> THEN <conclusion>" so the model
    knows the trigger. The summary is a compact digest; the model can drill
    down via ``get_rule`` if it needs the full text.
    """
    from collections import Counter
    parts: list[str] = [
        "═══ KNOWLEDGE TOC (compact summary — drill down if you need more detail) ═══",
        "  Drill-down tools: `get_rule` for rules, `search_artifacts` for documents, `read_worktree_file` for files.",
    ]
    if walls_count:
        parts.append(f"  Walls: {walls_count} hit this session (see WALLS TOC above for drill-down paths).")
    rule_count = len(rules) if rules else 0
    if rule_count:
        themes: Counter[str] = Counter()
        rule_keywords: list[str] = []
        for r in (rules or []):
            text = (r.get("conclusion") or r.get("assertion") or r.get("rule") or str(r))[:200].lower()
            condition = (r.get("condition") or "").strip()
            conclusion = (r.get("conclusion") or r.get("assertion") or "").strip()
            rule_keywords.append(conclusion.split(".")[0][:60].strip())
            theme = "general"
            if any(w in text for w in ("style", "format", "lint", "indent", "naming", "convention")):
                theme = "code style/convention"
            elif any(w in text for w in ("never", "don't", "avoid", "block")):
                theme = "restriction"
            elif any(w in text for w in ("always", "must", "required", "prefer")):
                theme = "requirement"
            elif any(w in text for w in ("how to", "way to", "pattern for", "approach")):
                theme = "workflow/approach"
            themes[theme] += 1
        theme_str = "; ".join(f"{t}: {c}" for t, c in themes.most_common(3))
        drill = "`get_rule name=\"tool_rules\"`" if rule_keywords else ""
        parts.append(f"  Rules: {rule_count} — {theme_str}")
        if drill:
            parts.append(f"    ➜ Drill down: {drill}")
        # Show each rule as IF/THEN so model knows triggers
        for r in (rules or []):
            parts.append("  " + _format_rule(r).lstrip())
    mem_count = len(memory) if memory else 0
    if mem_count:
        # Separate foundational nodes from regular memory entries
        foundational_nodes: list[dict] = []
        regular_memory: list[dict] = []
        for m in (memory or []):
            if isinstance(m, dict) and m.get("type") == "foundational_node":
                foundational_nodes.append(m)
            else:
                regular_memory.append(m)

        if foundational_nodes:
            fn_titles = [
                n.get("title", "")[:80] for n in foundational_nodes[:6]
            ]
            fn_info = f"Foundational: {len(foundational_nodes)} node(s)"
            if fn_titles:
                fn_info += " — " + "; ".join(fn_titles)
            fn_info += (
                ". ➜ Drill down: use `search_artifacts query=\"<topic>\"` to explore"
            )
            parts.append(f"  {fn_info}")

        wall_entries = sum(
            1 for m in regular_memory
            if isinstance(m.get("content"), dict) and m["content"].get("walls")
        )
        past_mem = len(regular_memory) - wall_entries
        if past_mem > 0:
            topics: Counter[str] = Counter()
            topic_keywords: list[str] = []
            for m in (memory or [])[:10]:
                content = m.get("content", {})
                nodes = content.get("nodes", []) if isinstance(content, dict) else []
                for n in nodes[:3]:
                    title = (n.get("title") or n.get("description") or "")[:80]
                    if title:
                        topics[title] += 1
                        kw = title.split(":")[0].strip().split(" ")[0] if title else title
                        if kw not in topic_keywords:
                            topic_keywords.append(kw)
            if topics:
                top_topics = "; ".join(f"'{t}'" for t, _ in topics.most_common(4))
                drill_examples = "; ".join(
                    f"`search_artifacts query=\"{k}\"`"
                    for k in topic_keywords[:2]
                )
                parts.append(f"  Memory: {past_mem} entries — topics: {top_topics}")
                if drill_examples:
                    parts.append(f"    ➜ Drill down: {drill_examples}")
            else:
                parts.append(f"  Memory: {past_mem} entries")
    if knowledge_summary:
        # Extract code index lines and knowledge graph stats into a compact TOC
        ks = knowledge_summary.strip()
        lines = ks.split("\n")
        symbol_count = sum(1 for l in lines if l.strip().startswith("-"))
        has_code_index = any("[CODE INDEX" in l for l in lines)
        has_knowledge_graph = any("[Knowledge graph" in l for l in lines)
        has_self_teaching = any("[SELF-TEACHING" in l for l in lines)
        parts.append("  Code Knowledge:")
        if has_knowledge_graph:
            # Extract scope info from first line
            parts.append(f"    ⟐ Graph: {'Yes' if has_knowledge_graph else 'No'}")
        if has_code_index and symbol_count:
            parts.append(f"    ⟐ Neo4j symbols: {symbol_count} symbol(s) referenced")
        if has_self_teaching:
            parts.append("    ⟐ Self-teaching snapshot active")
        # Always include drill-down instruction
        parts.append(
            "    ➜ Drill down: `search_artifacts query=\"<keyword>\"` for indexed docs, "
            "`grep pattern=<pattern>` for code search, "
            "`read_worktree_file <path>` for file contents"
        )
    return "\n".join(parts)


def _summarize_free_thoughts(free_thoughts: str, max_lines: int = 5) -> str:
    """Condense free-form reasoning to a bulleted digest with drill-down instruction.

    Extracts key conclusions (lines after '→', '=>', 'so', 'therefore', 'conclusion'),
    and any lines mentioning file paths or tool decisions. Falls back to first N lines
    if nothing structured is found.

    The LLM can always fall back to `think` to re-reason — the raw trace is not needed.
    """
    import re as _re
    lines = free_thoughts.strip().split("\n")
    # Heuristic: extract lines that look like decisions or conclusions
    decision_markers = re.compile(
        r"(→|=>|so\s+|therefore\s+|conclusion|decided|plan|action|step|implement|fix|change|add|modif)",
        re.IGNORECASE,
    )
    key_lines: list[str] = []
    seen = set()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped in seen:
            continue
        seen.add(stripped)
        if decision_markers.search(stripped[:80]):
            key_lines.append(stripped[:120])
        elif stripped.startswith("# ") or stripped.startswith("## "):
            key_lines.append(stripped[:80])
        elif "[File:" in stripped or stripped.startswith("- `"):
            key_lines.append(stripped[:100])

    if not key_lines:
        key_lines = [lines[0][:120]] if lines else ["(no structured reasoning found)"]

    summary = "\n".join(f"  • {l}" for l in key_lines[:max_lines])
    extra = len(key_lines) - max_lines
    if extra > 0:
        summary += f"\n  ... and {extra} more reasoning line(s)."

    return (
        "═══ REASONING SUMMARY (prior analysis — drill down with `think` if you need full context) ═══\n"
        f"{summary}\n"
        "  ➜ Drill down: use the `think` tool to re-reason if this summary is insufficient.\n"
    )


SYSTEM_PROMPT = """\
You are Oasis Cognition, a helpful AI assistant. You are chatting with a software developer working on a codebase.

The input has two parts:
1. "Message: ..." — their latest message (question or follow-up).
2. "Your reasoning (internal):" — YOUR OWN internal analysis (JSON). Never expose this in your reply.

Rules:
- Answer directly in **second person** (you / your). Never refer to them as "the user", "User", or "they" when you mean the person you are talking to.
- Use the **conversation thread** (prior turns in this chat) when the latest message is short or vague (e.g. "pls fix", "continue", "do it"). Infer what they mean from context; only ask what to fix if the thread gives no usable clue.
- Keep responses SHORT: 2-5 sentences for simple questions, up to 8 for complex ones.
- NEVER reference internal data, JSON fields, confidence scores, or reasoning traces.
- NEVER repeat yourself or add filler like "Is there anything else?".
- Use markdown only when it genuinely helps readability.
- Stop writing once you have answered. Do not elaborate further.
- When they ask about code, files, components, etc., use your project context knowledge to give specific, grounded answers.
"""

CORE_TOOL_PLAN_PROMPT = """\
═══ IDENTITY ═══
You are Oasis Cognition, an autonomous coding agent. You solve technical tasks by executing tools.

═══ SCOPE ═══
Read-only tools run in a container at `/workspace`.
**bash** runs on the **host dev-agent** — for `npm install`/`pip install` you MUST have a worktree first (create_worktree).

═══ AVAILABLE TOOLS ═══
{AVAILABLE_TOOLS}

═══ OUTPUT FORMAT ═══
Output ONLY these keys, one per line:

REASONING: <one line why you chose this step>
DECISION: ACT | ANSWER_DIRECTLY | NEED_MORE_INFO

If ACT:
ACTION: <tool_name>

Then PARAM_<NAME>: <value> lines for each parameter.

If ANSWER_DIRECTLY:
ANSWER: <concise text in second person — say "you">

If NEED_MORE_INFO:
QUESTION: <specific question>
OPTIONS: <2-4 short options separated by " | ">

═══ GENERAL RULES ═══
- First non-empty line MUST be REASONING:
- Output ONLY flat KEY: value lines. NO JSON. NO markdown fences.
- Bias to ACTION, not exploration. After 2 read-only tools, implement.
- Never repeat the exact same tool call.
- NEVER tell the user to do it themselves.
- Be truthful. Use tools when needed. Complete the task.
- Use `think` only when you need to plan, debug, analyze, or decide between approaches.
  For simple actions (read a file, search, run bash), just ACT — no thinking needed.
- **PREFER `edit_file` OVER `apply_patch`.** `edit_file` uses old_string→new_string replacement (simple, reliable). `apply_patch` requires correct unified diffs which models often get wrong. Only use `apply_patch` as a last resort if `edit_file` fails repeatedly.
"""

# One-shot repair when the executor model emits prose, malformed keys, or invalid params.
# {ALLOWED_TOOLS} is filled at runtime.
TOOL_PLAN_HEURISTIC_REPAIR_PROMPT = """\
You are a strict formatter for Oasis tool execution. The text below is a broken or non-conforming "tool plan" from another model.

Your ONLY job: infer the intended next step and output a VALID flat tool plan — nothing else.

RULES:
- Output ONLY plain lines: REASONING:, DECISION:, then either ANSWER:/QUESTION: OR (if ACT) ACTION: and PARAM_* lines.
- First non-empty line MUST be REASONING: (single line summary).
- DECISION must be exactly one of: ACT, ANSWER_DIRECTLY, NEED_MORE_INFO (no extra words on that line).
- If DECISION is ACT, ACTION must be ONE token: an allowed executor tool name (see list).
- Params use PARAM_<NAME>: value (UPPER_SNAKE after PARAM_). Match JSON names: PARAM_PATH, PARAM_PATTERN, PARAM_COMMAND, PARAM_URL, PARAM_WORKTREE_ID, PARAM_NAME, PARAM_CONTENT, PARAM_OLD_STRING, PARAM_NEW_STRING, PARAM_PATCH, PARAM_RECURSIVE (true/false), PARAM_RULE_ID, PARAM_CONDITION, PARAM_CONCLUSION, etc.
- For teach_rule / update_rule / delete_rule: use ACTION: teach_rule (etc.) and the PARAM_* fields from the flat-format spec.
- NO JSON. NO markdown fences. NO bullet lists. NO repetition of user/system context blocks.
- If the broken text clearly describes running a tool in prose ("use grep to find X"), map it to ACT + that tool + params.
- If the broken text is only chit-chat with no tool intent, DECISION: NEED_MORE_INFO with QUESTION: asking what to do next.

Allowed executor tools (ACT): {ALLOWED_TOOLS}
"""

CASUAL_SYSTEM_PROMPT = """\
═══ IDENTITY ═══
You are Oasis Cognition, an advanced AI software co-pilot. You are embedded in the developer's environment and have access to their codebase, tools, and screen. Respond naturally and concisely.

═══ MISSION ═══
Assist them with their questions and tasks. Be warm, direct, and technically accurate.

Rules:
- Speak in **second person** (you / your). Never say "the user" or "User" when you mean the person you are chatting with.
- When their message is vague, use **recent conversation context** (thread and any summary in this request) to interpret what they mean before asking for clarification.
- Keep responses SHORT: 1-3 sentences max. Never ramble.
- Be warm and direct. Answer the question, then stop.
- Do NOT repeat yourself or elaborate unnecessarily.
- Do NOT add "Is there anything else I can help with?" or similar filler endings.
- Use markdown formatting only when it genuinely helps (code blocks, lists).
- When the user references artifacts or relevant artifact content is provided, use that information to answer. Cite the artifact name when drawing from it.
"""

TRANSCRIPT_CLEANUP_SYSTEM_PROMPT = """\
Fix punctuation and capitalization of the transcript below. Remove filler words (um, uh, like, you know) and repetitions. Output ONLY the cleaned text.
"""

PLAN_TOOL_USE_PROMPT = """\
═══ IDENTITY & ROLE ═══
You are the Oasis Cognition Planning Agent. Your job is to analyze the user's request and the current context to create a high-level execution strategy. You do NOT execute tools yourself; you provide the blueprint for the Tool-Executor.

═══ GROUNDING ═══
- You are EMBEDDED in the developer's environment.
- You have FULL ACCESS to the codebase via the Tool-Executor's tools.
- Your goal is to SOLVE the task through technical steps, not to give general advice.
- **USER DOCUMENTS**: The user may have uploaded documents (PDFs, audio transcripts, notes, etc.). These are stored in a knowledge base accessible ONLY via `search_artifacts` (summaries) and `read_artifact` (full content) — they are NOT files on disk. If the task involves user documents or "artifacts", plan a `search_artifacts` step first. If you need deeper detail from a specific document, follow up with `read_artifact`.

═══ MISSION ═══
Break the user's request into 3-6 logical steps. Each step must define:
1. WHAT tool should be used.
2. WHAT the expected outcome is (acceptance criteria for that step).

If the user's request is about creating a plan, document, or proposal (intent=create) and artifact/context data is provided, your plan should focus on:
1. Analyzing the provided artifact content and context
2. Using `create_worktree` + `write_file` to produce the requested document
3. Getting `get_diff` for review

═══ DISCIPLINE ═══
- NO GENERAL ADVICE. Do not tell the user how to do things.
- **IMPLEMENTATION-FIRST**: If the query implies a code change, your plan MUST include `create_worktree`, `edit_file`/`write_file`, and `get_diff`. Do NOT plan for exploration only.
- **DOCUMENTS ≠ FILES ON DISK**: User-uploaded documents (artifacts) are in a knowledge base, NOT on disk. Never plan list_dir/read_file/find_files to find "artifacts" or "documents". Plan `search_artifacts` → `read_artifact` instead.
- **DEPENDENCY INSTALLATION**: If the task requires new packages/libraries, include a `bash` step for `npm install` / `pip install` etc. inside the worktree. This step should come after `create_worktree` and before the code that imports the new dependency.
- **START WITH GREP OR SEARCH_ARTIFACTS**: Use `grep` to find code in the codebase. Use `search_artifacts` to find summaries from user's uploaded documents, then `read_artifact` for full content. Choose the right tool based on what you're looking for.
- NO PUNTING. If the goal is "add X", your plan MUST include searching for where to add it and then adding it.
- NO VSCODE TIPS. Focus on the sandbox tools.

═══ EXPECTED OUTPUT ═══
Output ONLY a JSON object:
{
  "steps": [
    {"action": "Description of action", "tool": "grep|read_file|...", "verify": "What to confirm after call"}
  ],
  "success_criteria": ["Statement of truth for final success"]
}
"""


THOUGHT_GENERATION_PROMPT = """\
You are an advanced reasoning assistant generating candidate hypotheses (thoughts) for what to do next in a coding task.

Given the user's goal, upfront plan, recent tool results, walls hit, and observer feedback, generate at most 3 candidate hypotheses for the next step.
Each thought should be a specific, actionable hypothesis about what to do or investigate next.

RULES:
- MAX_THOUGHTS = 3. You may generate at most 3 thoughts.
- ACTION BIAS: If at least one reasonable action exists, you MUST pursue it.
- OVERTHINKING IS A FAILURE. Do not generate thoughts if the next step is already clear.
- After generating thoughts, you MUST stop and prepare for decision.

Output ONLY a JSON object with this format:
{
  "thoughts": [
    {
      "thought": "description of what to try next",
      "rationale": "why this makes sense",
      "confidence": 0.8
    }
  ]
}
"""


SELF_TEACHING_PLAN_PROMPT = """\
You are an LLM agent helping Oasis Cognition learn from a logic-engine solution.

MISSION:
Given:
1) The user topic to self-teach (may be a large, multi-part problem with several subtopics),
2) Candidate LLM thoughts about how to approach it,
3) The logic-engine solution (symbolic conclusion + reasoning trace),
produce a teaching plan that:
- Decomposes the topic into subtopics when the problem is compound.
- Explains how to achieve the overall task (achievement flow).
- Proposes MULTIPLE teach_rule actions (often many rules for compound topics — not just one).
- Offers 2–4 alternative "teaching paths" for the logic engine: different bundles of rules (e.g. minimal vs comprehensive, or correctness-first vs speed-first), each path with its own rule_actions list.

Additionally, you may receive an optional user adjustment comment that corrects or refines the plan.
When present, incorporate it minimally into teaching_material, rule_actions, teaching_paths, subtopics, and achievement_flow as appropriate.

OUTPUT CONTRACT (strict JSON only; no markdown; no commentary outside the JSON):
{
  "teaching_material": "<overview for the user: principles, how logic_solution relates, and how paths differ>",
  "achievement_flow": "<ordered text: how to accomplish the user's stated task end-to-end; use numbered steps if helpful>",
  "subtopics": [
    { "id": "st_1", "title": "<short name>", "summary": "<what this slice covers>" }
  ],
  "teaching_paths": [
    {
      "path_id": "p_comprehensive",
      "title": "<short label>",
      "description": "<when to choose this path for the logic engine>",
      "rule_actions": [ { "action": "teach_rule", "condition": "...", "conclusion": "...", "subtopic_id": "st_1", "category": "rule", "domain": "general", "confidence": 0.8 } ]
    }
  ],
  "rule_actions": [
    {
      "action": "teach_rule",
      "condition": "<general atomic IF condition (without leading 'IF')>",
      "conclusion": "<general atomic THEN conclusion>",
      "subtopic_id": "<optional; tie rule to subtopics[].id>",
      "category": "rule",
      "domain": "general",
      "confidence": 0.8
    }
  ]
}

RULES:
- Prefer teach_rule actions only. Do NOT output update_rule/delete_rule.
- Keep conditions and conclusions atomic and general (non-project-specific unless explicitly about codebase behavior).
- confidence must be a number from 0.1 to 1.0.
- For a simple, single-focus topic: use 1–4 rule_actions, subtopics may be a single item or empty array, teaching_paths may contain one path OR mirror the same rules.
- For a compound / multi-step topic: subtopics should have 3–12 items with stable ids (st_1, st_2, ...). achievement_flow must cover the full task. Each teaching_paths[].rule_actions should be a coherent strategy (typically 3–20 rules per path). rule_actions MUST be a copy of the rule_actions from the path you recommend as the default (usually the most comprehensive path), so backward-compatible clients still work.
- Optional subtopic_id on each teach_rule links the rule to subtopics[].id when relevant.
- If user adjustment is present, update BOTH teaching_material and the relevant rule_actions (default + paths) with minimal, faithful changes.
- Do not invent requirements unsupported by the topic + logic_solution.
- MANDATORY: `rule_actions` MUST contain at least 1 valid teach_rule object (action + non-empty conclusion). If `logic_solution` is empty or low-signal, still derive rules from TOPIC + LLM_THOUGHTS.
- Each object in `rule_actions` and in each `teaching_paths[].rule_actions` MUST include `"action": "teach_rule"` and `"conclusion": "..."` (non-empty). Include `"condition"` when it helps (may be empty string only if the rule is unconditional).
"""

REASONING_LAYER_PROMPT = """\
═══ IDENTITY & ROLE ═══
You are the Oasis Cognition Reasoning Agent. Think briefly and move fast.

═══ GROUNDING ═══
- You are EMBEDDED in the developer's environment.
- You have FULL ACCESS to the codebase via tools (grep, read_file, edit_file, etc.).
- Your goal is to SOLVE the task using these tools, not to give advice on what the user should do.

═══ MISSION ═══
Think concisely about the user's request:
- What is the CORE technical problem?
- What specific files or components are likely involved?
- What is the step-by-step strategy for implementation?

═══ DISCIPLINE ═══
- MAX 3 THOUGHTS and MAX 200 TOKENS: You must keep your entire reasoning under 200 tokens.
- ACTION BIAS: If at least one reasonable action exists, you MUST act. Do NOT wait for perfect certainty.
- NO REPETITION: Do NOT repeat your previous analysis.
- THINK FAST: Under 30 seconds. If you have enough context, stop thinking and execute tools directly.
- USE TOOLS FIRST: Read files, search patterns to gather context. Then synthesize briefly.

═══ EXPECTED OUTPUT ═══
FREE TEXT reasoning. Be technical, investigative, and tool-oriented.
Keep it under 200 tokens.

═══ TOOL USE ═══
You have access to tools during thinking. Use them to explore the codebase, read files,
search for patterns, and gather context. Tool calls execute in real-time and results
feed back into your reasoning.
You are NOT required to use tools — only use them when you need more information.
"""

THINKING_TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the project workspace. Use for reading small files or specific sections.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to the file"},
                    "start_line": {"type": "integer", "description": "1-based start line (optional)"},
                    "end_line": {"type": "integer", "description": "1-based end line inclusive (optional)"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search for a regex pattern across files in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for"},
                    "path": {"type": "string", "description": "Path to search in (default: /workspace)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and directories in a given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path to list"},
                    "recursive": {"type": "boolean", "description": "Set to true for recursive listing (max 4 levels)"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": "Find files by name or glob pattern (e.g. '*.tsx', '*Controller*').",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "File name or glob pattern"},
                    "path": {"type": "string", "description": "Directory to search in"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegate_tasks",
            "description": "Decompose a complex goal into multiple parallel subtasks, each run as an independent sub-agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {"type": "string", "description": "Overall goal for the parallel job"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {"type": "string"},
                                "tool": {"type": "string"},
                                "verify": {"type": "string"},
                            },
                        },
                        "description": "High-level steps for the job plan",
                    },
                    "success_criteria": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Criteria that determine if the job succeeded",
                    },
                    "parallel_groups": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "task_ids": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            },
                        },
                        "description": "Groups of tasks that can run concurrently",
                    },
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "goal": {"type": "string"},
                                "profile_id": {"type": "string"},
                                "resource_class": {"type": "string"},
                                "depends_on": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Task IDs that must complete first",
                                },
                            },
                        },
                        "description": "Individual task definitions. Independent tasks run in parallel.",
                    },
                    "auto_approve_free": {
                        "type": "boolean",
                        "description": "Whether to auto-approve free tasks without cost card",
                    },
                },
                "required": ["goal"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegate_job_status",
            "description": "Check the status of a previously submitted delegate_tasks job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "The job ID from a previous delegate_tasks call"},
                },
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegate_job_results",
            "description": "Get detailed per-task results from a completed delegate_tasks job. Call this after delegate_job_status shows the job is completed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "The job ID from a previous delegate_tasks call"},
                },
                "required": ["job_id"],
            },
        },
    },
]

DECISION_LAYER_PROMPT = """\
You are an advanced decision-making agent. Your role is to decide the next step for a coding agent.

Based on the provided thoughts and context, you must choose exactly ONE decision:

- ACT: If a tool action is clear and justified. This includes INVESTIGATION.
- NEED_MORE_INFO: If crucial information is missing before any action can be taken.
- ANSWER_DIRECTLY: If the request is a simple question or command that doesn't require tools or further action.

═══ DECISION HIERARCHY (Favor ACT) ═══
1. ACT (Investigation/Implementation)
2. ANSWER_DIRECTLY
3. NEED_MORE_INFO (Last resort)

═══ INVESTIGATION IS ACTION ═══
- If you don't know WHERE a piece of code is, the decision is ACT (to use `grep` or `find`).
- If you are unsure HOW something works, the decision is ACT (to use `read_file` or `view_file`).
- **DO NOT** choose NEED_MORE_INFO just because you don't have the full context yet. Use tools to get it.
- **DO NOT** ask the user to provide file paths or implementation details if they can be found via search.

═══ EXAMPLES ═══
- User: "Where is the login logic?" -> Decision: ACT (Reason: I will grep for "login")
- User: "Fix the bug in the header" -> Decision: ACT (Reason: I will search for "Header" components)
- User: "Implement syntax highlighting in the code view" -> Decision: ACT (Reason: I will search for "CodeView" or "highlight" in the codebase)
- User: "What are the pain points from the surveys?" -> Decision: ACT (Reason: I will search_artifacts to find survey content)
- User: "Summarize the uploaded documents" -> Decision: ACT (Reason: I will search_artifacts to find documents)
- User: "What time is it?" -> Decision: ANSWER_DIRECTLY
- User: "Do the thing" (No context) -> Decision: NEED_MORE_INFO, options: ["Continue from last task", "Start a new task", "Show me what you've done"]

═══ CRITICAL: ARTIFACTS / USER DOCUMENTS ═══
If the user mentions "artifacts", "documents", "surveys", "uploaded files", "transcripts", "recordings", "notes", or asks about information that likely comes from their uploaded materials, you MUST choose ACT. The agent has a `search_artifacts` tool to search these. You do NOT have this content in memory — you MUST use tools to access it. NEVER choose ANSWER_DIRECTLY for artifact/document queries.

RULES:
- Do NOT generate more thoughts.
- Do NOT continue reasoning.
- You MUST choose exactly one decision.
- ACTION BIAS: If a tool could help, you MUST choose ACT.
- ARTIFACT QUERIES = ACT: Any question about user-uploaded content MUST be ACT.
- DECISIVENESS: Overthinking is a failure.
- NEVER ask a bare question with no options. If NEED_MORE_INFO, you MUST provide 2-4 concrete suggested answers the user can pick from.

Output ONLY a JSON object with this format:
{
  "decision": "ACT | NEED_MORE_INFO | ANSWER_DIRECTLY",
  "reason": "short explanation of the choice",
  "confidence": 0.9,
  "selected_thought": "the specific thought string that led to this decision",
  "options": ["Option A", "Option B", "Option C"]
}
The "options" field is REQUIRED when decision is NEED_MORE_INFO. It must contain 2-4 short, concrete suggestions the user can click to answer the question.
"""

JSON_REPAIR_PROMPT = """\
The following JSON was malformed and could not be parsed. Your task is to extract the intended JSON structure and fix any syntax errors (missing quotes, trailing commas, unescaped characters, etc.).

Return ONLY the corrected, valid JSON object. No explanation.
"""


def _normalize_teach_rule_actions(raw_actions: Any) -> list[dict[str, Any]]:
    """Normalize a list of teach_rule dicts from LLM output."""
    if not isinstance(raw_actions, list):
        return []
    normalized_actions: list[dict[str, Any]] = []
    for a in raw_actions:
        if not isinstance(a, dict):
            continue
        act_raw = str(a.get("action", "")).strip().lower().replace("-", "_")
        # Explicit non-teach actions: skip
        if act_raw in ("update_rule", "delete_rule", "call_tool", "final_answer"):
            continue
        # Many models omit action or use aliases; infer teach_rule when we have a conclusion
        if act_raw not in ("", "teach_rule", "rule", "teach"):
            continue
        condition = a.get("condition")
        conclusion = a.get("conclusion")
        if conclusion is None:
            conclusion = a.get("assertion") or a.get("then") or a.get("outcome")
        if condition is None:
            condition = a.get("underlying_concept") or a.get("if") or a.get("premise")
        if conclusion is None:
            continue
        item: dict[str, Any] = {
            "action": "teach_rule",
            "condition": "" if condition is None else str(condition),
            "conclusion": str(conclusion),
            "category": str(a.get("category", "rule")),
            "domain": str(a.get("domain", "general")),
            "confidence": float(a.get("confidence", 0.8)),
        }
        st = a.get("subtopic_id")
        if st is not None and str(st).strip():
            item["subtopic_id"] = str(st).strip()
        normalized_actions.append(item)
    return normalized_actions


def _normalize_self_teaching_plan_dict(parsed: dict[str, Any]) -> dict[str, Any]:
    """Normalize self-teaching plan: subtopics, paths, and default rule_actions."""
    if "teaching_material" not in parsed:
        parsed["teaching_material"] = (
            parsed.get("teaching") or parsed.get("material") or ""
        )
    parsed["teaching_material"] = str(parsed.get("teaching_material", "") or "")

    flow = (
        parsed.get("achievement_flow")
        or parsed.get("task_flow")
        or parsed.get("flow")
        or ""
    )
    parsed["achievement_flow"] = str(flow or "")

    raw_subtopics = parsed.get("subtopics") or []
    subtopics: list[dict[str, Any]] = []
    if isinstance(raw_subtopics, list):
        for i, s in enumerate(raw_subtopics):
            if not isinstance(s, dict):
                continue
            sid = str(s.get("id") or s.get("subtopic_id") or f"st_{i + 1}").strip()
            subtopics.append(
                {
                    "id": sid,
                    "title": str(s.get("title", s.get("name", ""))),
                    "summary": str(s.get("summary", s.get("description", ""))),
                }
            )
    parsed["subtopics"] = subtopics

    raw_paths = parsed.get("teaching_paths") or []
    teaching_paths: list[dict[str, Any]] = []
    if isinstance(raw_paths, list):
        for i, p in enumerate(raw_paths):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("path_id") or p.get("id") or f"path_{i + 1}").strip()
            ra_raw = p.get("rule_actions")
            if ra_raw is None:
                ra_raw = p.get("rules") or p.get("actions") or []
            ra = _normalize_teach_rule_actions(ra_raw)
            teaching_paths.append(
                {
                    "path_id": pid,
                    "title": str(p.get("title", "")),
                    "description": str(p.get("description", p.get("summary", ""))),
                    "rule_actions": ra,
                }
            )
    parsed["teaching_paths"] = teaching_paths

    actions = parsed.get("rule_actions")
    if actions is None:
        actions = (
            parsed.get("rules")
            or parsed.get("teaching_rules")
            or parsed.get("actions")
            or []
        )
    if not isinstance(actions, list):
        actions = []
    parsed["rule_actions"] = _normalize_teach_rule_actions(actions)

    if not parsed["rule_actions"] and teaching_paths:
        parsed["rule_actions"] = list(teaching_paths[0].get("rule_actions") or [])

    # If paths have rules but default list is still empty, merge all path rules (dedupe later in memory)
    if not parsed["rule_actions"] and teaching_paths:
        merged: list[dict[str, Any]] = []
        for tp in teaching_paths:
            merged.extend(list(tp.get("rule_actions") or []))
        parsed["rule_actions"] = merged

    return parsed


def _unwrap_self_teaching_plan_json(parsed: Any) -> dict[str, Any]:
    """Flatten common wrapper shapes from LLMs (e.g. { \"teaching_plan\": {...} })."""
    if not isinstance(parsed, dict):
        return {}
    inner = parsed.get("teaching_plan")
    if isinstance(inner, dict):
        merged: dict[str, Any] = {**parsed, **inner}
        return merged
    inner = parsed.get("plan")
    if isinstance(inner, dict) and (
        "rule_actions" in inner or "teaching_material" in inner
    ):
        return {**parsed, **inner}
    return parsed


def _count_teach_rules_in_plan(plan: dict[str, Any]) -> int:
    n = len(plan.get("rule_actions") or [])
    for p in plan.get("teaching_paths") or []:
        if isinstance(p, dict):
            n += len(p.get("rule_actions") or [])
    return n


class ResponseGeneratorService:
    """Converts DecisionTree to natural language."""

    def __init__(
        self,
        settings: Settings,
        llm: LLMClient | None = None,
        tool_plan_llm: LLMClient | None = None,
    ) -> None:
        self._settings = settings
        self._llm = llm or LLMClient(settings)
        # Separate model for tool-plan JSON + next-step reasoning (often needs
        # strong instruction-following to stay within the tool-call contract).
        self._tool_plan_llm = tool_plan_llm or self._llm
        # Populated by _build_tool_plan_combined_message for observability
        self._last_context_budget: dict[str, Any] = {}
        # JIT rule packs requested by the model via get_rule; injected into next iteration
        self._injected_rule_packs: list[str] = []

        # Optional separate LLM client for computer-use calls (e.g. local Ollama model).
        # Activated when OASIS_COMPUTER_USE_LLM_BASE_URL is set.
        self._cu_llm: LLMClient | None = None
        cu_base = (settings.computer_use_llm_base_url or "").strip()
        cu_model = (settings.computer_use_llm_model or "").strip()
        if cu_base and cu_model:
            cu_settings = Settings(
                llm_provider="openai",
                llm_model=cu_model,
                openai_base_url=cu_base,
                openai_api_key=settings.openai_api_key or "no-key",
                llm_max_tokens=settings.llm_max_tokens,
            )
            self._cu_llm = LLMClient(cu_settings)
            logger.info("Computer-use LLM: %s via %s", cu_model, cu_base)

    def _vision_model_name(self, model_override: str = "") -> str:
        """Return the model name for vision/multimodal calls.

        Priority: explicit override → computer_use_llm_model → vision_llm_model → fallback.
        """
        if model_override:
            return model_override
        v = (self._settings.vision_llm_model or "").strip()
        if v:
            return v
        if self._settings.llm_provider == "ollama":
            return "llava:13b"
        return self._settings.llm_model

    def _computer_use_model_name(self) -> str:
        """Return the model name for computer-use calls.

        Uses OASIS_COMPUTER_USE_LLM_MODEL if set, else falls back to vision model.
        This allows swapping in a specialised UI-grounding model (e.g. ScreenAI, CogAgent)
        without affecting normal vision chat.
        """
        cu = (self._settings.computer_use_llm_model or "").strip()
        if cu:
            return cu
        return self._vision_model_name()

    def _summarize_chat_history(self, chat_history: list[dict[str, str]]) -> str:
        """Summarize chat history to preserve key context while reducing token usage."""
        if not chat_history:
            return ""

        # Create a concise summary of the conversation
        summary_prompt = f"""Summarize the following conversation in 1-2 sentences, 
        focusing on key topics, decisions, and important context:
        
        {'\n'.join([f'{m["role"]}: {m["content"]}' for m in chat_history])}"""

        try:
            # Use the existing LLM to generate the summary
            summary = self._llm.chat(
                system="You are a conversation summarizer. Create concise summaries of conversations.",
                user_message=summary_prompt,
                max_tokens=150,
            )
            return summary.strip()
        except Exception as e:
            # Fallback to basic concatenation if summarization fails
            logger.warning(f"Chat history summarization failed: {e}")
            return " ".join(
                [
                    (
                        m["content"][:100] + "..."
                        if len(m["content"]) > 100
                        else m["content"]
                    )
                    for m in chat_history[-3:]
                ]
            )  # Last 3 messages

    async def repair_json(self, malformed_json: str) -> dict[str, Any]:
        """Attempt to repair malformed JSON via LLM."""
        logger.info("Attempting LLM JSON repair for %d chars", len(malformed_json))
        try:
            repaired = await self._tool_plan_llm.chat_async(
                system=JSON_REPAIR_PROMPT,
                user_message=f"REPAIR THIS JSON:\n{malformed_json}",
            )
            return extract_json(repaired)
        except Exception as e:
            logger.error("LLM JSON repair failed: %s", e)
            raise

    async def casual_response(
        self,
        user_message: str,
        context: dict | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ) -> str:
        """Generate a simple conversational reply — no reasoning pipeline."""
        logger.info("Generating casual response for: %s", user_message[:80])

        screen_image = (context or {}).get("screen_image", "")
        rules = (context or {}).get("rules", [])
        memory_context = (context or {}).get("memory_context", [])
        memory_stale_hint = (context or {}).get("memory_stale_hint", "")
        system_override = (context or {}).get("system_override", "")
        # `system_preamble` (from an Oasis project role) is PREPENDED to the
        # default system prompt, unlike `system_override` which replaces it
        # entirely. This lets roles layer framing on top of normal chat
        # behavior without losing tool-use guidance.
        system_preamble = (context or {}).get("system_preamble", "")
        artifact_context = (context or {}).get("artifact_context", "")
        artifact_search_results = (context or {}).get("artifact_search_results", [])

        # Build system prompt — use override if provided (e.g. computer-use planner)
        system = system_override if system_override else CASUAL_SYSTEM_PROMPT
        if system_preamble and not system_override:
            system = f"{system_preamble.strip()}\n\n{system}"
        if memory_stale_hint:
            system += f"\nIMPORTANT — {memory_stale_hint}\n"
        if memory_context:
            memory_text = "\n".join(
                f"- {_memory_to_str(m)}" for m in memory_context[:5]
            )
            system += (
                f"\nRelevant past context (use to ground your answer):\n{memory_text}\n"
            )
            logger.info(
                "Injecting %d memory entries into casual prompt", len(memory_context)
            )
        if artifact_context:
            logger.info(
                "Artifact context available (%d chars) — will inject via budget",
                len(artifact_context),
            )
        if artifact_search_results:
            logger.info(
                "%d artifact search results available — will inject via budget",
                len(artifact_search_results),
            )
        if rules:
            rules_text = _format_rules_list(rules)
            system += f"\nIMPORTANT — You were given these rules in the conversation. Always follow them:\n{rules_text}\n"
            logger.info("Injecting %d taught rules into casual prompt", len(rules))

        if screen_image:
            logger.info(
                "Using vision model for screen-share interaction (%d KB image)",
                len(screen_image) // 1024,
            )
            # When system_override is set (e.g. computer-use planner), keep its
            # instructions clean — just note that a screenshot is attached.
            # For normal chat, add detailed screen-analysis guidance.
            if system_override:
                vision_system = (
                    system
                    + "\n\nA screenshot of the user's current screen is attached. Use it to plan precisely."
                )
            else:
                vision_system = (
                    system
                    + "\n\nThe user is sharing their screen with you. A screenshot of their current screen is attached to this message."
                    "\n\nIMPORTANT instructions for screen analysis:"
                    "\n- You are looking at a REAL screenshot of the user's computer screen RIGHT NOW."
                    "\n- LOOK CAREFULLY at the actual content: read any visible text, code, file names, UI elements, terminal output, browser tabs, etc."
                    "\n- Be SPECIFIC — mention actual file names, variable names, error messages, or UI elements you can see."
                    "\n- Answer the user's question based on what you ACTUALLY see. Do NOT make up content that isn't visible."
                    "\n- Keep your response concise and relevant to the user's question."
                )
            # system_override callers (e.g. computer-use planner) need more output tokens
            vision_max_tokens = (context or {}).get(
                "max_tokens", 2048 if system_override else 512
            )
            # Allow callers (e.g. computer-use controller) to specify a model override.
            # Falls back to computer_use_model if system_override is set, else vision model.
            model_override = (context or {}).get("model_override", "")
            if not model_override and system_override:
                # system_override implies this is a computer-use call — use the CU model
                model_override = self._computer_use_model_name()
            vision_model = self._vision_model_name(model_override)
            # Use dedicated CU LLM client when available and this is a CU call
            llm_for_vision = self._cu_llm if (self._cu_llm and system_override) else self._llm
            logger.info("Vision model selected: %s (client: %s)", vision_model, "cu_llm" if llm_for_vision is self._cu_llm else "default")
            text = await asyncio.to_thread(
                llm_for_vision.chat_with_images,
                system=vision_system,
                user_message=user_message,
                images=[screen_image],
                model=vision_model,
                max_tokens=vision_max_tokens,
            )
            return text

        # Budget-aware: ensure system + user + history fits within context window
        full_system = system + _load_project_context()
        budget = ContextBudget(self._settings)
        budget.record("system_prompt", full_system)

        # Allocate artifact context within budget before appending to system
        if artifact_context:
            budgeted_art_ctx = budget.allocate("artifact_context", artifact_context, max_share=0.20)
            full_system += f"\nReferenced artifacts (user mentioned these):\n{budgeted_art_ctx}\n"
        if artifact_search_results:
            art_lines = []
            for r in artifact_search_results[:5]:
                name = r.get("artifact_name", "unknown")
                chunk = r.get("chunk_text", "")
                sim = r.get("similarity", 0)
                art_lines.append(f"- [{name}] (relevance {sim:.2f}): {chunk}")
            raw_art_search = "\n".join(art_lines)
            budgeted_art_search = budget.allocate("artifact_search", raw_art_search, max_share=0.15)
            full_system += (
                "\nPre-loaded data from the user's documents (treat as already-read content):\n"
                f"{budgeted_art_search}\n"
            )

        user_msg = budget.allocate("user_message", user_message, max_share=0.15)

        if chat_history:
            # First, summarize the chat history to preserve key context
            summary = self._summarize_chat_history(chat_history)
            
            # Create a hybrid approach: use summary for context and recent messages for direct reference
            summary_text = f"Recent conversation context: {summary}"
            
            # Add conversation context note to system prompt
            full_system = f"{full_system}\n\n{summary_text}"
            
            # Keep some recent messages for direct reference in the conversation
            recent_messages = []
            running_tokens = 0
            max_tokens_for_messages = budget.remaining * 0.15  # 15% of remaining tokens
            
            # Add recent messages from the end (most recent first)
            for m in reversed(chat_history):
                msg_tokens = estimate_tokens(f"{m['role']}: {m['content']}")
                if running_tokens + msg_tokens > max_tokens_for_messages:
                    break
                recent_messages.insert(0, m)  # Insert at beginning to maintain order
                running_tokens += msg_tokens
            
            # Use recent messages in history but reference the summary
            chat_history = recent_messages if recent_messages else chat_history
        self._last_context_budget = budget.as_dict()
        logger.info(
            "Casual context budget: %d/%d tokens used (%.0f%%)",
            budget.used,
            budget.total,
            budget.used / budget.total * 100 if budget.total else 0,
        )

        # When system_override is set (e.g. computer-use planner generating JSON plans),
        # allow a larger output. Normal casual chat is capped at 256 tokens.
        output_limit = (context or {}).get(
            "max_tokens", 256 if not system_override else 2048
        )
        # Use dedicated CU LLM client when available and this is a CU call.
        # Allow callers to override the model via context.model_override
        # (e.g. DeepSeek for text-only CU decisions, vision model for screenshots).
        model_override = (context or {}).get("model_override", "")
        llm_for_chat = self._cu_llm if (self._cu_llm and system_override) else self._llm
        chat_kwargs: dict[str, Any] = dict(
            system=full_system,
            user_message=user_msg,
            history=chat_history,
            max_tokens=output_limit,
        )
        if model_override:
            chat_kwargs["model"] = model_override
            logger.info("Using model override for chat: %s", model_override)
        text = await llm_for_chat.chat_async(**chat_kwargs)
        return text

    def stream_casual_response(
        self,
        user_message: str,
        context: dict | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ):
        """Stream a simple conversational reply."""
        logger.info("Streaming casual response for: %s", user_message[:80])
        screen_image = (context or {}).get("screen_image", "")
        rules = (context or {}).get("rules", [])
        memory_context = (context or {}).get("memory_context", [])
        memory_stale_hint = (context or {}).get("memory_stale_hint", "")
        system_preamble = (context or {}).get("system_preamble", "")
        artifact_context = (context or {}).get("artifact_context", "")
        artifact_search_results = (context or {}).get("artifact_search_results", [])

        system = CASUAL_SYSTEM_PROMPT
        if system_preamble:
            system = f"{system_preamble.strip()}\n\n{system}"
        if memory_stale_hint:
            system += f"\nIMPORTANT — {memory_stale_hint}\n"
        if memory_context:
            memory_text = "\n".join(
                f"- {_memory_to_str(m)}" for m in memory_context[:5]
            )
            system += (
                f"\nRelevant past context (use to ground your answer):\n{memory_text}\n"
            )
        if rules:
            rules_text = "\n".join(
                f"- {r.get('assertion', r.get('rule', str(r)))}" for r in rules
            )
            system += f"\nIMPORTANT — You were given these rules in the conversation. Always follow them:\n{rules_text}\n"

        if screen_image:
            yield self.casual_response(
                user_message, context=context, chat_history=chat_history
            )
            return

        # Budget-aware: truncate user message if needed
        full_system = system + _load_project_context()
        budget = ContextBudget(self._settings)
        budget.record("system_prompt", full_system)

        # Allocate artifact context within budget
        if artifact_context:
            budgeted_art_ctx = budget.allocate("artifact_context", artifact_context, max_share=0.20)
            full_system += f"\nReferenced artifacts (user mentioned these):\n{budgeted_art_ctx}\n"
        if artifact_search_results:
            art_lines = []
            for r in artifact_search_results[:5]:
                name = r.get("artifact_name", "unknown")
                chunk = r.get("chunk_text", "")
                sim = r.get("similarity", 0)
                art_lines.append(f"- [{name}] (relevance {sim:.2f}): {chunk}")
            raw_art_search = "\n".join(art_lines)
            budgeted_art_search = budget.allocate("artifact_search", raw_art_search, max_share=0.15)
            full_system += (
                "\nPre-loaded data from the user's documents (treat as already-read content):\n"
                f"{budgeted_art_search}\n"
            )

        user_msg = budget.allocate("user_message", user_message, max_share=0.15)

        for chunk in self._llm.stream_chat(
            system=full_system,
            user_message=user_msg,
            history=chat_history,
            max_tokens=256,
        ):
            yield chunk

    async def format_response(
        self,
        decision: DecisionTree,
        context: dict | None = None,
        user_message: str | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ) -> str:
        """Generate natural language from reasoning results."""
        logger.info("Generating response for conclusion: %s", decision.conclusion)

        memory_stale_hint = (context or {}).get("memory_stale_hint", "")

        payload = {
            "conclusion": decision.conclusion,
            "confidence": decision.confidence,
            "reasoning_trace": decision.reasoning_trace,
            "hypotheses": [
                {
                    "title": h["title"],
                    "score": h.get("score", 0),
                    "eliminated": h.get("eliminated", False),
                }
                for h in decision.hypotheses
            ],
        }

        screen_image = (context or {}).get("screen_image", "")
        if screen_image:
            logger.info(
                "Using vision model for complex response with screen image (%d KB)",
                len(screen_image) // 1024,
            )
            # For vision: pass conclusion as natural text, NOT raw JSON.
            # The vision model gets confused mixing JSON reasoning traces with screenshot analysis.
            vision_user_msg = (
                f"My conclusion from thinking about this: {decision.conclusion}\n\n"
                f"Reply in second person (you), based on this conclusion and what you see on their screen."
            )
            vision_system = (
                SYSTEM_PROMPT
                + _load_project_context()
                + "\n\nThey are sharing their screen. A screenshot of their current screen is attached."
                "\n\nIMPORTANT instructions for screen analysis:"
                "\n- LOOK CAREFULLY at the actual content: read any visible text, code, file names, UI elements, terminal output, etc."
                "\n- Be SPECIFIC — mention actual file names, code, errors, or UI elements you can see."
                "\n- If the screen content is relevant to the topic, reference specific things you see."
                "\n- Do NOT describe the screen in generic terms — describe the SPECIFIC content."
                "\n- Keep your response concise and relevant."
            )
            text = await asyncio.to_thread(
                self._llm.chat_with_images,
                system=vision_system,
                user_message=vision_user_msg,
                images=[screen_image],
                model=self._vision_model_name(),
            )
        else:
            # Label the JSON clearly so the LLM knows this is internal reasoning, not a user message
            intent = (context or {}).get("intent", "diagnose")
            is_generative = intent in ("create", "implement", "explain")
            parts = []
            if memory_stale_hint:
                parts.append(f"Note: {memory_stale_hint}\n")
            if user_message:
                parts.append(f"Message: {user_message}\n")
            if is_generative:
                parts.append(
                    "Your reasoning (internal, do NOT show in your reply):\n"
                    + json.dumps(payload)
                    + "\n\nThe user is asking you to CREATE or PRODUCE content (a plan, document, proposal, spec, etc.). "
                    "Write a thorough, detailed, well-structured response. Use headings, bullet points, and sections as appropriate. "
                    "Do NOT just summarize — actually produce the requested content in full. "
                    "Reply in second person (you). Do not say \"the user\"."
                )
            else:
                parts.append(
                    "Your reasoning (internal, do NOT show in your reply):\n"
                    + json.dumps(payload)
                    + "\n\nReply concisely in second person (you). Do not say \"the user\"."
                )
            labeled_input = "\n".join(parts)
            # Budget-aware: truncate reasoning payload if it would blow context
            full_system = SYSTEM_PROMPT + _load_project_context()
            budget = ContextBudget(self._settings)
            budget.record("system_prompt", full_system)
            labeled_input = budget.allocate(
                "user_message", labeled_input, max_share=0.50
            )
            self._last_context_budget = budget.as_dict()
            # Generative intents (create, implement) need more output tokens
            output_tokens = 2048 if is_generative else 512
            text = await self._llm.chat_async(
                system=full_system,
                user_message=labeled_input,
                max_tokens=output_tokens,
                history=chat_history,
            )
        logger.info("Response generated (%d chars)", len(text))
        return text

    def stream_format_response(
        self,
        decision: DecisionTree,
        context: dict | None = None,
        user_message: str | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ):
        """Stream natural language from reasoning results."""
        logger.info("Streaming response for conclusion: %s", decision.conclusion)
        memory_stale_hint = (context or {}).get("memory_stale_hint", "")
        payload = {
            "conclusion": decision.conclusion,
            "confidence": decision.confidence,
            "reasoning_trace": decision.reasoning_trace,
            "hypotheses": [
                {
                    "title": h["title"],
                    "score": h.get("score", 0),
                    "eliminated": h.get("eliminated", False),
                }
                for h in decision.hypotheses
            ],
        }

        screen_image = (context or {}).get("screen_image", "")
        if screen_image:
            yield self.format_response(
                decision,
                context=context,
                user_message=user_message,
                chat_history=chat_history,
            )
            return

        intent = (context or {}).get("intent", "diagnose")
        is_generative = intent in ("create", "implement", "explain")
        parts = []
        if memory_stale_hint:
            parts.append(f"Note: {memory_stale_hint}\n")
        if user_message:
            parts.append(f"Message: {user_message}\n")
        if is_generative:
            parts.append(
                "Your reasoning (internal, do NOT show in your reply):\n"
                + json.dumps(payload)
                + "\n\nThe user is asking you to CREATE or PRODUCE content (a plan, document, proposal, spec, etc.). "
                "Write a thorough, detailed, well-structured response. Use headings, bullet points, and sections as appropriate. "
                "Do NOT just summarize — actually produce the requested content in full. "
                "Reply in second person (you). Do not say \"the user\"."
            )
        else:
            parts.append(
                "Your reasoning (internal, do NOT show in your reply):\n"
                + json.dumps(payload)
                + "\n\nReply concisely in second person (you). Do not say \"the user\"."
            )
        labeled_input = "\n".join(parts)
        output_tokens = 2048 if is_generative else 512
        for chunk in self._llm.stream_chat(
            system=SYSTEM_PROMPT + _load_project_context(),
            user_message=labeled_input,
            max_tokens=output_tokens,
            history=chat_history,
        ):
            yield chunk

    async def stream_format_response_structured(
        self,
        decision: DecisionTree,
        context: dict | None = None,
        user_message: str | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ):
        """Like ``stream_format_response`` but yields NDJSON lines with type
        discrimination so the gateway can forward thinking (reasoning) chunks
        to the frontend separately from visible content.

        Yields ``{"type": "reasoning", "text": "..."}`` and
        ``{"type": "content", "text": "..."}`` as NDJSON lines (one per chunk).
        """
        logger.info("Structured streaming for conclusion: %s", decision.conclusion)
        memory_stale_hint = (context or {}).get("memory_stale_hint", "")
        payload = {
            "conclusion": decision.conclusion,
            "confidence": decision.confidence,
            "reasoning_trace": decision.reasoning_trace,
            "hypotheses": [
                {
                    "title": h["title"],
                    "score": h.get("score", 0),
                    "eliminated": h.get("eliminated", False),
                }
                for h in decision.hypotheses
            ],
        }

        intent = (context or {}).get("intent", "diagnose")
        is_generative = intent in ("create", "implement", "explain")
        parts = []
        if memory_stale_hint:
            parts.append(f"Note: {memory_stale_hint}\n")
        if user_message:
            parts.append(f"Message: {user_message}\n")
        if is_generative:
            parts.append(
                "Your reasoning (internal, do NOT show in your reply):\n"
                + json.dumps(payload)
                + "\n\nThe user is asking you to CREATE or PRODUCE content (a plan, document, proposal, spec, etc.). "
                "Write a thorough, detailed, well-structured response. Use headings, bullet points, and sections as appropriate. "
                "Do NOT just summarize — actually produce the requested content in full. "
                "Reply in second person (you). Do not say \"the user\"."
            )
        else:
            parts.append(
                "Your reasoning (internal, do NOT show in your reply):\n"
                + json.dumps(payload)
                + "\n\nReply concisely in second person (you). Do not say \"the user\"."
            )
        labeled_input = "\n".join(parts)
        output_tokens = 2048 if is_generative else 512

        async for item in self._llm.stream_chat_structured_async(
            system=SYSTEM_PROMPT + _load_project_context(),
            user_message=labeled_input,
            max_tokens=output_tokens,
            history=chat_history,
        ):
            yield json.dumps(item, ensure_ascii=False) + "\n"

    async def cleanup_transcript(self, raw_text: str) -> str:
        """Clean up ASR transcript text for downstream LLM consumption."""
        raw = (raw_text or "").strip()
        if not raw:
            return ""
        try:
            cleaned = (await self._llm.chat_async(
                system=TRANSCRIPT_CLEANUP_SYSTEM_PROMPT,
                user_message=f"TRANSCRIPT TO CLEAN:\n{raw}",
            )).strip()
            # Strip common LLM commentary prefixes (covers many variations)
            import re

            cleaned = re.sub(
                r"^(?:Here\s+(?:is|are)\s+)?(?:the\s+)?(?:reformatted|cleaned|cleaned[- ]?up|formatted|corrected)\s+(?:text|transcript|version)\s*[:.]?\s*\n*",
                "",
                cleaned,
                flags=re.IGNORECASE,
            ).strip()
            # Also catch "Here is the ..." without the keyword
            cleaned = re.sub(
                r"^Here\s+(?:is|are)\s+(?:the|your)\s+.*?[:]\s*\n*",
                "",
                cleaned,
                flags=re.IGNORECASE,
            ).strip()
            # Defensive: some models may wrap output in quotes
            cleaned = cleaned.strip().strip('"').strip("'").strip()
            # If the model produced something useless, fall back to raw
            if not cleaned:
                return raw
            # Guard: if cleaned is way longer than raw, the LLM answered instead of cleaning
            if len(cleaned) > len(raw) * 2.5 + 20:
                logger.warning(
                    "Transcript cleanup produced output much longer than input (%d vs %d chars), falling back to raw",
                    len(cleaned),
                    len(raw),
                )
                return raw
            return cleaned
        except Exception as e:
            logger.warning("Transcript cleanup failed, falling back to raw: %s", e)
            return raw

    async def plan_tool_use(
        self,
        user_message: str,
        semantic_structure: dict[str, Any] | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
        free_thoughts: str | None = None,
        observer_feedback: str | None = None,
        previous_plan: dict[str, Any] | None = None,
        replan_after_observer: bool = False,
        artifact_search_results: list[dict[str, Any]] | None = None,
        artifact_context: str | None = None,
    ) -> dict[str, Any]:
        """Create an upfront plan for tool_use (Planning Agent). Returns { steps, success_criteria }."""
        problem = (semantic_structure or {}).get("problem", "")
        intent = (semantic_structure or {}).get("intent", "")
        context_str = (
            f"Problem: {problem}\nIntent: {intent}\n" if (problem or intent) else ""
        )

        # Inject Free Thoughts reasoning if available
        thoughts_str = (
            f"═══ INITIAL REASONING (Free Thoughts) ═══\n{free_thoughts}\n\n"
            if free_thoughts
            else ""
        )
        user_input = f"{thoughts_str}{context_str}User request: {user_message}"

        if replan_after_observer and (observer_feedback or previous_plan):
            prev_json = ""
            if previous_plan:
                try:
                    prev_json = json.dumps(previous_plan, ensure_ascii=False)[:6000]
                except (TypeError, ValueError):
                    prev_json = str(previous_plan)[:6000]
            revision_block = (
                "═══ PLAN REVISION (Observer / validation) ═══\n"
                "The execution agent did NOT satisfy the goal yet. Produce a completely NEW plan from scratch.\n"
                "Number steps from exploration (if needed) through implementation when the goal requires code changes.\n"
                "The agent will restart at step 1 of your new plan.\n\n"
            )
            if prev_json:
                revision_block += f"Prior plan to replace (do not copy blindly; fix gaps):\n{prev_json}\n\n"
            if observer_feedback:
                revision_block += (
                    f"Observer / validation feedback:\n{observer_feedback}\n\n"
                )
            user_input = revision_block + user_input

        # Note: artifact search results are NOT injected here anymore.
        # The LLM has a `search_artifacts` tool it can call explicitly when it needs
        # to query the user's uploaded documents. This gives the LLM agency over
        # when and what to search, and the results come back as trusted tool output.

        # Inject memory (Knowledge Graph) and rules for grounded planning
        memory = memory_context or []
        rules_list = rules or []
        if memory or rules_list:
            extra = []
            if memory_stale_hint:
                extra.append(f"IMPORTANT — {memory_stale_hint}")
            if memory:
                memory_str = "\n".join(f"- {_memory_to_str(m)}" for m in memory[:5])
                extra.append(f"Relevant past context (memory):\n{memory_str}")
            if rules_list:
                rules_str = "\n".join(
                    f"- {r.get('assertion', r.get('rule', str(r)))}" for r in rules_list
                )
                extra.append(f"User-taught rules (apply these):\n{rules_str}")
            if extra:
                user_input = "\n\n".join(extra + [user_input])
            logger.info(
                "Injecting memory (%d) + rules (%d) into plan_tool_use",
                len(memory),
                len(rules_list),
            )

        system = PLAN_TOOL_USE_PROMPT + _load_project_context()
        if replan_after_observer:
            system += (
                "\n\n═══ REVISION MODE ═══\n"
                "You are replacing a failed or insufficient plan. Output a fresh JSON plan; "
                "incorporate the observer feedback and ensure implementation steps include "
                "create_worktree, edit_file or write_file, and get_diff when the user goal requires code changes.\n"
            )
        logger.info("Planning tool use for: %s", user_message[:80])

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                raw = await self._tool_plan_llm.chat_async(system=system, user_message=user_input)
                parsed = extract_json(raw)
                if not isinstance(parsed, dict):
                    raise ValueError(
                        f"Expected JSON object, got {type(parsed).__name__}"
                    )
                steps = parsed.get("steps", [])
                if not isinstance(steps, list):
                    steps = [str(steps)] if steps else []
                criteria = parsed.get("success_criteria", [])
                if not isinstance(criteria, list):
                    criteria = [str(criteria)] if criteria else []
                # Normalize steps: ensure each has step_index, description, tool, verify
                normalized_steps = []
                for i, s in enumerate(steps):
                    if isinstance(s, str):
                        normalized_steps.append(
                            {
                                "step_index": i,
                                "description": s,
                                "tool": "",
                                "verify": "",
                                "status": "pending",
                            }
                        )
                    elif isinstance(s, dict):
                        normalized_steps.append(
                            {
                                "step_index": i,
                                "description": s.get(
                                    "action", s.get("description", "")
                                ),
                                "tool": s.get("tool", ""),
                                "verify": s.get("verify", ""),
                                "status": "pending",
                            }
                        )
                    else:
                        normalized_steps.append(
                            {
                                "step_index": i,
                                "description": str(s),
                                "tool": "",
                                "verify": "",
                                "status": "pending",
                            }
                        )
                return {
                    "steps": normalized_steps,
                    "success_criteria": [str(c) for c in criteria],
                }
            except (ValueError, json.JSONDecodeError) as e:
                logger.warning(
                    "Plan tool use attempt %d/%d failed: %s", attempt, max_retries, e
                )
                if attempt == max_retries:
                    return {
                        "steps": [
                            {
                                "step_index": 0,
                                "description": "Investigate and address the user's request",
                            }
                        ],
                        "success_criteria": ["User receives a helpful response"],
                    }
                continue

        return {"steps": [], "success_criteria": []}

    async def generate_thoughts(
        self,
        user_message: str,
        tool_results: list[dict[str, Any]] | None = None,
        upfront_plan: dict[str, Any] | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        walls_hit: list[str] | None = None,
        observer_feedback: str | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Generate candidate hypotheses (thoughts) for the next step."""
        system = THOUGHT_GENERATION_PROMPT + _load_project_context()

        parts = []
        if walls_hit:
            walls_str = "\n".join(f"  - {w}" for w in walls_hit[:15])
            parts.append(
                f"⚠️ FAILED ATTEMPTS / WALLS HIT (DO NOT PROPOSE THESE):\n{walls_str}\n"
            )

        if rules:
            rules_str = "\n".join(
                f"- {r.get('assertion', r.get('rule', str(r)))}" for r in rules
            )
            parts.append(f"User-taught rules:\n{rules_str}\n")

        parts.append(f"User request: {user_message}")

        if upfront_plan:
            steps = upfront_plan.get("steps", [])
            if steps and isinstance(steps[0], dict):
                steps_str = "\n".join(
                    f"  {i+1}. {s.get('description', s)}" for i, s in enumerate(steps)
                )
            else:
                steps_str = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(steps))
            parts.append(f"\nUpfront plan:\n{steps_str}")

        if observer_feedback:
            parts.append(f"\nObserver feedback:\n{observer_feedback}")

        if tool_results:
            parts.append("\nRecent tool results:")
            for i, r in enumerate(tool_results, 1):
                status = (
                    "SUCCESS"
                    if r.get("success")
                    else ("BLOCKED" if r.get("blocked") else "FAILED")
                )
                parts.append(
                    f"Tool: {r.get('tool', '?')} [{status}]\n{r.get('output', '')[:1000]}"
                )

        user_input = "\n".join(parts)

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                raw = await self._tool_plan_llm.chat_async(system=system, user_message=user_input)
                try:
                    parsed = extract_json(raw)
                except (ValueError, json.JSONDecodeError):
                    logger.info("Normal extraction failed, attempting JSON repair...")
                    parsed = await self.repair_json(raw)

                if not isinstance(parsed, dict):
                    raise ValueError(
                        f"Expected JSON object, got {type(parsed).__name__}"
                    )
                thoughts = parsed.get("thoughts", [])
                if not isinstance(thoughts, list):
                    thoughts = []

                # Normalize thoughts
                normalized = []
                for t in thoughts:
                    if isinstance(t, dict):
                        normalized.append(
                            {
                                "thought": str(
                                    t.get("thought", t.get("description", ""))
                                ),
                                "rationale": str(t.get("rationale", "")),
                                "confidence": float(t.get("confidence", 0.5)),
                            }
                        )
                return {"thoughts": normalized}
            except Exception as e:
                logger.warning("Thought generation attempt %d failed: %s", attempt, e)

        return {"thoughts": []}

    async def propose_self_teaching_plan(
        self,
        topic: str,
        llm_thoughts: list[dict[str, Any]] | None,
        logic_solution: dict[str, Any] | None,
        user_comment: str | None = None,
        prior_plan: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Propose a teaching plan (training material + teach_rule actions) for self-teaching."""
        system = SELF_TEACHING_PLAN_PROMPT + _load_project_context()

        llm_thoughts = llm_thoughts or []
        logic_solution = logic_solution or {}

        thoughts_str = "\n".join(
            f"- (conf={float(t.get('confidence', 0.0)):.2f}) {t.get('thought', '')} | rationale={t.get('rationale', '')}"
            for t in llm_thoughts[:5]
        )

        user_comment = (user_comment or "").strip()
        user_adjustment_block = (
            f"USER_ADJUSTMENT:\n{user_comment}\n\n" if user_comment else ""
        )
        prior_block = ""
        if prior_plan and isinstance(prior_plan, dict) and prior_plan:
            prior_block = (
                "PRIOR_PLAN (revise this in light of USER_ADJUSTMENT if any; preserve structure):\n"
                f"{json.dumps(prior_plan, ensure_ascii=False)[:7000]}\n\n"
            )
        user_input_base = (
            f"TOPIC:\n{topic}\n\n"
            f"LLM_THOUGHTS:\n{thoughts_str if thoughts_str else '(none)'}\n\n"
            f"LOGIC_SOLUTION:\n{json.dumps(logic_solution, ensure_ascii=False)[:8000]}\n\n"
            f"{prior_block}"
            f"{user_adjustment_block}"
            f"Now produce the teaching plan in the strict JSON contract."
        )

        empty = {
            "teaching_material": "",
            "achievement_flow": "",
            "subtopics": [],
            "teaching_paths": [],
            "rule_actions": [],
        }
        max_retries = 4
        last_err: Exception | None = None
        for attempt in range(1, max_retries + 1):
            retry_suffix = ""
            if attempt >= 2:
                retry_suffix = (
                    "\n\n[SYSTEM — REQUIRED FIX]: Your previous reply produced NO usable teach_rule objects. "
                    "Return ONE JSON object only. "
                    "The top-level key rule_actions MUST be a non-empty array. "
                    'Each element MUST be exactly: {"action":"teach_rule","condition":"...","conclusion":"..."} '
                    "with non-empty conclusion. "
                    "If you include teaching_paths, each path's rule_actions must also be non-empty arrays of the same shape."
                )
            user_input = user_input_base + retry_suffix
            try:
                raw = await self._tool_plan_llm.chat_async(system=system, user_message=user_input)
                try:
                    parsed = extract_json(raw)
                except (ValueError, json.JSONDecodeError) as je:
                    logger.info(
                        "Self-teaching extract_json failed, trying repair_json: %s", je
                    )
                    repaired = await self.repair_json(raw)
                    parsed = (
                        repaired
                        if isinstance(repaired, dict)
                        else extract_json(str(repaired))
                    )

                if not isinstance(parsed, dict):
                    raise ValueError(
                        f"Expected JSON object, got {type(parsed).__name__}"
                    )

                parsed = _unwrap_self_teaching_plan_json(parsed)

                if "rule_actions" not in parsed:
                    parsed["rule_actions"] = (
                        parsed.get("rules")
                        or parsed.get("teaching_rules")
                        or parsed.get("actions")
                        or []
                    )

                normalized = _normalize_self_teaching_plan_dict(parsed)
                if _count_teach_rules_in_plan(normalized) == 0:
                    raise ValueError("Normalized plan contains zero teach_rule actions")

                return normalized
            except Exception as e:
                last_err = e
                logger.warning("Self-teaching plan attempt %d failed: %s", attempt, e)

        logger.error(
            "Self-teaching plan failed after %d attempts: %s", max_retries, last_err
        )
        hint = (
            " The model did not return any valid teach_rule entries. "
            "Try a shorter topic, click Update plan with a hint, or switch the tool-plan / response LLM."
        )
        empty["teaching_material"] = hint.strip()
        return dict(empty)

    async def make_decision(
        self,
        thoughts: list[dict[str, Any]] | str,
        user_message: str,
        context: dict[str, Any] | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Choose the next macro-step: ACT, NEED_MORE_INFO, or ANSWER_DIRECTLY."""
        system = DECISION_LAYER_PROMPT + _load_project_context()

        # Format thoughts for the LLM
        if isinstance(thoughts, list):
            thought_str = "\n".join(f"- {t.get('thought', t)}" for t in thoughts)
        else:
            thought_str = thoughts

        user_input = f"User Request: {user_message}\n\n"
        if context:
            user_input += f"Context: {json.dumps(context)}\n\n"
        if memory_context:
            user_input += (
                f"Memory/Knowledge Context: {json.dumps(memory_context[:5])}\n\n"
            )

        if chat_history:
            # Include recent chat history so the decision has context of the conversation
            history_parts = []
            for m in chat_history[-6:]:  # last 6 turns for context
                history_parts.append(f"{m['role']}: {m['content']}")
            user_input += f"Conversation History:\n" + "\n".join(history_parts) + "\n\n"

        user_input += f"Generated Thoughts:\n{thought_str}\n\nDecide the next step."

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                raw = await self._tool_plan_llm.chat_async(system=system, user_message=user_input)
                parsed = extract_json(raw)

                decision = str(parsed.get("decision", "ACT")).upper()
                if decision not in ["ACT", "NEED_MORE_INFO", "ANSWER_DIRECTLY"]:
                    decision = "ACT"  # Default to action bias

                result = {
                    "decision": decision,
                    "reason": str(parsed.get("reason", "")),
                    "confidence": float(parsed.get("confidence", 0.5)),
                    "selected_thought": str(parsed.get("selected_thought", "")),
                }
                # Include options for NEED_MORE_INFO decisions
                options = parsed.get("options")
                if isinstance(options, list) and len(options) > 0:
                    result["options"] = [str(o) for o in options[:4]]
                return result
            except Exception as e:
                logger.warning("Decision layer attempt %d failed: %s", attempt, e)

        return {
            "decision": "ACT",
            "reason": "Fallback to action due to decision layer failure.",
            "confidence": 0.0,
            "selected_thought": "",
        }

    async def check_punt(
        self,
        user_goal: str,
        proposed_answer: str,
        has_code_edits: bool = False,
    ) -> dict[str, Any]:
        """Fast LLM check: is the proposed answer punting the task to the user?

        Returns {"is_punt": bool, "reason": str}.
        Uses the cheapest/fastest model available for a quick yes/no.
        """
        system = (
            "You are a quality-control checker for a coding agent. "
            "The agent was asked to implement/fix/add something in a codebase. "
            "Your job: determine if the agent's proposed answer is actually completing the task, "
            "or if it's PUNTING (telling the user to do it, asking permission, giving instructions "
            "instead of code, or saying it couldn't do something without trying alternatives).\n\n"
            "A PUNT includes:\n"
            "- Telling the user how to do it instead of doing it ('you can...', 'here\\'s how...')\n"
            "- Asking for permission ('would you like me to...', 'shall I...', 'should I...')\n"
            "- Claiming inability without exhausting options ('I was unable to...', 'I couldn\\'t access...')\n"
            "- Providing guidance/advice instead of actual code changes\n"
            "- Announcing next steps without doing them ('the next step would be...')\n"
            "- Making no modifications and explaining why\n"
            "- Blaming file size or tool limitations ('file is large', 'due to size limitations', 'due to a tool limitation')\n"
            "- Offering to focus on a specific part instead of just reading the rest ('would you like me to focus on...')\n"
            "- Narrating what it plans to do without actually doing it ('let me proceed with...', 'I\\'ll need to: 1. ... 2. ...')\n"
            "- Describing observations about the code without taking action ('I noticed that...', 'looking at the code...')\n\n"
            "NOT a punt:\n"
            "- Actually showing code changes/diffs that were made\n"
            "- Summarizing completed implementation with specific files changed\n"
            "- Asking a genuinely necessary clarification (ambiguous requirements, multiple valid approaches)\n\n"
            "Output ONLY JSON: {\"is_punt\": true/false, \"reason\": \"short explanation\"}"
        )
        user_msg = (
            f"USER GOAL: {user_goal[:300]}\n\n"
            f"HAS CODE EDITS: {has_code_edits}\n\n"
            f"PROPOSED ANSWER:\n{proposed_answer[:500]}"
        )
        try:
            parsed = await self._llm.chat_json_async(system=system, user_message=user_msg, max_tokens=100)
            return {
                "is_punt": bool(parsed.get("is_punt", False)),
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as e:
            logger.warning("Punt check failed: %s — falling back to not-punt", e)
            return {"is_punt": False, "reason": f"check failed: {e}"}

    async def generate_free_thoughts(
        self,
        user_message: str,
        context: dict[str, Any] | None = None,
        chat_history: list[dict[str, str]] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
        observer_feedback: str | None = None,
    ) -> str:
        """Generate a free-form reasoning thought trace (Free Thoughts)."""
        full_text = ""
        async for chunk in self._stream_free_thoughts_async(
            user_message, context, chat_history, tool_results, observer_feedback
        ):
            full_text += chunk
        return full_text

    async def _stream_free_thoughts_async(
        self,
        user_message: str,
        context: dict[str, Any] | None = None,
        chat_history: list[dict[str, str]] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
        observer_feedback: str | None = None,
    ):
        """Stream a free-form reasoning thought trace (Free Thoughts)."""
        system = REASONING_LAYER_PROMPT + _load_project_context()
        user_input = f"User asked: {user_message}"
        if context:
            user_input += f"\nContext: {json.dumps(context)}"

        if tool_results:
            results_text = "\n".join(
                f"- Tool: {r.get('tool')}, Success: {r.get('success')}, Output: {str(r.get('output'))[:200]}"
                for r in tool_results
            )
            user_input += f"\n\nRECENT TOOL RESULTS:\n{results_text}"

        if observer_feedback:
            user_input += f"\n\nOBSERVER FEEDBACK:\n{observer_feedback}"

        logger.info("Streaming free-form thoughts for: %s", user_message[:80])
        # Cap thoughts at 200 tokens to prevent rambling.
        # The prompt says "MAX 200 TOKENS" — this enforces it.
        async for chunk in self._tool_plan_llm.stream_chat_async(
            system=system, user_message=user_input, history=chat_history,
            max_tokens=200,
        ):
            yield chunk

    async def _stream_free_thoughts_structured_async(
        self,
        user_message: str,
        context: dict[str, Any] | None = None,
        chat_history: list[dict[str, str]] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
        observer_feedback: str | None = None,
    ):
        """Stream a structured reasoning trace with tool call support (NDJSON).

        Yields structured dicts:
        - ``{"type": "reasoning", "text": "..."}`` — reasoning/thinking tokens
        - ``{"type": "tool_call", "id": "...", "function": {"name": "...", "arguments": "..."}}``
          — tool call requests (from either native API or text-parsed)
        - ``{"type": "content", "text": "..."}`` — visible content
        - ``{"type": "done", "text": "..."}`` — final accumulated text when streaming completes

        The caller (gateway) is expected to detect ``tool_call`` items, execute
        the tool, and re-invoke this method with the results appended via
        ``tool_results``. This creates a loop: LLM thinks → calls tools → gets
        results → thinks more → calls more tools → final synthesized reasoning.

        Tool calls can come from two sources:
        1. Native OpenAI API ``delta.tool_calls`` (models that support it)
        2. Plain text patterns like ``ACTION: read_file`` or ``read_file(/path)``
           (fallback for local models like Gemma that emit tools as text)
        """
        system = REASONING_LAYER_PROMPT + _load_project_context()
        user_input = f"User asked: {user_message}"
        if context:
            user_input += f"\nContext: {json.dumps(context)}"

        if tool_results:
            results_text = "\n".join(
                f"- Tool: {r.get('tool')}, Success: {r.get('success')}, Output: {str(r.get('output'))[:500]}"
                for r in tool_results
            )
            user_input += f"\n\nRECENT TOOL RESULTS:\n{results_text}"

        if observer_feedback:
            user_input += f"\n\nOBSERVER FEEDBACK:\n{observer_feedback}"

        logger.info("Streaming structured thoughts with tools for: %s", user_message[:80])

        full_text = ""
        async for item in self._tool_plan_llm.stream_chat_structured_async(
            system=system,
            user_message=user_input,
            history=chat_history,
            max_tokens=2000,
            tools=THINKING_TOOL_DEFINITIONS,
        ):
            if item.get("type") == "tool_call":
                yield item  # pass through to gateway for execution
            elif item.get("type") in ("reasoning", "content"):
                full_text += item.get("text", "")

        # ── Text-based tool call fallback ──
        # For models like Gemma that don't support native tool calls,
        # scan the accumulated text for tool call patterns.
        # Patterns: "TOOL: read_file(...)" or "ACTION: grep" or "read_file(/path)"
        text_tool_calls = self._extract_text_tool_calls(full_text)

        for tc in text_tool_calls:
            # Mark as text-detected so the gateway knows it's not native API
            yield {"type": "tool_call", "id": tc["id"], "function": tc["function"], "_source": "text"}
            # Pause here — the gateway will re-invoke with tool results

        yield {"type": "done", "text": full_text}

    _TOOL_CALL_PATTERNS: list[tuple[str, str]] = [
        # ACTION: tool_name / PARAM_KEY: value
        (r'ACTION:\s*(\w+)', 'flat'),
        # tool_name(param1=value1, param2=value2)
        (r'(read_file|grep|list_dir|find_files|search_artifacts|web_search|delegate_tasks|delegate_job_status|delegate_job_cancel|delegate_job_results)\s*\(([^)]*)\)', 'inline'),
    ]

    def _extract_text_tool_calls(self, text: str) -> list[dict]:
        """Scan free-form text for tool call patterns.
        
        Returns a list of dicts like ``{"id": "...", "function": {"name": "...", "arguments": "..."}}``.
        """
        import uuid
        calls: list[dict] = []

        # Pattern 1: Flat key-value format (like the tool plan prompt)
        # ACTION: read_file / PARAM_PATH: /foo
        lines = text.split('\n')
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            action_match = re.match(r'^ACTION:\s*(\w+)$', line, re.IGNORECASE)
            if action_match and action_match.group(1).lower() in ('read_file', 'grep', 'list_dir', 'find_files', 'search_artifacts', 'web_search', 'delegate_tasks', 'delegate_job_status', 'delegate_job_cancel', 'delegate_job_results'):
                tool_name = action_match.group(1).lower()
                args: dict[str, Any] = {}
                i += 1
                while i < len(lines):
                    param_line = lines[i].strip()
                    param_match = re.match(r'^PARAM_(\w+):\s*(.*)$', param_line, re.IGNORECASE)
                    if not param_match:
                        break
                    key = param_match.group(1).lower()
                    val = param_match.group(2).strip()
                    if val.lower() in ('true', 'false'):
                        val = val.lower() == 'true'
                    elif val.isdigit():
                        val = int(val)
                    args[key] = val
                    i += 1
                calls.append({
                    "id": f"text_tc_{uuid.uuid4().hex[:8]}",
                    "function": {"name": tool_name, "arguments": json.dumps(args)},
                })
                continue
            i += 1

        if calls:
            logger.info("Extracted %d text-based tool call(s) from thinking: %s", len(calls), [c["function"]["name"] for c in calls])

        return calls

    def _build_tool_plan_combined_message(
        self,
        user_message: str,
        tool_results: list[dict[str, Any]] | None = None,
        upfront_plan: dict[str, Any] | None = None,
        active_step_index: int | None = None,
        active_step_description: str | None = None,
        observer_feedback: str | None = None,
        knowledge_summary: str | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
        walls_hit: list[str] | None = None,
        task_graph: dict[str, Any] | None = None,
        validated_thoughts: list[dict[str, Any]] | None = None,
        free_thoughts: str | None = None,
        active_worktree_id: str | None = None,
        tool_history_digest: list[str] | None = None,
        model_override: str | None = None,
        rule_packs_to_inject: list[str] | None = None,  # JIT-inject these rule packs
        use_fc: bool | None = None,  # True=FC prompt, False=flat-text prompt, None=auto
        context_window_override: int | None = None,  # per-request override for context window
        context_output_reserve: float | None = None,  # per-request override for output reserve
        **kwargs,  # accept but ignore legacy artifact params
    ) -> tuple[str, str, str]:
        """Shared context for tool-plan — budget-aware to stay within context window.

        Uses the CORE_TOOL_PLAN_PROMPT (~40 lines) plus optionally injected rule
        packs (tool_rules, delegation_rules, etc.) loaded just-in-time based on
        ``rule_packs_to_inject``.

        For OpenAI-compatible and Ollama providers, uses the FC-optimized prompt
        (``CORE_TOOL_PLAN_PROMPT_FC``) since tools are defined via the API ``tools``
        parameter rather than in the text.

        Returns (assembled_user_message, prompt_tier, system_text) so the caller
        can use the configured system prompt directly.
        """
        # Per-request overrides: profile > model variant > env default.
        # Clone settings so we don't mutate the global object.
        effective_settings = self._settings.model_copy()
        if context_window_override is not None:
            effective_settings.context_window = context_window_override
        if context_output_reserve is not None:
            effective_settings.context_output_reserve = context_output_reserve
        budget = ContextBudget(effective_settings)

        # Select prompt variant: FC (function calling) for OpenAI/Ollama,
        # flat-text for Anthropic. Caller can override.
        if use_fc is None:
            fc_providers = {"openai", "ollama"}
            model_name = self._tool_plan_llm.model or ""
            # Local models rarely support native function calling properly — force flat-text for them
            if any(kw in model_name.lower() for kw in ("coder", "fable", "gguf", "qwen")):
                use_fc = False
            else:
                use_fc = self._tool_plan_llm.provider in fc_providers
        prompt_text = CORE_TOOL_PLAN_PROMPT_FC if use_fc else CORE_TOOL_PLAN_PROMPT

        # Inject the model-appropriate tool list based on model_override (only relevant for flat-text path).
        available = resolve_available_tools(model_override)
        if available is None:
            available = list(TOOL_PLAN_ALLOWED_TOOLS)
        formatted_tools = _format_tool_list(available)
        prompt_text = prompt_text.replace("{AVAILABLE_TOOLS}", formatted_tools)
        prompt_tier = "jit"

        # JIT-rule injection: merge requested rule packs into the system prompt.
        # Order: explicit request (rule_packs_to_inject) → instance stored (get_rule)
        jit_packs: list[str] = list(rule_packs_to_inject or [])
        stored_packs = getattr(self, '_injected_rule_packs', None) or []
        for p in stored_packs:
            if p not in jit_packs:
                jit_packs.append(p)
        if jit_packs:
            pack_texts = []
            for pack_name in jit_packs:
                pack_content = RULE_PACKS.get(pack_name)
                if pack_content:
                    pack_texts.append(f"\n═══ {pack_name.upper()} ═══\n{pack_content}")
            if pack_texts:
                prompt_text += "\n".join(pack_texts)
            self._injected_rule_packs = []  # reset after injection

        # Reserve space for system prompt (prompt + project context)
        system_text = prompt_text + _load_project_context()
        # When session already has a worktree, append a reminder that create_worktree is unavailable
        if active_worktree_id:
            system_text += (
                f"\n\n⚠️ ACTIVE WORKTREE: {active_worktree_id} — do NOT call create_worktree. "
                f"Use PARAM_WORKTREE_ID: {active_worktree_id} for all worktree tools."
            )
        budget.record("system_prompt", system_text)

        parts: list[str] = []

        # ── Walls (max 5% of budget) — summarized ──────────────────────
        walls = list(walls_hit or [])
        memory = memory_context or []
        for m in memory:
            content = m.get("content", {})
            if isinstance(content, dict) and content.get("walls"):
                walls.extend(content["walls"])
        if walls:
            walls_block = _categorize_walls(walls) + "\n"
            parts.append(budget.allocate("walls", walls_block, max_share=0.05))
            parts.append("")

        # ── Task graph (compact, tier-aware) ──────────────────────────────
        if task_graph:
            nodes = task_graph.get("nodes", [])
            foundational = [n for n in nodes if n.get("tier", "foundational") == "foundational"]
            active = [n for n in nodes if n.get("tier", "foundational") == "active"]
            last_actions = [
                n.get("title", str(n))[:60]
                for n in nodes[-5:]
                if n.get("node_type") in ("ActionNode", "Action")
            ]
            tg_summary = (
                f"Task graph: {len(foundational)} foundational nodes, {len(active)} active nodes. "
                f"Last actions: {', '.join(last_actions[-3:]) or 'none'}."
            )
            parts.append(tg_summary)
            budget.record("task_graph", tg_summary)
            parts.append("")

        # ── Memory + rules (max 10% of budget) — summarized ─────────────
        rules_list = rules or []
        if memory_stale_hint:
            parts.append(f"IMPORTANT — {memory_stale_hint}")
            parts.append("")
        if memory or rules_list or knowledge_summary or walls:
            mem_block = _summarize_knowledge(memory, rules_list, knowledge_summary, len(walls))
            parts.append(budget.allocate("memory_rules", mem_block, max_share=0.10))
            parts.append("")

        # ── Validated thoughts (max 10%) ────────────────────────────────
        if validated_thoughts:
            thoughts_text = "\n".join(
                f"  - [{t.get('confidence', 0):.1f}] {t.get('thought', '')}: {t.get('rationale', '')}"
                for t in validated_thoughts
            )
            block = (
                "═══ AGENT THOUGHTS (step-level reasoning — BINDING: your next ACTION MUST execute what these thoughts conclude, e.g. 'run npm install' → bash npm install, 'add import' → apply_patch. Do NOT skip.) ═══\n"
                f"{thoughts_text}\n"
            )
            parts.append(budget.allocate("validated_thoughts", block, max_share=0.10))

        # ── Free thoughts (max 8%) — summarized TOC with drill-down ──────
        _free_thoughts_block = None
        if free_thoughts:
            block = _summarize_free_thoughts(free_thoughts)
            _free_thoughts_block = budget.allocate(
                "free_thoughts", block, max_share=0.08,
            )

        # ── User request (max 5%) ──────────────────────────────────────
        user_block = f"User request: {user_message}"
        parts.append(budget.allocate("user_request", user_block, max_share=0.05))

        # ── Upfront plan — deferred to after tool results (highest authority, last position) ──
        _upfront_plan_block = None
        if upfront_plan:
            steps = upfront_plan.get("steps", [])
            n_steps = len(steps)
            if steps and isinstance(steps[0], dict):
                step_descs = [s.get('description', s) for s in steps]
            else:
                step_descs = [str(s) for s in steps]
            criteria = upfront_plan.get("success_criteria", [])
            criteria_str = (
                "\n".join(f"  - {c}" for c in criteria)
                if criteria
                else "  (none specified)"
            )

            focus_desc = active_step_description
            if (
                not focus_desc
                and isinstance(active_step_index, int)
                and steps
                and 0 <= active_step_index < len(steps)
            ):
                step_at = steps[active_step_index]
                if isinstance(step_at, dict):
                    focus_desc = (
                        step_at.get("description")
                        or step_at.get("action")
                        or str(step_at)
                    )
                else:
                    focus_desc = str(step_at)

            if focus_desc:
                # Show active step only + TOC of remaining
                remaining_steps = n_steps - (active_step_index + 1) if isinstance(active_step_index, int) else max(0, n_steps - 1)
                toc_lines = [
                    f"\n═══ ACTIVE PLAN STEP (THIS IS YOUR PRIMARY DIRECTIVE — execute this step now) ═══"
                    f"\n  → {focus_desc}"
                    f"\nSuccess criteria:\n{criteria_str}"
                ]
                if n_steps > 1:
                    toc_lines.append(
                        f"\n  📋 Plan: {n_steps} step(s) total — you are on step {(active_step_index or 0) + 1}/{n_steps}. "
                        f"{remaining_steps} step(s) remain after this."
                    )
                if remaining_steps > 0:
                    remaining_titles = step_descs[active_step_index + 1:] if isinstance(active_step_index, int) else step_descs[1:]
                    toc_lines.append("  Remaining steps:")
                    for i, title in enumerate(remaining_titles[:4], (active_step_index or 0) + 2):
                        toc_lines.append(f"    {i}. {title[:100]}")
                    if len(remaining_titles) > 4:
                        toc_lines.append(f"    ... and {len(remaining_titles) - 4} more step(s).")
                plan_block = "\n".join(toc_lines)
            else:
                # No active step — show all step titles as TOC
                step_titles = "\n".join(
                    f"  {i+1}. {d[:100]}" for i, d in enumerate(step_descs)
                )
                plan_block = (
                    f"\n═══ PLAN (follow these steps in order — this is your PRIMARY DIRECTIVE) ═══\n"
                    f"{step_titles}\nSuccess criteria:\n{criteria_str}"
                )
            _upfront_plan_block = budget.allocate("upfront_plan", plan_block, max_share=0.08)

        # Note: artifacts are no longer auto-injected here. The LLM uses
        # the `search_artifacts` tool to query documents on demand.

        # ── Active worktree (tiny, but critical to prevent duplicate creates) ──
        if active_worktree_id:
            parts.append(
                f"\n⚠️ ACTIVE WORKTREE: {active_worktree_id} — DO NOT call create_worktree. "
                f"Use PARAM_WORKTREE_ID: {active_worktree_id} for all edit_file / write_file / apply_patch / read_worktree_file / bash calls."
            )
            budget.record("active_worktree", f"worktree_id={active_worktree_id}")

        # ── Tool history digest (compact, survives slice(-5) truncation) ──
        if tool_history_digest:
            digest_block = (
                "═══ FULL SESSION TOOL HISTORY (compact — do NOT repeat identical calls) ═══\n"
                + "\n".join(tool_history_digest)
                + "\n"
            )
            parts.append(budget.allocate("tool_history_digest", digest_block, max_share=0.08))
            parts.append("")

        # ── Observer feedback (max 5%) ─────────────────────────────────
        if observer_feedback:
            block = f"\nObserver feedback (goal NOT yet met — you MUST continue):\n{observer_feedback}"
            parts.append(budget.allocate("observer_feedback", block, max_share=0.05))

        # ── Tool results (consume remaining budget) ────────────────────
        if tool_results:
            succ = [
                r for r in tool_results if r.get("success") and not r.get("blocked")
            ]
            if len(succ) >= 1:
                digest_lines: list[str] = []
                for r in succ[-12:]:
                    t = r.get("tool", "?")
                    if t == "grep":
                        digest_lines.append(
                            f"  ✓ grep pattern={str(r.get('pattern', ''))[:100]} path={str(r.get('path', ''))[:100]}"
                        )
                    elif t == "bash":
                        digest_lines.append(
                            f"  ✓ bash {str(r.get('command', ''))[:140]}"
                        )
                    elif t == "create_worktree":
                        digest_lines.append(
                            f"  ✓ create_worktree worktree_id={r.get('worktree_id', '') or '(see output)'}"
                        )
                    elif t in ("read_file", "read_worktree_file"):
                        sl = r.get("start_line")
                        el = r.get("end_line")
                        rng = f" L{sl}-{el}" if sl is not None else ""
                        # Add line count info so LLM knows content WAS retrieved
                        import re as _re
                        _out = r.get("output", "") or ""
                        _trunc = _re.search(r"truncated at (\d+) of (\d+) lines", _out)
                        _total = _re.match(r"^\[(\d+) lines total\]", _out)
                        _info = ""
                        if _trunc:
                            _info = f" (got {_trunc.group(1)}/{_trunc.group(2)} lines)"
                        elif _total:
                            _info = f" ({_total.group(1)} lines)"
                        digest_lines.append(
                            f"  ✓ {t} path={str(r.get('path', ''))[:120]}{rng}{_info}"
                        )
                    elif t in ("list_dir", "find_files"):
                        digest_lines.append(
                            f"  ✓ {t} path={str(r.get('path', ''))[:120]}"
                        )
                    else:
                        digest_lines.append(f"  ✓ {t}")
                parts.append(
                    "═══ ALREADY SUCCEEDED (ground truth — do NOT repeat identical calls; advance the task) ═══\n"
                    + "\n".join(digest_lines)
                    + "\n"
                )
                budget.record("tool_digest", "\n".join(digest_lines))

            # Budget-aware tool result output: give most recent results full space,
            # older results get condensed summaries to stay within budget.
            tool_parts: list[str] = []
            tool_parts.append("\nPrevious tool call results:")
            last_failed = False

            remaining_tokens = (
                budget.remaining - 200
            )  # reserve for closing instructions
            # Show last 3 results with full output, older results condensed
            full_results = tool_results[-3:]
            condensed_results = tool_results[:-3] if len(tool_results) > 3 else []

            # Condensed older results: tool name + status + smart preview
            if condensed_results:
                tool_parts.append(
                    f"\n[{len(condensed_results)} older results condensed to save context]"
                )
                for i, r in enumerate(condensed_results, 1):
                    status = (
                        "SUCCESS"
                        if r.get("success")
                        else ("BLOCKED" if r.get("blocked") else "FAILED")
                    )
                    tool_name = r.get("tool", "?")
                    raw_output = r.get("output", "") or ""
                    # For read results, show informative summary instead of raw content
                    if tool_name in ("read_file", "read_worktree_file") and r.get("success"):
                        import re as _re
                        trunc_m = _re.search(r"truncated at (\d+) of (\d+) lines", raw_output)
                        total_m = _re.match(r"^\[(\d+) lines total\]", raw_output)
                        path = r.get("path", "")
                        if trunc_m:
                            output_preview = f"Read {path} — {trunc_m.group(1)} of {trunc_m.group(2)} lines retrieved successfully (truncated; use start_line/end_line for more)"
                        elif total_m:
                            output_preview = f"Read {path} — {total_m.group(1)} lines retrieved successfully"
                        else:
                            output_preview = raw_output[:200]
                    else:
                        output_preview = raw_output[:200]
                    tool_parts.append(
                        f"  #{i} {tool_name} [{status}]: {output_preview}"
                    )

            # Full recent results: cap each at budget-aware limit
            per_result_cap = max(500, remaining_tokens * 4 // max(len(full_results), 1))
            start_idx = len(condensed_results) + 1
            for i, r in enumerate(full_results, start_idx):
                status = "SUCCESS" if r.get("success") else "FAILED"
                if r.get("blocked"):
                    status = "BLOCKED"
                last_failed = not r.get("success") and not r.get("blocked")
                tool_parts.append(
                    f"\n--- Tool call #{i} ({r.get('tool', '?')}) [{status}] ---"
                )
                tool_parts.append(r.get("output", "(no output)")[:per_result_cap])

            if last_failed:
                tool_parts.append(
                    "\n[IMPORTANT: The last tool call FAILED. "
                    "IF you were editing (apply_patch/edit_file/write_file): FIX the parameter and RETRY the same tool — "
                    "do NOT switch to grep/list_dir. "
                    "IF you were exploring: try a different path/pattern. "
                    "See RETRY DISCIPLINE in your instructions.]"
                )
            else:
                tool_parts.append(
                    "\n[IMPORTANT: The last tool call SUCCEEDED. Do NOT repeat the same parameters; use the output or move to the next phase (e.g. read → edit_file / create_worktree).]"
                )
            tool_parts.append(
                "\nBased on these results, decide: do you need another tool call (or a retry with a different approach), "
                "or can you give a final answer?"
            )
            tool_block = "\n".join(tool_parts)
            parts.append(budget.allocate("tool_results", tool_block, max_share=0.60))

        # ── Free thoughts (context for HOW to execute) ──
        if _free_thoughts_block:
            parts.append(_free_thoughts_block)

        # ── Upfront plan (WHAT to execute — last position = highest authority) ──
        if _upfront_plan_block:
            parts.append(_upfront_plan_block)

        # ── Closing instruction ────────────────────────────────────────
        closing = (
            "\n═══ NOW OUTPUT YOUR TOOL PLAN ONLY ═══\n"
            "First line MUST be REASONING: (then DECISION:, then ACTION: or ANSWER:/QUESTION: as required). "
            "Do not repeat or paraphrase any section from above."
        )
        parts.append(closing)
        budget.record("closing", closing)

        # Store budget for observability / API exposure
        self._last_context_budget = budget.as_dict()
        logger.info(
            "Context budget: %d/%d input tokens used (%.0f%% of budget), breakdown: %s",
            budget.used,
            budget.total,
            (budget.used / budget.total * 100) if budget.total else 0,
            {k: v for k, v in budget._breakdown.items() if v > 50},
        )

        return "\n".join(parts), prompt_tier, system_text

    def _heuristic_repair_tool_plan_raw(self, raw: str, error_context: str) -> str:
        """Single LLM pass: turn prose / broken output into a flat tool plan."""
        allowed = ", ".join(TOOL_PLAN_ALLOWED_TOOLS)
        system = TOOL_PLAN_HEURISTIC_REPAIR_PROMPT.replace("{ALLOWED_TOOLS}", allowed)
        snippet = (raw or "")[:14000]
        user_msg = (
            f"ISSUE:\n{(error_context or '')[:4000]}\n\n" f"BROKEN_OUTPUT:\n{snippet}"
        )
        try:
            fixed = self._tool_plan_llm.chat(system=system, user_message=user_msg)
        except Exception as e:
            logger.warning("heuristic tool-plan repair LLM failed: %s", e)
            return raw or ""
        out = (fixed or "").strip()
        return out if out else (raw or "")

    @staticmethod
    def _needs_internal_validation_repair(plan: dict[str, Any]) -> bool:
        if not plan.get("_retry_hint"):
            return False
        if plan.get("action") != "final_answer":
            return False
        ans = str(plan.get("answer", ""))
        return "[INTERNAL:" in ans or "INVALID_TOOL" in ans

    def _parse_tool_plan_raw_impl(self, raw: str) -> dict[str, Any]:
        """Parse LLM tool-plan output: prefer flat KEY: value lines; fall back to JSON + repair."""
        text = raw or ""
        # Light normalization for common "KEY - value" / "KEY = value" variants.
        # The flat parser only understands `KEY: value` so normalize those first.
        norm = text
        norm = re.sub(r"(?mi)^\s*DECISION\s*[-=]\s*", "DECISION: ", norm)
        norm = re.sub(r"(?mi)^\s*ACTION\s*[-=]\s*", "ACTION: ", norm)
        norm = re.sub(r"(?mi)^\s*REASONING\s*[-=]\s*", "REASONING: ", norm)
        norm = re.sub(r"(?mi)^\s*ANSWER\s*[-=]\s*", "ANSWER: ", norm)
        norm = re.sub(r"(?mi)^\s*QUESTION\s*[-=]\s*", "QUESTION: ", norm)
        # Markdown bullets before keys (e.g. "- DECISION: ACT")
        norm = re.sub(r"(?m)^\s*[-*•]\s+", "", norm)
        norm = _strip_tool_plan_preamble(norm)

        flat = parse_flat_tool_plan_lines(norm)

        # Be forgiving: some models emit ACTION/ANSWER/QUESTION without DECISION.
        if not flat.get("DECISION"):
            if flat.get("ACTION"):
                flat["DECISION"] = "ACT"
            elif flat.get("QUESTION"):
                flat["DECISION"] = "NEED_MORE_INFO"
            elif flat.get("ANSWER") or flat.get("MESSAGE") or flat.get("RESPONSE"):
                flat["DECISION"] = "ANSWER_DIRECTLY"

        if flat.get("DECISION"):
            plan = flat_dict_to_plan(flat)
            out = _normalize_tool_plan_output(plan)
            if out.get("action") not in (
                "call_tool",
                "final_answer",
                "teach_rule",
                "update_rule",
                "delete_rule",
            ):
                raise ValueError(
                    f"Invalid action after flat parse: {out.get('action')!r}"
                )
            return out

        # Embedded JSON may appear after prose; extract_json finds first { ... } / fenced block.
        parsed: Any = None
        try:
            parsed = extract_json(norm)
        except (ValueError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, dict):
            out = _normalize_tool_plan_output(parsed)
            if out.get("action") in (
                "call_tool",
                "final_answer",
                "teach_rule",
                "update_rule",
                "delete_rule",
            ):
                return out

        raise ValueError(
            "Tool plan: no valid flat plan (missing REASONING:/DECISION: block) and no embedded structured plan"
        )

    async def parse_tool_plan_raw(self, raw: str) -> dict[str, Any]:
        """Parse tool-plan text; on failure or INTERNAL validation errors, one LLM repair pass."""
        try:
            out = self._parse_tool_plan_raw_impl(raw)
        except ValueError as e:
            logger.info("tool-plan parse failed — heuristic repair (%s)", e)
            repaired = self._heuristic_repair_tool_plan_raw(raw, str(e))
            try:
                out = self._parse_tool_plan_raw_impl(repaired)
            except ValueError as e2:
                logger.warning("tool-plan still unparseable after repair: %s", e2)
                raise e from e2

        if self._needs_internal_validation_repair(out):
            hint = str(out.get("answer", ""))[:4000]
            logger.info("tool-plan INTERNAL validation — heuristic repair")
            repaired = self._heuristic_repair_tool_plan_raw(raw, hint)
            try:
                out2 = self._parse_tool_plan_raw_impl(repaired)
            except ValueError as e3:
                logger.warning("tool-plan repair after validation failed parse: %s", e3)
                return out
            if self._needs_internal_validation_repair(out2):
                return out
            return out2

        return out

    async def plan_tool_calls(
        self,
        user_message: str,
        tool_results: list[dict[str, Any]] | None = None,
        chat_history: list[dict[str, str]] | None = None,
        upfront_plan: dict[str, Any] | None = None,
        active_step_index: int | None = None,
        active_step_description: str | None = None,
        observer_feedback: str | None = None,
        knowledge_summary: str | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
        walls_hit: list[str] | None = None,
        task_graph: dict[str, Any] | None = None,
        validated_thoughts: list[dict[str, Any]] | None = None,
        free_thoughts: str | None = None,
        active_worktree_id: str | None = None,
        tool_history_digest: list[str] | None = None,
        rule_packs_to_inject: list[str] | None = None,
        model_override: str | None = None,
        max_tokens: int | None = None,  # model-tier-specific output token cap
    ) -> dict[str, Any]:
        """Plan next tool call or final answer using native function calling (preferred)
        or flat-text fallback.

        Uses ``chat_structured_async`` with tool definitions for OpenAI-compatible
        and Ollama providers. Falls back to ``chat_async`` + ``parse_tool_plan_raw``
        for Anthropic.
        """
        message_args: dict[str, Any] = {}
        for kw in ('upfront_plan', 'active_step_index', 'active_step_description',
                    'observer_feedback', 'knowledge_summary', 'memory_context', 'rules',
                    'memory_stale_hint', 'walls_hit', 'task_graph', 'validated_thoughts',
                    'free_thoughts', 'active_worktree_id', 'tool_history_digest'):
            val = locals().get(kw)
            if val is not None:
                message_args[kw] = val

        base_combined, prompt_tier, system = self._build_tool_plan_combined_message(
            user_message=user_message,
            **message_args,
            model_override=model_override,
            rule_packs_to_inject=rule_packs_to_inject,
        )
        logger.info(
            "Planning tool call for: %s (prior_results=%d, prompt_tier=%s)",
            user_message[:80],
            len(tool_results or []),
            prompt_tier,
        )

        # Determine available tools for this model
        available = resolve_available_tools(model_override)
        if available is None:
            available = list(TOOL_PLAN_ALLOWED_TOOLS)

        # Check if FC is supported
        fc_providers = {"openai", "ollama"}
        model_name = self._tool_plan_llm.model or ""
        # Local models rarely support native function calling properly — force flat-text for them
        if any(kw in model_name.lower() for kw in ("coder", "fable", "gguf", "qwen")):
            use_fc = False

        max_retries = 3
        last_error: Exception | None = None

        if use_fc:
            # ── Native function calling path ──
            tool_defs = _build_tool_definitions(available)
            for attempt in range(1, max_retries + 1):
                try:
                    fc_resp = await self._tool_plan_llm.chat_structured_async(
                        system=system,
                        user_message=base_combined,
                        history=chat_history,
                        tools=tool_defs,
                        max_tokens=max_tokens,
                    )
                    plan = _fc_response_to_plan(fc_resp)
                    # Validate: INVALID_TOOL answer means the call name was bad
                    if plan.get("action") == "final_answer" and "_retry_hint" in plan:
                        logger.warning(
                            "FC tool plan invalid tool (attempt %d/%d): %s",
                            attempt, max_retries,
                            plan.get("answer", "")[:200],
                        )
                        if attempt < max_retries:
                            # Retry with a system hint
                            base_combined += (
                                "\n\n[SYSTEM: The tool name you used is not valid. "
                                f"Use ONLY one of these function names: {', '.join(t['function']['name'] for t in tool_defs)}]"
                            )
                            continue
                        return plan
                    return plan
                except Exception as e:
                    last_error = e
                    logger.warning(
                        "FC tool plan attempt %d/%d failed: %s — %s",
                        attempt, max_retries, type(e).__name__, e,
                    )
                    if attempt < max_retries:
                        continue
                    break

            logger.error("FC tool plan failed after %d attempts: %s", max_retries, last_error)
        else:
            # ── Flat text fallback (Anthropic) ──
            combined = base_combined
            extra_hints = ""
            for attempt in range(1, max_retries + 1):
                try:
                    raw = await self._tool_plan_llm.chat_async(
                        system=system, user_message=combined, history=chat_history
                    )
                    return await self.parse_tool_plan_raw(raw)
                except ValueError as e:
                    last_error = e
                    logger.warning(
                        "Tool plan attempt %d/%d failed (parse): %s — retrying",
                        attempt, max_retries, e,
                    )
                    if attempt < max_retries:
                        extra_hints += (
                            "\n\n[SYSTEM: Your previous reply was not a valid tool plan. "
                            "Output ONLY flat lines (no JSON): DECISION:, ACTION: (if ACT), PARAM_*:, REASONING:. "
                            "See the format in your system instructions.]"
                        )
                        combined = base_combined + extra_hints
                    continue
                except Exception as e:
                    logger.error(
                        "Tool plan LLM call failed (attempt %d/%d): %s",
                        attempt, max_retries, e,
                    )
                    last_error = e
                    if attempt < max_retries:
                        continue
                    break

            logger.error("Tool plan failed after %d attempts: %s", max_retries, last_error)

        fallback_pattern = _extract_fallback_keyword(user_message)
        if fallback_pattern:
            return {
                "action": "call_tool",
                "tool": "grep",
                "pattern": fallback_pattern,
                "path": "/workspace",
                "reasoning": "Fallback tool-plan: model did not output a parseable plan; starting with grep over /workspace.",
            }
        return {
            "action": "final_answer",
            "answer": f"I had trouble planning tool calls after {max_retries} attempts. Could you rephrase your request?",
        }

    async def stream_tool_plan(
        self,
        user_message: str,
        tool_results: list[dict[str, Any]] | None = None,
        chat_history: list[dict[str, str]] | None = None,
        upfront_plan: dict[str, Any] | None = None,
        active_step_index: int | None = None,
        active_step_description: str | None = None,
        observer_feedback: str | None = None,
        knowledge_summary: str | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
        walls_hit: list[str] | None = None,
        task_graph: dict[str, Any] | None = None,
        validated_thoughts: list[dict[str, Any]] | None = None,
        free_thoughts: str | None = None,
        active_worktree_id: str | None = None,
        model_override: str | None = None,
        tool_history_digest: list[str] | None = None,
        rule_packs_to_inject: list[str] | None = None,
        context_window_override: int | None = None,
        context_output_reserve: float | None = None,
        max_tokens: int | None = None,
        **kwargs,  # accept but ignore legacy artifact params
    ):
        """Async generator for tool-plan generation.

        Uses flat-text format with built-in tool descriptions that include
        required parameter hints. The full output is parsed by the gateway.

        Yields:
            str — plain text chunks from the LLM.
        """
        base_combined, prompt_tier, system = self._build_tool_plan_combined_message(
            user_message=user_message,
            tool_results=tool_results,
            upfront_plan=upfront_plan,
            active_step_index=active_step_index,
            active_step_description=active_step_description,
            observer_feedback=observer_feedback,
            knowledge_summary=knowledge_summary,
            memory_context=memory_context,
            rules=rules,
            memory_stale_hint=memory_stale_hint,
            walls_hit=walls_hit,
            task_graph=task_graph,
            validated_thoughts=validated_thoughts,
            free_thoughts=free_thoughts,
            active_worktree_id=active_worktree_id,
            tool_history_digest=tool_history_digest,
            model_override=model_override,
            rule_packs_to_inject=rule_packs_to_inject,
            context_window_override=context_window_override,
            context_output_reserve=context_output_reserve,
            use_fc=False,
        )
        async for chunk in self._tool_plan_llm.stream_chat_async(
            system=system, user_message=base_combined, history=chat_history
        ):
            yield chunk

    async def summarize_tool_results(
        self, user_message: str, tool_results: list[dict[str, Any]]
    ) -> str:
        """Generate a natural language summary of tool execution results."""
        system = (
            "You are a helpful assistant. The user asked a question and tools were used to gather information. "
            "Summarize the results clearly and concisely. Reference specific data from the tool outputs. "
            "If a tool was blocked for security reasons, explain that politely."
        )
        parts = [f"User question: {user_message}", "\nTool results:"]
        for i, r in enumerate(tool_results, 1):
            status = (
                "SUCCESS"
                if r.get("success")
                else ("BLOCKED" if r.get("blocked") else "FAILED")
            )
            parts.append(f"\n--- Tool #{i}: {r.get('tool', '?')} [{status}] ---")
            parts.append(r.get("output", "(no output)")[:3000])

        text = await self._llm.chat_async(system=system, user_message="\n".join(parts))
        return text

    async def summarize_history(self, messages: list[dict[str, str]]) -> str:
        """Produce a concise summary of conversation history for context window management."""
        if not messages:
            return ""
        system = (
            "You are a helpful assistant. Summarize the following conversation history into a brief, "
            "structured summary (3-8 bullet points). Capture: key questions, decisions, findings, and "
            "any important context. Be concise. Output only the summary, no preamble."
        )
        parts = []
        for m in messages:
            role = m.get("role", "unknown")
            content = (m.get("content", "") or "")[:2000]
            parts.append(f"{role.upper()}: {content}")
        user_msg = "\n\n".join(parts)
        return await self._llm.chat_async(system=system, user_message=user_msg, max_tokens=512)
