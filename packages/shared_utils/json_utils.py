"""Utilities for robustly extracting and parsing JSON from LLM outputs."""

import ast
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _repair_truncated_json(s: str) -> str:
    """Attempt to repair truncated or malformed JSON from LLM output."""
    s = s.strip()
    if not s:
        return "{}"
    open_braces = s.count("{") - s.count("}")
    open_brackets = s.count("[") - s.count("]")
    s = re.sub(r",\s*([}\]])", r"\1", s)  # Remove trailing commas
    s += "]" * open_brackets + "}" * open_braces
    return s


def _repair_loose_json_object(s: str) -> str:
    """Best-effort repair for common "near JSON" patterns.

    This is intentionally conservative; it only targets fixes that are
    frequently produced by LLMs and are safe for typical tool-plan objects:
    - trailing commas before } / ]
    - unquoted object keys (e.g. {action: call_tool})
    - simple single-quoted string values after a colon (e.g. {a: 'x'})
    """
    s = s.strip()
    if not s:
        return s

    # 1) Remove trailing commas.
    s = re.sub(r",\s*([}\]])", r"\1", s)

    # 2) Quote unquoted keys.
    #    Matches: { action: ...   , tool: ... , "worktree_id": ... (ignored)
    s = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', s)

    # 3) Convert simple single-quoted string values to double quotes.
    #    This avoids touching numbers/booleans and minimizes corruption of large strings.
    s = re.sub(r":\s*'([^'\\]*(?:\\.[^'\\]*)*)'", r':"\1"', s)

    # 4) Quote bareword string values (e.g. action: call_tool).
    #    Keeps JSON literals (true/false/null) unmodified.
    def _quote_bare_value(m: re.Match[str]) -> str:
        val = m.group(1)
        tail = m.group(2) or ""
        if val in ("true", "false", "null"):
            return f":{val}{tail}"
        return f':"{val}"{tail}'

    s = re.sub(r':\s*([A-Za-z_][A-Za-z0-9_-]*)(\s*[,}])', _quote_bare_value, s)

    # Another trailing-comma pass (in case quotes changes spacing).
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return s


def extract_json(text: str) -> Any:
    """Extract and parse the first JSON object or array found in the text.
    
    Handles:
    - Raw JSON
    - JSON inside markdown code blocks (```json ... ``` or ``` ... ```)
    - JSON surrounded by conversational text.
    
    Args:
        text: The raw string containing (hopefully) JSON.
        
    Returns:
        The parsed JSON object (dict or list).
        
    Raises:
        ValueError: If no valid JSON could be extracted or parsed.
    """
    text = text.strip()
    
    # 1. Try direct parsing
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Try extracting from markdown code blocks
    # This regex matches ``` (optional lang) JSON ```
    code_block_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if code_block_match:
        content = code_block_match.group(1).strip()
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            # If the block itself has extra data or is malformed, fall through to bracket search
            text = content 

    # 3. Search for the first '{' or '[' and extract to matching '}' or ']'
    brace_start = text.find("{")
    bracket_start = text.find("[")

    start_idx = -1
    end_idx = -1

    if brace_start != -1 and (bracket_start == -1 or brace_start < bracket_start):
        start_idx = brace_start
        # Find matching closing brace (handle nested braces)
        depth = 0
        for i, ch in enumerate(text[start_idx:], start_idx):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
        if end_idx == -1:
            end_idx = text.rfind("}")
    elif bracket_start != -1:
        start_idx = bracket_start
        end_idx = text.rfind("]")

    if start_idx != -1:
        content = text[start_idx : end_idx + 1] if end_idx > start_idx else text[start_idx:]
        # 4. Try parsing, then repair truncated/loose JSON
        candidates = [content, _repair_truncated_json(content)]
        candidates.append(_repair_loose_json_object(_repair_truncated_json(content)))
        for raw in candidates:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                continue

    # 5. Last resort: try ast.literal_eval for Python dict (single quotes)
    if start_idx != -1:
        try:
            obj = ast.literal_eval(content)
            if isinstance(obj, dict):
                return obj
        except (ValueError, SyntaxError):
            pass

    raise ValueError(f"Could not extract valid JSON from text: {text[:200]}...")
