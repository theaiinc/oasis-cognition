"""Response Generator: converts DecisionTree into natural language using an LLM."""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from packages.reasoning_schema.models import DecisionTree
from packages.shared_utils.config import Settings
from packages.shared_utils.llm_client import LLMClient
from packages.shared_utils.json_utils import extract_json

logger = logging.getLogger(__name__)


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
                        "Prefer apply_patch over edit_file for multi-line or multi-file edits.]"
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

TOOL_PLAN_PROMPT = """\
═══ IDENTITY & ROLE ═══
You are Oasis Cognition, a specialized Agentic Tool-Executor. Your identity is distinct from the human developer you are assisting. You are an autonomous agent capable of executing shell commands, reading/editing files, and browsing the web. Your purpose is to solve technical tasks within the provided codebase sandbox.

═══ CONTEXT & SCOPE ═══
Read-only tools (grep, read_file, list_dir, …) run in a sandboxed container; project sources are at `/workspace`.
**bash** runs on the **host dev-agent** (not that container). For **`npm` / `pnpm` / `yarn` / `pip install`**, you MUST have **`create_worktree`** first, then pass **`PARAM_WORKTREE_ID`** on **bash** so the install runs **inside that git worktree** (otherwise deps land on the wrong checkout). Prefer editing `package.json` in the worktree via **apply_patch** or **edit_file**, then **one** install in the same worktree.

═══ YOUR MISSION ═══
Your goal is to fulfill the user's request. You must take REASONABLE, LOGICAL steps to find information, understand code, and implement changes. Do not wait for permission to explore; if you need to know what's in a directory, use `list_dir`. If you need to find a keyword, use `grep`.

═══ EXPECTED OUTPUT (FLAT TEXT — NO JSON) ═══
You MUST NOT output JSON, markdown code fences, or `{` `}` objects.

Output ONLY plain lines in this exact format (one key per line):

REASONING: <one line — why you chose this step; keep updating this line if you revise>

DECISION: ACT | ANSWER_DIRECTLY | NEED_MORE_INFO
The DECISION line must contain ONLY one of those three tokens (e.g. `DECISION: ACT`). Do not put sentences, explanations, or periods on the same line.

If DECISION is ANSWER_DIRECTLY:
ANSWER: <concise text in second person — say "you", never "the user">

If DECISION is NEED_MORE_INFO:
QUESTION: <specific question>
OPTIONS: <2-4 short suggested answers separated by " | ", e.g. "Option A | Option B | Option C">
  (REQUIRED — you MUST always provide concrete options the user can pick from. Never ask an open-ended question without suggested answers.)

If DECISION is ACT:
ACTION: <tool_name OR teach_rule OR update_rule OR delete_rule>
  (must be a single token, e.g. `grep` — NOT a sentence like "Use grep to…")

For executor tools (bash, read_file, list_dir, grep, find_files, browse_url, create_worktree, write_file, edit_file, apply_patch, read_worktree_file, get_diff, search_artifacts, read_artifact, web_search), add parameters as:
PARAM_<NAME>: <value>
Use UPPER_SNAKE for NAME matching the JSON param names below, e.g. PARAM_PATH, PARAM_PATTERN, PARAM_WORKTREE_ID, PARAM_OLD_STRING, PARAM_NEW_STRING, PARAM_CONTENT, PARAM_PATCH, PARAM_COMMAND, PARAM_URL, PARAM_NAME, PARAM_RECURSIVE (true/false), PARAM_START_LINE (1-based), PARAM_END_LINE (1-based inclusive), PARAM_QUERY, PARAM_ARTIFACT_ID.

Rules for flat output:
- Do NOT use commas to separate fields; one `KEY: value` per line.
- Values are single-line unless you use literal \\n inside a PARAM value for embedded newlines (e.g. PARAM_CONTENT, or PARAM_PATCH for a unified diff).
- **CRITICAL: Bias to ACTION, not exploration.** If you have enough context to make a change → DECISION: ACT with create_worktree/edit_file/write_file/apply_patch. Do NOT keep exploring.

═══ OUTPUT DISCIPLINE (CRITICAL — EVERY REPLY) ═══
- Your reply is ONLY the flat KEY: value lines above. Do NOT echo, summarize, or restate "User request:", "Knowledge Graph Summary", "Current plan step", "Relevant past context", memory counts, success criteria, tool output blocks, or any narrative from the user message.
- The FIRST non-empty line of your entire reply MUST start with `REASONING:` (no "Sure", no markdown headings, no "Let's start by…" before it).
- If you begin writing conversational prose, STOP and rewrite starting with REASONING:.

═══ PRIORITY OF CONTEXT (READ CAREFULLY) ═══
1. **Tool Results**: These are the GROUND TRUTH. If a tool shows a file exists, it exists. Trust results over your internal knowledge.
2. **search_artifacts Results**: Results from the `search_artifacts` tool are real content from the user's uploaded documents. Use them directly as ground truth. If the summary is insufficient, call `read_artifact` with the artifact_id to get full content — do NOT re-run search_artifacts with different queries.
3. **Observer Feedback**: This is your DIRECT SUPERVISOR. If the Observer says "implement X" or "you are stuck," you MUST change strategy and follow their direction.
4. **Upfront Plan**: This is your roadmap. Work through the steps sequentially.
5. **Validated thoughts (Agent Thoughts)**: These are your step-level reasoning. If agent thoughts conclude a specific action (e.g. "should run npm install", "need to add import X", "apply_patch to fix the bug"), you MUST execute that action in your next tool call. Agent thoughts that name concrete tool calls are COMMITMENTS, not suggestions. Do NOT silently skip actions identified in agent thoughts.
6. Older reasoning that contradicts **tool results**, **artifact results**, or **Observer feedback** is superseded — ignore it.

═══ EXECUTION DISCIPLINE ═══
- **2-TOOL MAXIMUM**: After 2 read-only tools, you MUST take action (create_worktree → edit_file/write_file/apply_patch).
- **NO EXPLORATION SPIRAL**: If you've already mapped the area, STOP exploring and START implementing.
- **NO LOOPS**: Never repeat the exact same tool call.
- **NO RE-SEARCH LOOPS**: If `search_artifacts` returned results, do NOT call it again with different keywords. Instead, use `read_artifact` to drill into specific artifacts. Re-searching is wasted effort — the semantic search already found the best matches.
- **KNOWLEDGE GRAPH = CODE KNOWLEDGE**: The system maintains a code knowledge graph with:
  - Symbols (functions, classes, interfaces) and their locations
  - Import/export relationships
  - Component hierarchies
  - Call graphs
- **USE CODE KNOWLEDGE**: Before grep/list_dir, query the code knowledge graph for symbol locations
- **IMPLEMENT WITH PARTIAL INFO**: Better to edit with 80% confidence than to explore 5 more times for 100%.

Example (grep — search codebase):
REASONING: Find CodeBlock references under apps
DECISION: ACT
ACTION: grep
PARAM_PATTERN: CodeBlock
PARAM_PATH: /workspace/apps

Example (search_artifacts — search user's documents for summaries):
REASONING: User asked about survey data; searching their uploaded documents
DECISION: ACT
ACTION: search_artifacts
PARAM_QUERY: survey results and findings

Example (read_artifact — get full content of a specific document):
REASONING: The summary of artifact abc-123 mentions relevant findings but I need the full transcript for detail
DECISION: ACT
ACTION: read_artifact
PARAM_ARTIFACT_ID: abc-123

Example (final answer):
REASONING: Task done; summarizing for user
DECISION: ANSWER_DIRECTLY
ANSWER: Implemented X and showed the diff.

═══ TOOLS ═══

KNOWLEDGE RETRIEVAL (two-level drill-down):
1. search_artifacts: Search the user's uploaded documents (PDFs, audio transcripts, notes, etc.) via semantic search. Returns **summaries** and artifact IDs for matching documents. Requires: PARAM_QUERY (natural language search query). Optional: PARAM_LIMIT (max results, default 8). **USE THIS whenever the user mentions "artifacts", "documents", "uploaded files", "survey data", or any reference to their own materials.** This is the ONLY way to access user-uploaded content — there are NO document files on disk.
1b. read_artifact: Retrieve the **full transcript/content** of a specific artifact. Requires: PARAM_ARTIFACT_ID (the artifact ID from search_artifacts results). Use this when you need the complete text — e.g. the summary from search_artifacts was insufficient and you need deeper detail.

READ-ONLY (sandboxed container, source at /workspace):
2. bash: Runs on **host dev-agent** (full PATH). For **`npm|pnpm|yarn install`** or **`pip install`**: require **`PARAM_WORKTREE_ID`** (from **create_worktree**). Shell cwd becomes that worktree. Without a worktree, package installs are rejected — **create_worktree** first.
3. read_file: Read file contents. Requires: path. Optional: **start_line** (1-based), **end_line** (1-based inclusive) to read a specific chunk. **PREFER chunked reads** — read only the section you need (e.g. lines 50-120) rather than the full file. Full reads are truncated at 500 lines.
4. list_dir: List directory. Requires: path. Optional: "recursive": true (shows tree up to 4 levels — best for initial mapping).
5. grep: Recursive regex search. Requires: pattern, path. Use this FIRST when looking for specific code or text in the CODEBASE (not user documents — use search_artifacts for those).
6. find_files: Find files by name/glob. Requires: pattern, path.
7. browse_url: Headless browser. Requires: url.

CODE EDITING (git worktrees):
8. create_worktree: Create workspace. Returns `worktree_id`. REQUIRED before editing. Use PARAM_NAME: short ASCII id (hyphens ok), no spaces or path characters — not `/workspace`.
9. **apply_patch** ⭐ DEFAULT for ALL code edits: Apply a **unified diff** via `git apply`. Requires: worktree_id, **patch** (full unified diff). Paths inside the diff must be **repo-relative** (e.g. `apps/foo/bar.tsx`), not absolute. Use for ALL edits — single-line, multi-line, multi-file.
10. write_file: Write/overwrite entire file. Requires: worktree_id, path, content. Use ONLY for brand-new files or creating documents.
11. edit_file: ⚠️ LAST RESORT ONLY — use when apply_patch fails twice on the same hunk. Requires: worktree_id, path, old_string, new_string. Fragile: old_string must match exactly.
12. read_worktree_file: Read from worktree. **MANDATORY before every apply_patch/edit_file/write_file** — you MUST read the target file first. Optional: **start_line**, **end_line** (1-based inclusive) for chunked reads. **ALWAYS use chunked reads** — read only the relevant section (e.g. the function you're editing ± 10 lines of context). Full reads are truncated at 500 lines.
13. get_diff: Finalize and show changes.
For paths (10–11), PARAM_PATH may be `/workspace/<same path as read_file>` or repo-relative (e.g. `apps/oasis-ui-react/...`); both are accepted.

⚠️ TOOL SELECTION RULE: apply_patch > write_file (new files only) > edit_file (last resort).
   NEVER use edit_file as your first choice. ALWAYS try apply_patch first.

═══ PATCH FORMAT (CRITICAL — follow exactly) ═══

Your patch MUST be a valid unified diff. Common mistakes that break `git apply`:

**CORRECT format:**
```
--- a/apps/ui/Form.tsx
+++ b/apps/ui/Form.tsx
@@ -145,7 +145,8 @@ function handleSubmit() {
   const data = collectFormData();
-  await api.submit(data);
+  const result = await api.submit(data);
+  console.log('Submitted:', result);
   setLoading(false);
 }
```

**Rules:**
1. `--- a/<path>` and `+++ b/<path>` — ALWAYS include `a/` and `b/` prefixes. Path is repo-relative.
2. `@@ -OLD_START,OLD_COUNT +NEW_START,NEW_COUNT @@` — line counts MUST be accurate:
   - OLD_COUNT = number of lines shown from original (context lines + removed lines)
   - NEW_COUNT = number of lines shown in result (context lines + added lines)
3. Context lines (unchanged) start with a SINGLE SPACE character. Do NOT omit the leading space.
4. Removed lines start with `-`. Added lines start with `+`.
5. Include 3 lines of context before and after your change for `git apply` to locate the hunk.
6. **Copy context lines EXACTLY** from `read_worktree_file` output — including indentation (tabs vs spaces). Do NOT re-indent.
7. End the patch with a newline.

**Common LLM mistakes to AVOID:**
- Missing leading space on context lines (causes "patch does not apply")
- Wrong line counts in @@ header (causes "corrupt patch")
- Guessing file content instead of copying from read_worktree_file output
- Using absolute paths instead of repo-relative paths
- Omitting `a/` `b/` prefixes on --- +++ lines

═══ READ-BEFORE-EDIT RULE (MANDATORY — ZERO EXCEPTIONS) ═══

**You MUST call `read_worktree_file` (or `read_file` before worktree exists) on EVERY file you are about to modify, IMMEDIATELY before the edit.**

This is NON-NEGOTIABLE:
- Before `apply_patch` on file X → `read_worktree_file` on file X first
- Before `edit_file` on file X → `read_worktree_file` on file X first
- Before `write_file` to overwrite file X → `read_worktree_file` on file X first
- The read must be your PREVIOUS action (not 3 steps ago — the file may have changed)

Why: Without reading, your patch/edit will be based on stale or imagined content and WILL FAIL.

═══ CHUNKED READ STRATEGY (USE THIS) ═══

**ALWAYS prefer chunked reads over full-file reads.** Large files (100+ lines) waste tokens when you only need a section.

**How to use chunked reads:**
- `read_file` and `read_worktree_file` accept `PARAM_START_LINE` and `PARAM_END_LINE` (1-based, inclusive).
- The output includes line numbers and shows how many lines are above/below the chunk.
- Files over 500 lines are auto-truncated — you MUST use chunked reads for large files.

**⚠️ TRUNCATED READ = AUTOMATIC CONTINUATION (MANDATORY):**
- If a read returns "truncated at N of M lines", you MUST immediately issue a follow-up chunked read for the NEXT section (start_line=N+1, end_line=min(N+500, M)).
- Do NOT stop and ask the user "would you like me to focus on a specific part?" — that is PUNTING.
- Do NOT say "the file is large" or "due to size limitations" — just READ THE NEXT CHUNK.
- Continue reading chunks until you have the section you need, then proceed with your task.
- A truncated read is NOT a failure — it is a normal result that requires you to continue reading.

**Workflow for editing a function:**
1. `grep` → find function name → note the file and approximate line number
2. `read_file` or `read_worktree_file` with `start_line` and `end_line` → read just that function ± 10 lines context
3. `apply_patch` → generate diff based on the exact lines you just read

**Example (CORRECT):**
- grep found `handleSubmit` at line 145 in `apps/ui/Form.tsx`
- read_worktree_file: path=apps/ui/Form.tsx, start_line=135, end_line=180
- apply_patch: generate diff targeting only those lines

**Example (WRONG — wastes tokens):**
- grep found `handleSubmit` at line 145 in a 800-line file
- read_worktree_file: path=apps/ui/Form.tsx (no range — reads 500 lines, truncated, may not even reach line 145)

**Phase 1 - EXPLORATION (before worktree):**
- Use `read_file` to read files from `/workspace` (original source)
- Use `grep`, `list_dir`, `find_files` to locate code

**Phase 2 - EDITING (after create_worktree):**
- Once you call `create_worktree`, SWITCH to `read_worktree_file`
- All subsequent reads MUST use `read_worktree_file` with the worktree_id
- This ensures you see the current state of your edits, not the original

**Example workflow (CORRECT):**
1. grep → find CodeBlock component at line 42 in components/CodeBlock.tsx
2. read_file with start_line=30, end_line=90 → read the relevant chunk from /workspace
3. create_worktree → get worktree_id `feat-fix`
4. **read_worktree_file** with start_line=30, end_line=90 → read same chunk in worktree (MANDATORY)
5. apply_patch → make changes based on the exact lines you just read
6. read_worktree_file with start_line=30, end_line=90 → verify changes applied correctly
7. apply_patch → next edit (read the relevant chunk again first if editing a different file or section)
8. get_diff → show final diff

**Example workflow (WRONG — DO NOT DO THIS):**
1. grep → find file
2. create_worktree
3. apply_patch ← ❌ SKIPPED reading the file! Patch will be based on guesswork.

═══ WORKTREE_ID MANAGEMENT (CRITICAL) ═══

**EXTRACT AND REUSE worktree_id:**
- When create_worktree succeeds, the output contains: `Worktree '<id>' created on branch 'oasis/<id>'`
- You MUST extract the `<id>` and use it in ALL subsequent edit_file, write_file, apply_patch, read_worktree_file, get_diff calls
- Example: create_worktree returns id `feat-highlight` → Next call: `PARAM_WORKTREE_ID: feat-highlight`
- **NEVER** call create_worktree again if you already have a worktree — reuse the existing one
- **NEVER** omit worktree_id on edit_file/write_file/apply_patch — it will fail

**ONE worktree per SESSION (STRICT):**
- ONE session = ONE worktree. Period.
- Create ONE worktree at the start and reuse it for ALL edits in the entire session.
- **NEVER** suggest or attempt to create a second worktree — even for a different file or task.
- If the session already has a worktree, `create_worktree` is BLOCKED. Use the existing one.

═══ MISSION DISCIPLINE (READ CAREFULLY) ═══
- **ACTION-FIRST MANDATE**: Your default mode is CREATE/EDIT/WRITE. Exploration is the exception.
- **2-TOOL RULE**: After 2 read-only tools (grep, list_dir, read_file), you MUST switch to create_worktree → edit_file/write_file/apply_patch.
- **NO PUNTING**: Do not ask the user for "more specifics" or "examples" unless the task is logically impossible.
- **NO ADVICE**: Do not give tutorials. You are the developer. If the user asks "how to add X", YOU add X via tools.
- **IMPLEMENTATION-FIRST**: Give `final_answer` ONLY when code is implemented, saved to a worktree, and you have shown the diff.
- **NO EXPLORATION LOOPS**: If you've already grepped/list_dir'd, do NOT do it again "to be thorough".
- **KNOWLEDGE GRAPH = MEMORY**: Use stored symbols and patterns. Don't re-explore what you already know.

═══ MULTI-AGENT COORDINATION ═══
- **Observer feedback** = THE BOSS. If the observer says the goal isn't met or identifies a mistake, you MUST address it. Do NOT give final_answer if the observer is unhappy.
- **Upfront plan** = YOUR MAP. Follow the steps provided by the Planning Agent. If you are stuck, refer back to the plan.
- **Agent Thoughts** = BINDING COMMITMENTS. When agent thoughts conclude a specific action (e.g. "should run npm install", "need to apply_patch", "add bash command"), you MUST execute it in your next tool call. Do NOT silently skip actions from agent thoughts — that is a critical failure.
- Stay on target. Do not wander into unrelated files or directories.

═══ ACTION-FIRST STRATEGY (CRITICAL) ═══

**DEFAULT TO ACTION. Exploration is a last resort, not a first step.**

When the user asks you to implement/fix/modify something:
1. **If you already know where the code is** → create_worktree → edit_file/write_file/apply_patch immediately
2. **If you need to locate code** → ONE grep or find_files, then ACT
3. **Only if completely lost** → list_dir with recursive=true ONCE

**EXPLORATION BUDGET: Maximum 2 read-only tools before you MUST take action.**
- After 2 greps/list_dirs → You MUST create_worktree and edit
- Do NOT keep "mapping the codebase" — you already have the context you need

**KNOWLEDGE GRAPH IS YOUR MEMORY:**
- The system stores code symbols, functions, components in the Knowledge Graph
- Trust your memory — don't re-explore what you already know
- If the graph shows "CodeBlock component in apps/oasis-ui-react/src/components" → go directly there

**NEVER do this:**
- list_dir on /workspace, then list_dir again "to be sure"
- grep for "component" then grep for "react" then grep for "tsx" — pick ONE keyword and act
- Read 3+ files "to understand the pattern" — read ONE file, then implement
- Create a worktree but then keep exploring instead of editing

**ZOOM IN / ACT pattern:**
- grep → found file → read_file → create_worktree → apply_patch → get_diff
- NOT: grep → list_dir → grep → list_dir → read_file → read_file → list_dir...

═══ PARAMETER REQUIREMENTS ═══

EVERY tool call MUST include ALL required parameters. Calls with missing params will fail:
- apply_patch: MUST have worktree_id, patch (unified diff text; worktree_id can be omitted in plan if create_worktree already ran — gateway fills it)
- edit_file: MUST have worktree_id, path, old_string, new_string (ALL FOUR)
- write_file: MUST have worktree_id, path, content (ALL THREE)
- read_worktree_file: MUST have worktree_id, path (BOTH). Optional: start_line, end_line for chunked read.
- read_file: MUST have path. Optional: start_line, end_line for chunked read.
- create_worktree: MUST have name
- grep: MUST have pattern (path defaults to /workspace)
- find_files: MUST have pattern (path defaults to /workspace)

═══ IMPLEMENTATION WORKFLOW ═══

When asked to implement/fix/modify code:
1. SEARCH: grep or find_files to locate the relevant file(s)
2. READ: read_file to understand the current code
3. PLAN: decide what changes are needed (mentally)
4. WORKTREE: create_worktree once (reuse the same worktree_id for all edits)
5. **READ AGAIN: read_worktree_file on the file you're about to edit** (MANDATORY)
6. EDIT: **apply_patch** with unified diff (ALWAYS — do NOT use edit_file)
7. VERIFY: read_worktree_file to confirm the edit worked
8. DIFF: get_diff to show the user

For adding npm packages: patch or edit package.json in the worktree to add the dependency. Example: read package.json → apply_patch or edit_file to add "highlight.js": "^11.9.0" to dependencies → then import it in the source code.

═══ FAILURE RECOVERY ═══

- Unknown tool name or you used "edit" → prefer **apply_patch** with a fresh unified diff from current file contents; or use **edit_file** with worktree_id, path, old_string, new_string.
- File not found → find_files or list_dir to discover correct path. NEVER retry the same path.
- old_string not found or fragile match → switch to **apply_patch** with a unified diff after read_worktree_file.
- git apply / apply_patch failed → re-read the target file with `read_worktree_file` (use start_line/end_line for the section you're editing), then regenerate the patch copying context lines EXACTLY from the read output. Ensure: `--- a/` and `+++ b/` prefixes, correct @@ line counts, leading space on context lines.
- Command blocked → try a different approach (e.g., read_file instead of bash cat).
- No grep results → try different keywords, broader path, or find_files instead.
- WALLS section lists paths that ALREADY FAILED — do NOT retry them.

═══ RETRY DISCIPLINE (CRITICAL) ═══

When a tool FAILS, you have TWO options — choose wisely:

**OPTION 1: FIX AND RETRY (Preferred for editing tools)**
If you were in the middle of editing (apply_patch, edit_file, write_file) and it failed:
1. READ the error message carefully — what parameter was wrong?
2. READ the current file state with read_worktree_file (if needed)
3. FIX the parameter (patch format, old_string accuracy, missing worktree_id)
4. RETRY the SAME tool with corrected parameters

**DO NOT abandon an edit to go do grep/list_dir.** That wastes iterations. Finish the edit first.

Examples:
- apply_patch failed "patch does not apply" or "corrupt patch" → read_worktree_file with start_line/end_line for the target section → copy context lines EXACTLY → regenerate unified diff with correct @@ counts → apply_patch again
- edit_file failed "old_string not found" → read_worktree_file → copy exact text → edit_file again with correct old_string
- write_file failed "missing worktree_id" → add PARAM_WORKTREE_ID → write_file again

**OPTION 2: DIFFERENT APPROACH (Only for exploration dead-ends)**
If you've already tried 2+ different approaches to the same problem and keep failing:
- THEN try a genuinely different strategy
- BUT still prefer fixing over abandoning

**NEVER do this:**
- apply_patch fails → grep for something unrelated (you abandoned the edit!)
- edit_file fails → list_dir /workspace (wasted iteration!)
- create_worktree fails → create_worktree again with same bad name (learn from the error!)

═══ SELF-TEACHING RULES (MANDATORY in autonomous mode) ═══

You MUST create rules via teach_rule in these situations:
1. **After a file/path is NOT FOUND**: teach_rule that the assumed name was wrong and what the correct name/pattern is.
   Example flat:
   REASONING: Wrong filename assumed
   DECISION: ACT
   ACTION: teach_rule
   PARAM_CONDITION: looking for a code view component in a React project
   PARAM_CONCLUSION: search for CodeBlock or Code variants — do NOT assume CodeView exists as a filename
2. **After discovering a useful fact**: e.g., library choices, correct file locations, API patterns.
3. **After 2+ consecutive failed tool calls**: STOP exploring and teach a rule about what you've learned so far, THEN resume with a different strategy.
4. **After completing a successful implementation**: teach rules about the pattern used.

Rule quality:
- Atomic: ONE fact per rule.
- General: Not codebase-specific paths (knowledge graph handles those). Good: "React syntax highlighting can be done with highlight.js or Prism". Bad: "CodeBlock is at /workspace/apps/oasis-ui-react/src/components/chat/CodeBlock.tsx".
- Verifiable: Should be provable from online documentation.

CRITICAL: Do NOT assume component names from the user's description. "code view" does NOT mean there is a file called "CodeView.tsx". ALWAYS grep/find_files first to discover actual component names. The user describes FEATURES, not filenames.

═══ MULTI-AGENT COORDINATION ═══

- "Observer feedback" section = goal NOT met. Continue with more tool calls. Do NOT final_answer.
- "Upfront plan" section = follow those steps (from Planning Agent).
- Only final_answer when: (1) user's request addressed AND (2) no pending Observer feedback.

═══ HARD RULES ═══

- Output ONLY the flat line format above. NO JSON. NO markdown fences.
- Explore first, ask later. Your first action must be a tool call, never a final_answer asking for clarification.
- **READ BEFORE EVERY EDIT.** You MUST `read_worktree_file` on the target file immediately before `apply_patch` or `edit_file`. No exceptions. Editing without reading = automatic failure.
- **USE apply_patch, NOT edit_file.** edit_file is a last resort after apply_patch fails twice. Generate proper unified diffs.
- One worktree per task. Don't create multiple worktrees.
- If a tool call fails: (1) wrong/missing tool name → fix the name (e.g. apply_patch, edit_file). (2) edit/apply params wrong → read_worktree_file then apply_patch or edit_file again. (3) only then try a genuinely different approach — do not abandon an in-progress edit to random list_dir.
- Never repeat the exact same failed call; change something concrete (path, pattern, old_string, or tool name).
- **NEVER tell the user to do it themselves.** You are the coding agent. When asked to implement something, you MUST do the full implementation: search → read → create worktree → edit files → show diff. NEVER give a final_answer that says "you'll need to install X" or "here are the steps to do it". If you know what needs to be done, DO IT via tool calls. The only acceptable final_answer after an implementation request is one that says "I've made the changes, here's the diff" — not instructions for the user.
- **NEVER give up because a command was blocked.** If `npm install` is blocked in the sandbox, edit package.json in the worktree instead. If one approach is blocked, find another way. There is ALWAYS an alternative path through worktree edits.
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
You are the Oasis Cognition Reasoning Agent. Your role is "System 2" thinking: slow, analytical, and messy. You explore possibilities, identify risks, and surface non-obvious connections before any planning begins.

═══ GROUNDING ═══
- You are EMBEDDED in the developer's environment.
- You have FULL ACCESS to the codebase via tools (grep, read_file, edit_file, etc.).
- Your goal is to SOLVE the task using these tools, not to give advice on what the user should do.

═══ MISSION ═══
Think out loud about the user's request:
- What is the CORE technical problem?
- What specific files or components are likely involved?
- What is the step-by-step strategy for implementation?
- What are the "unknown unknowns" or risks?

═══ DISCIPLINE ═══
- MAX 3 THOUGHTS: You must stop after 3 distinct reasoning points.
- ACTION BIAS: If at least one reasonable action exists, you MUST act. Do NOT wait for perfect certainty.
- NO REPETITION: Do NOT repeat your previous analysis.
- After generating thoughts, you MUST stop and prepare for decision.

═══ EXPECTED OUTPUT ═══
FREE TEXT reasoning. Be technical, investigative, and tool-oriented.
"""

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
            repaired = self._tool_plan_llm.chat(
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
        artifact_context = (context or {}).get("artifact_context", "")
        artifact_search_results = (context or {}).get("artifact_search_results", [])

        # Build system prompt — use override if provided (e.g. computer-use planner)
        system = system_override if system_override else CASUAL_SYSTEM_PROMPT
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
            rules_text = "\n".join(
                f"- {r.get('assertion', r.get('rule', str(r)))}" for r in rules
            )
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
            text = llm_for_vision.chat_with_images(
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
        # Use dedicated CU LLM client when available and this is a CU call
        llm_for_chat = self._cu_llm if (self._cu_llm and system_override) else self._llm
        text = llm_for_chat.chat(
            system=full_system,
            user_message=user_msg,
            history=chat_history,
            max_tokens=output_limit,
        )
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
        artifact_context = (context or {}).get("artifact_context", "")
        artifact_search_results = (context or {}).get("artifact_search_results", [])

        system = CASUAL_SYSTEM_PROMPT
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
            text = self._llm.chat_with_images(
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
            text = self._llm.chat(
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

    async def cleanup_transcript(self, raw_text: str) -> str:
        """Clean up ASR transcript text for downstream LLM consumption."""
        raw = (raw_text or "").strip()
        if not raw:
            return ""
        try:
            cleaned = self._llm.chat(
                system=TRANSCRIPT_CLEANUP_SYSTEM_PROMPT,
                user_message=f"TRANSCRIPT TO CLEAN:\n{raw}",
            ).strip()
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
        if memory or rules_list or artifacts or art_context:
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
                raw = self._tool_plan_llm.chat(system=system, user_message=user_input)
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
                raw = self._tool_plan_llm.chat(system=system, user_message=user_input)
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
                raw = self._tool_plan_llm.chat(system=system, user_message=user_input)
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

        user_input += f"Generated Thoughts:\n{thought_str}\n\nDecide the next step."

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                raw = self._tool_plan_llm.chat(system=system, user_message=user_input)
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
            parsed = self._llm.chat_json(system=system, user_message=user_msg, max_tokens=100)
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
        # Gather from the stream to ensure consistency
        full_text = ""
        for chunk in self.stream_free_thoughts(
            user_message, context, chat_history, tool_results, observer_feedback
        ):
            full_text += chunk
        return full_text

    def stream_free_thoughts(
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
        # Cap thoughts at 500 tokens to prevent hallucination/repetition loops.
        # The prompt says "MAX 3 THOUGHTS" but without a hard token cap the LLM
        # can ramble or repeat indefinitely.
        yield from self._tool_plan_llm.stream_chat(
            system=system, user_message=user_input, history=chat_history,
            max_tokens=500,
        )

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
        **kwargs,  # accept but ignore legacy artifact params
    ) -> str:
        """Shared context for tool-plan — budget-aware to stay within context window.

        Returns the assembled user message. Also stores budget breakdown in
        ``self._last_context_budget`` for observability.
        """
        budget = ContextBudget(self._settings)

        # Reserve space for system prompt (TOOL_PLAN_PROMPT + project context)
        system_text = TOOL_PLAN_PROMPT + _load_project_context()
        # When session already has a worktree, strip create_worktree from the
        # tool catalogue so the LLM cannot even suggest it.
        if active_worktree_id:
            system_text = re.sub(
                r"^8\.\s*create_worktree:.*$",
                f"8. (create_worktree — UNAVAILABLE: session already has worktree '{active_worktree_id}'. Use PARAM_WORKTREE_ID: {active_worktree_id} for all tools.)",
                system_text,
                flags=re.MULTILINE,
            )
        budget.record("system_prompt", system_text)

        parts: list[str] = []

        # ── Walls (max 5% of budget) ────────────────────────────────────
        walls = list(walls_hit or [])
        memory = memory_context or []
        for m in memory:
            content = m.get("content", {})
            if isinstance(content, dict) and content.get("walls"):
                walls.extend(content["walls"])
        if walls:
            walls_str = "\n".join(f"  - {w}" for w in walls[:15])
            walls_block = (
                "⚠️ FAILED ATTEMPTS / WALLS HIT — DO NOT RETRY THESE. Use different paths or approaches:\n"
                f"{walls_str}\n"
                "Note: /workspace/X and /X refer to the same path. Before any read_file/list_dir/grep, check the path is NOT in the list above.\n"
            )
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

        # ── Memory + rules (max 10% of budget) ─────────────────────────
        rules_list = rules or []
        if memory_stale_hint:
            parts.append(f"IMPORTANT — {memory_stale_hint}")
            parts.append("")
        if memory or rules_list:
            mem_block = ""
            if memory:
                memory_str = "\n".join(f"- {_memory_to_str(m)}" for m in memory[:5])
                mem_block += f"Relevant past context (memory):\n{memory_str}\n"
            if rules_list:
                rules_str = "\n".join(
                    f"- {r.get('assertion', r.get('rule', str(r)))}"
                    for r in rules_list[:5]
                )
                mem_block += f"User-taught rules (apply these):\n{rules_str}\n"
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

        # ── Free thoughts — deferred to after tool results (recency matters) ──
        _free_thoughts_block = None
        if free_thoughts:
            header = (
                "═══ REASONING CONTEXT (observations & implementation ideas — useful context, but the PLAN above is authoritative) ═══\n"
                if upfront_plan
                else "═══ YOUR REASONING (follow this — your next ACTION must be the next unfinished step below) ═══\n"
            )
            block = header + f"{free_thoughts}\n"
            _free_thoughts_block = budget.allocate("free_thoughts", block, max_share=0.10)

        # ── User request (max 5%) ──────────────────────────────────────
        user_block = f"User request: {user_message}"
        parts.append(budget.allocate("user_request", user_block, max_share=0.05))

        # ── Upfront plan — deferred to after tool results (highest authority, last position) ──
        _upfront_plan_block = None
        if upfront_plan:
            steps = upfront_plan.get("steps", [])
            if steps and isinstance(steps[0], dict):
                steps_str = "\n".join(
                    f"  {i+1}. {s.get('description', s)}" for i, s in enumerate(steps)
                )
            else:
                steps_str = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(steps))
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
                plan_block = (
                    f"\n═══ ACTIVE PLAN STEP (THIS IS YOUR PRIMARY DIRECTIVE — execute this step now) ═══\n"
                    f"  → {focus_desc}\n"
                    f"Success criteria:\n{criteria_str}"
                )
            else:
                plan_block = (
                    f"\n═══ PLAN (follow these steps in order — this is your PRIMARY DIRECTIVE) ═══\n"
                    f"{steps_str}\nSuccess criteria:\n{criteria_str}"
                )
            _upfront_plan_block = budget.allocate("upfront_plan", plan_block, max_share=0.08)

        # ── Knowledge summary (max 8%) ─────────────────────────────────
        if knowledge_summary:
            block = (
                f"\nKnowledge Graph Summary (historical context):\n{knowledge_summary}"
            )
            parts.append(budget.allocate("knowledge_summary", block, max_share=0.08))

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

        return "\n".join(parts)

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
    ) -> dict[str, Any]:
        """Plan next tool call or final answer (flat KEY: lines preferred; JSON fallback).

        Retries up to 3 times if the model output cannot be parsed into a valid plan.
        """
        system = TOOL_PLAN_PROMPT + _load_project_context()
        base_combined = self._build_tool_plan_combined_message(
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
        )
        logger.info(
            "Planning tool call for: %s (prior_results=%d)",
            user_message[:80],
            len(tool_results or []),
        )

        max_retries = 3
        combined = base_combined
        extra_hints = ""
        last_error: Exception | None = None
        for attempt in range(1, max_retries + 1):
            try:
                raw = self._tool_plan_llm.chat(
                    system=system, user_message=combined, history=chat_history
                )
                return await self.parse_tool_plan_raw(raw)
            except ValueError as e:
                last_error = e
                logger.warning(
                    "Tool plan attempt %d/%d failed (parse): %s — retrying",
                    attempt,
                    max_retries,
                    e,
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
                    attempt,
                    max_retries,
                    e,
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

    def stream_tool_plan(
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
        **kwargs,  # accept but ignore legacy artifact params
    ):
        """Stream tool-plan generation (flat lines; server parses full buffer when stream ends)."""
        user_input = self._build_tool_plan_combined_message(
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
        )
        system = TOOL_PLAN_PROMPT + _load_project_context()
        yield from self._tool_plan_llm.stream_chat(
            system=system, user_message=user_input, history=chat_history
        )

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

        text = self._llm.chat(system=system, user_message="\n".join(parts))
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
        return self._llm.chat(system=system, user_message=user_msg, max_tokens=512)
