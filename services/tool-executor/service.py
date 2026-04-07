"""Tool Executor: sandboxed command execution with security blacklist."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Security: blocked command patterns ────────────────────────────────────────
# These regex patterns match dangerous commands that must NEVER execute.
# The blacklist is applied to the raw command string before execution.
BLOCKED_PATTERNS: list[re.Pattern[str]] = [
    # Destructive system commands
    re.compile(r"\brm\s+-rf\s+/", re.IGNORECASE),
    re.compile(r"\brm\s+-rf\s+~", re.IGNORECASE),
    re.compile(r"\brm\s+-rf\s+\.\s*$", re.IGNORECASE),
    re.compile(r"\bmkfs\b", re.IGNORECASE),
    re.compile(r"\bdd\s+.*of=/dev/", re.IGNORECASE),
    re.compile(r"\b:()\s*\{", re.IGNORECASE),  # fork bomb
    # Privilege escalation
    re.compile(r"\bsudo\b", re.IGNORECASE),
    re.compile(r"\bsu\s+-?\s*$", re.IGNORECASE),
    re.compile(r"\bsu\s+root\b", re.IGNORECASE),
    re.compile(r"\bchmod\s+777\s+/", re.IGNORECASE),
    re.compile(r"\bchown\b.*\s+/", re.IGNORECASE),
    # Network exfiltration
    re.compile(r"\bcurl\b.*\|\s*sh", re.IGNORECASE),
    re.compile(r"\bcurl\b.*\|\s*bash", re.IGNORECASE),
    re.compile(r"\bwget\b.*\|\s*sh", re.IGNORECASE),
    re.compile(r"\bwget\b.*\|\s*bash", re.IGNORECASE),
    re.compile(r"\bnc\s+-[elp]", re.IGNORECASE),      # netcat reverse shell
    re.compile(r"\bncat\b", re.IGNORECASE),
    re.compile(r"\bsocat\b", re.IGNORECASE),
    # Credential / secret access
    re.compile(r"\bcat\s+.*\.env\b", re.IGNORECASE),
    re.compile(r"\bcat\s+.*/\.ssh/", re.IGNORECASE),
    re.compile(r"\bcat\s+.*/etc/shadow\b", re.IGNORECASE),
    re.compile(r"\bcat\s+.*/etc/passwd\b", re.IGNORECASE),
    re.compile(r"\bprintenv\b", re.IGNORECASE),
    re.compile(r"\benv\b\s*$", re.IGNORECASE),
    re.compile(r"\bexport\b", re.IGNORECASE),
    # Process / system manipulation
    re.compile(r"\bkill\s+-9\b", re.IGNORECASE),
    re.compile(r"\bkillall\b", re.IGNORECASE),
    re.compile(r"\bshutdown\b", re.IGNORECASE),
    re.compile(r"\breboot\b", re.IGNORECASE),
    re.compile(r"\bsystemctl\b", re.IGNORECASE),
    # Container / docker escape
    re.compile(r"\bdocker\b", re.IGNORECASE),
    re.compile(r"\bpodman\b", re.IGNORECASE),
    re.compile(r"\bkubectl\b", re.IGNORECASE),
    # Package management (don't let LLM install packages)
    re.compile(r"\bapt\b", re.IGNORECASE),
    re.compile(r"\bapt-get\b", re.IGNORECASE),
    re.compile(r"\byum\b", re.IGNORECASE),
    # pip and npm install are allowed — agent needs them for adding dependencies
    # re.compile(r"\bpip\s+install\b", re.IGNORECASE),
    # re.compile(r"\bnpm\s+install\b", re.IGNORECASE),
    # Dangerous shells / eval (but allow find -exec which is safe)
    re.compile(r"(?<!\-)\beval\b", re.IGNORECASE),
    re.compile(r"^\s*exec\b", re.IGNORECASE),
    re.compile(r"\bpython\s+-c\b", re.IGNORECASE),
    re.compile(r"\bnode\s+-e\b", re.IGNORECASE),
]

# Allowed base directories for file reads (configurable via env)
DEFAULT_ALLOWED_DIRS = ["/app", "/tmp"]

# Max output size to prevent memory issues
MAX_OUTPUT_BYTES = 50_000  # 50 KB
COMMAND_TIMEOUT_SECONDS = 30


def _get_allowed_dirs() -> list[str]:
    """Return allowed directories from env or defaults."""
    env_val = os.environ.get("TOOL_ALLOWED_DIRS", "")
    if env_val:
        return [d.strip() for d in env_val.split(",") if d.strip()]
    return DEFAULT_ALLOWED_DIRS


class ToolExecutorService:
    """Executes tools (bash commands, file reads) in a sandboxed environment."""

    def check_command_safety(self, command: str) -> tuple[bool, str]:
        """Check if a command is safe to execute.

        Returns (is_safe, reason).
        """
        for pattern in BLOCKED_PATTERNS:
            if pattern.search(command):
                return False, f"Blocked by security rule: {pattern.pattern}"
        return True, ""

    async def execute_command(self, command: str, working_dir: str | None = None) -> dict[str, Any]:
        """Execute a shell command in a sandboxed subprocess.

        Returns:
            {"success": bool, "stdout": str, "stderr": str, "exit_code": int, "blocked": bool, "reason": str}
        """
        is_safe, reason = self.check_command_safety(command)
        if not is_safe:
            logger.warning("BLOCKED command: %s — reason: %s", command, reason)
            return {
                "success": False,
                "stdout": "",
                "stderr": f"Command blocked: {reason}",
                "exit_code": -1,
                "blocked": True,
                "reason": reason,
            }

        cwd = working_dir or "/tmp"
        logger.info("Executing command: %s (cwd=%s)", command[:200], cwd)

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env={
                    **os.environ,
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "HOME": "/tmp",
                },
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=COMMAND_TIMEOUT_SECONDS
            )

            stdout = stdout_bytes.decode("utf-8", errors="replace")[:MAX_OUTPUT_BYTES]
            stderr = stderr_bytes.decode("utf-8", errors="replace")[:MAX_OUTPUT_BYTES]

            return {
                "success": proc.returncode == 0,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": proc.returncode or 0,
                "blocked": False,
                "reason": "",
            }
        except asyncio.TimeoutError:
            logger.warning("Command timed out after %ds: %s", COMMAND_TIMEOUT_SECONDS, command[:100])
            return {
                "success": False,
                "stdout": "",
                "stderr": f"Command timed out after {COMMAND_TIMEOUT_SECONDS}s",
                "exit_code": -1,
                "blocked": False,
                "reason": "timeout",
            }
        except Exception as e:
            logger.error("Command execution error: %s", e)
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
                "blocked": False,
                "reason": str(e),
            }

    async def read_file(
        self,
        path: str,
        max_lines: int = 500,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        """Read a file with directory restrictions.

        Args:
            path: File path to read.
            max_lines: Max lines when reading without range (default 500).
            start_line: 1-based start line (inclusive). If set, reads a chunk.
            end_line: 1-based end line (inclusive). If set with start_line, reads a range.

        Returns:
            {"success": bool, "content": str, "error": str, "blocked": bool, "total_lines": int}
        """
        resolved = Path(path).resolve()
        allowed = _get_allowed_dirs()

        # Check if path is under an allowed directory
        is_allowed = any(str(resolved).startswith(d) for d in allowed)
        if not is_allowed:
            logger.warning("BLOCKED file read: %s (not in allowed dirs: %s)", path, allowed)
            return {
                "success": False,
                "content": "",
                "error": f"File read blocked: path not in allowed directories ({', '.join(allowed)})",
                "blocked": True,
            }

        try:
            if not resolved.exists():
                return {"success": False, "content": "", "error": f"File not found: {path}", "blocked": False}
            if not resolved.is_file():
                return {"success": False, "content": "", "error": f"Not a file: {path}", "blocked": False}

            with open(resolved, "r", errors="replace") as f:
                all_lines = f.readlines()

            total_lines = len(all_lines)
            file_size_bytes = resolved.stat().st_size

            truncated_by_line_cap = False
            truncated_by_byte_cap = False
            source_line_start: int | None = None
            source_line_end: int | None = None
            next_chunk_start_line: int | None = None
            has_more_lines_below = False
            has_more_lines_above = False

            # Chunked read: start_line / end_line (1-based, inclusive)
            if start_line is not None:
                s = max(1, start_line) - 1  # convert to 0-based
                e = (end_line if end_line is not None else s + max_lines)
                e = min(e, total_lines)
                selected = all_lines[s:e]
                # Line numbers are metadata only — use │ separator so they're clearly NOT part of file content
                numbered = [f"{s + i + 1:>6} │ {ln}" for i, ln in enumerate(selected)]
                content = "".join(numbered)
                header = "(Line numbers are for reference only — do NOT include them in old_string, patches, or edits)\n"
                if s > 0:
                    header += f"... ({s} lines above)\n"
                content = header + content
                if e < total_lines:
                    content += f"\n... ({total_lines - e} more lines below)"
                if total_lines > 0:
                    source_line_start = s + 1
                    source_line_end = e
                has_more_lines_above = s > 0
                has_more_lines_below = e < total_lines
                if has_more_lines_below and source_line_end is not None:
                    next_chunk_start_line = source_line_end + 1
            else:
                # Full read with max_lines cap
                if total_lines > max_lines:
                    selected = all_lines[:max_lines]
                    content = "".join(selected)
                    content += f"\n... (truncated at {max_lines} of {total_lines} lines — use start_line/end_line to read specific sections)"
                    truncated_by_line_cap = True
                    source_line_start = 1
                    source_line_end = max_lines
                    next_chunk_start_line = max_lines + 1
                else:
                    content = "".join(all_lines)
                    if total_lines > 0:
                        source_line_start = 1
                        source_line_end = total_lines

            if len(content) > MAX_OUTPUT_BYTES:
                content = content[:MAX_OUTPUT_BYTES] + "\n... (truncated)"
                truncated_by_byte_cap = True

            read_metadata: dict[str, Any] = {
                "file_size_bytes": file_size_bytes,
                "returned_bytes": len(content.encode("utf-8")),
                "total_lines": total_lines,
                "truncated_by_line_cap": truncated_by_line_cap,
                "truncated_by_byte_cap": truncated_by_byte_cap,
                "source_line_start": source_line_start,
                "source_line_end": source_line_end,
                "next_chunk_start_line": next_chunk_start_line,
                "has_more_lines_below": has_more_lines_below,
                "has_more_lines_above": has_more_lines_above,
            }

            return {
                "success": True,
                "content": content,
                "error": "",
                "blocked": False,
                "total_lines": total_lines,
                "read_metadata": read_metadata,
            }
        except Exception as e:
            return {"success": False, "content": "", "error": str(e), "blocked": False}

    async def browse_url(self, url: str, screenshot: bool = True, extract_text: bool = True) -> dict[str, Any]:
        """Open a URL in a headless browser, capture screenshot + extract text.

        Returns:
            {"success": bool, "text": str, "screenshot_b64": str, "error": str, "blocked": bool}
        """
        # Basic URL validation
        if not url.startswith(("http://", "https://")):
            return {"success": False, "text": "", "screenshot_b64": "", "error": "URL must start with http:// or https://", "blocked": False}

        # Block internal/private URLs
        import urllib.parse
        parsed = urllib.parse.urlparse(url)
        hostname = parsed.hostname or ""
        blocked_hosts = ["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "169.254.169.254"]
        if hostname in blocked_hosts or hostname.startswith("10.") or hostname.startswith("172.") or hostname.startswith("192.168."):
            return {"success": False, "text": "", "screenshot_b64": "", "error": f"Blocked: cannot access internal/private URL ({hostname})", "blocked": True}

        logger.info("Browsing URL: %s (screenshot=%s, text=%s)", url, screenshot, extract_text)

        try:
            from playwright.async_api import async_playwright
            import base64

            async with async_playwright() as p:
                browser = await p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
                )
                context = await browser.new_context(
                    viewport={"width": 1280, "height": 900},
                    user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                )
                page = await context.new_page()

                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                    # Wait a bit for dynamic content
                    await page.wait_for_timeout(2000)
                except Exception as nav_err:
                    await browser.close()
                    return {"success": False, "text": "", "screenshot_b64": "", "error": f"Navigation failed: {nav_err}", "blocked": False}

                result_text = ""
                result_screenshot = ""

                if extract_text:
                    # Get page title + text content
                    title = await page.title()
                    # Extract readable text, strip excessive whitespace
                    text_content = await page.evaluate("""() => {
                        // Remove script/style elements
                        const scripts = document.querySelectorAll('script, style, noscript');
                        scripts.forEach(s => s.remove());
                        return document.body ? document.body.innerText : '';
                    }""")
                    # Clean and truncate
                    lines = [l.strip() for l in (text_content or "").split("\n") if l.strip()]
                    cleaned = "\n".join(lines)
                    if len(cleaned) > MAX_OUTPUT_BYTES:
                        cleaned = cleaned[:MAX_OUTPUT_BYTES] + "\n... (truncated)"
                    result_text = f"Title: {title}\n\n{cleaned}"

                if screenshot:
                    screenshot_bytes = await page.screenshot(type="jpeg", quality=80, full_page=False)
                    result_screenshot = base64.b64encode(screenshot_bytes).decode("ascii")
                    logger.info("Screenshot captured: %d KB", len(result_screenshot) // 1024)

                await browser.close()

                return {
                    "success": True,
                    "text": result_text,
                    "screenshot_b64": result_screenshot,
                    "error": "",
                    "blocked": False,
                }

        except ImportError:
            return {"success": False, "text": "", "screenshot_b64": "", "error": "Playwright not installed", "blocked": False}
        except Exception as e:
            logger.error("Browse error: %s", e)
            return {"success": False, "text": "", "screenshot_b64": "", "error": str(e), "blocked": False}

    def _expand_pattern_semantic(self, pattern: str) -> str:
        """Expand a pattern into regex alternation for common naming variants (semantic search).

        E.g. "CodeView" -> (CodeView|codeview|code_view|code-view|code view)
        Handles multi-word: "syntax highlighting" -> (syntax.highlighting|syntax_highlighting|...)
        Skips expansion when pattern looks like a regex (\\s, \\d, +, *, etc.).
        """
        pattern = pattern.strip()
        if not pattern or len(pattern) > 200:
            return re.escape(pattern)

        # If already looks like regex, use as-is
        if re.search(r"\\[sdwnrtDWS]|[*+?]{1,2}|\[.*\]|\|", pattern):
            return pattern

        # Split on spaces, hyphens, underscores to get tokens
        tokens = re.split(r"[\s\-_]+", pattern)
        if not tokens:
            return re.escape(pattern)

        # For each token, generate common code naming variants
        def variants(tok: str) -> list[str]:
            if not tok or not tok.isalnum():
                return [re.escape(tok)]
            low = tok.lower()
            cap = tok.capitalize() if len(tok) > 1 else tok[0].upper() + tok[1:].lower()
            result = [re.escape(tok), re.escape(low), re.escape(cap)]
            # CamelCase -> snake_case, kebab-case (e.g. CodeView -> code_view, code-view)
            if len(tok) > 1 and any(c.isupper() for c in tok[1:]):
                parts = re.sub(r"([A-Z])", r" \1", tok).strip().split()
                snake = "_".join(p.lower() for p in parts)
                kebab = "-".join(p.lower() for p in parts)
                result.extend([re.escape(snake), re.escape(kebab)])
            return list(dict.fromkeys(result))

        # Build alternation for the whole pattern
        if len(tokens) == 1:
            alts = list(dict.fromkeys(variants(tokens[0])))
            return "(" + "|".join(alts) + ")" if len(alts) > 1 else alts[0]

        # Multi-word: try "WordWord", "word_word", "word-word", "word word"
        combined = "".join(t.capitalize() for t in tokens)
        snake = "_".join(t.lower() for t in tokens)
        kebab = "-".join(t.lower() for t in tokens)
        spaced = " ".join(tokens)
        dotted = ".".join(t.lower() for t in tokens)
        alts = list(dict.fromkeys([
            re.escape(combined), re.escape(snake), re.escape(kebab),
            re.escape(spaced), re.escape(dotted),
        ] + [re.escape(t) for t in tokens]))
        return "(" + "|".join(alts) + ")"

    async def grep(self, pattern: str, path: str = "/workspace") -> dict[str, Any]:
        """Search for a pattern in files recursively. Uses ripgrep (rg) when available for speed.
        Expands pattern into semantic variants (CodeView -> codeview|code_view|...) for robustness.

        Returns:
            {"success": bool, "output": str, "error": str, "blocked": bool}
        """
        resolved = Path(path).resolve()
        allowed = _get_allowed_dirs()
        is_allowed = any(str(resolved).startswith(d) for d in allowed)
        if not is_allowed:
            logger.warning("BLOCKED grep: path %s not in allowed dirs: %s", path, allowed)
            return {
                "success": False,
                "output": "",
                "error": f"Grep blocked: path not in allowed directories ({', '.join(allowed)})",
                "blocked": True,
            }

        if not pattern or not pattern.strip():
            return {"success": False, "output": "", "error": "No pattern provided", "blocked": False}

        if not resolved.exists():
            return {"success": False, "output": "", "error": f"Path does not exist: {path}", "blocked": False}

        # Semantic expansion: try variants for better recall
        expanded = self._expand_pattern_semantic(pattern)
        # Exclude common non-source dirs to speed up and reduce noise
        exclude = ["node_modules", ".git", "__pycache__", ".next", "dist", "build", ".venv", "venv"]
        glob_args = [arg for d in exclude for arg in ("-g", f"!{d}")]

        async def run_rg(regex: str, case_insensitive: bool = False) -> tuple[int, str]:
            args = [
                "rg",
                "-n",
                "--max-filesize=1M",
                *glob_args,
                regex,
                str(resolved),
            ]
            if case_insensitive:
                args.insert(1, "-i")
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd="/tmp",
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=COMMAND_TIMEOUT_SECONDS
            )
            out = (stdout_bytes + stderr_bytes).decode("utf-8", errors="replace").strip()
            return proc.returncode, out

        async def run_grep(regex: str, case_insensitive: bool = False) -> tuple[int, str]:
            args = ["grep", "-rn", "-E", regex, str(resolved)]
            if case_insensitive:
                args.insert(2, "-i")
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd="/tmp",
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=COMMAND_TIMEOUT_SECONDS
            )
            out = (stdout_bytes + stderr_bytes).decode("utf-8", errors="replace").strip()
            return proc.returncode, out

        logger.info("Grep pattern=%s (expanded=%s) path=%s", pattern[:60], expanded[:80], path)

        try:
            # Prefer ripgrep; fall back to grep
            run_search = run_rg
            try:
                proc = await asyncio.create_subprocess_exec("rg", "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                await proc.wait()
                if proc.returncode != 0:
                    run_search = run_grep
            except FileNotFoundError:
                run_search = run_grep

            code, output = await run_search(expanded)
            # 0=matches, 1=no matches, 2=error
            if code == 0:
                if len(output) > MAX_OUTPUT_BYTES:
                    output = output[:MAX_OUTPUT_BYTES] + "\n... (truncated)"
                return {"success": True, "output": output, "error": "", "blocked": False}

            # No matches — try case-insensitive before giving up
            if code == 1 and not output.strip():
                code2, output2 = await run_search(expanded, case_insensitive=True)
                if code2 == 0:
                    if len(output2) > MAX_OUTPUT_BYTES:
                        output2 = output2[:MAX_OUTPUT_BYTES] + "\n... (truncated)"
                    return {"success": True, "output": output2, "error": "", "blocked": False}

            if len(output) > MAX_OUTPUT_BYTES:
                output = output[:MAX_OUTPUT_BYTES] + "\n... (truncated)"
            return {
                "success": code in (0, 1),
                "output": output,
                "error": "" if code in (0, 1) else output,
                "blocked": False,
            }
        except asyncio.TimeoutError:
            return {"success": False, "output": "", "error": f"Grep timed out after {COMMAND_TIMEOUT_SECONDS}s", "blocked": False}
        except Exception as e:
            return {"success": False, "output": "", "error": str(e), "blocked": False}

    async def list_directory(self, path: str, recursive: bool = False, max_depth: int = 4) -> dict[str, Any]:
        """List files in a directory, optionally recursively.

        No directory restriction — the container itself is the sandbox boundary.
        The project is mounted at /workspace (read-only) for inspection.

        Args:
            path: Directory path to list.
            recursive: If True, list recursively up to max_depth levels.
            max_depth: Maximum depth for recursive listing (default 4).

        Returns:
            {"success": bool, "entries": list[str], "error": str, "blocked": bool}
        """
        resolved = Path(path).resolve()

        try:
            if not resolved.is_dir():
                return {"success": False, "entries": [], "error": f"Not a directory: {path}", "blocked": False}

            if not recursive:
                entries = sorted(str(e.name) + ("/" if e.is_dir() else "") for e in resolved.iterdir())
                return {"success": True, "entries": entries[:500], "error": "", "blocked": False}

            # Recursive listing with tree-like output
            skip_dirs = {
                "node_modules", ".git", "__pycache__", ".next", "dist", "build",
                ".venv", "venv", ".pytest_cache", ".oasis-worktrees",
            }
            entries: list[str] = []
            max_entries = 1000

            def _walk(dirpath: Path, depth: int, prefix: str = "") -> None:
                if depth > max_depth or len(entries) >= max_entries:
                    return
                try:
                    children = sorted(dirpath.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
                except PermissionError:
                    return
                for child in children:
                    if child.name.startswith(".") and child.name not in (".env.example",):
                        if child.is_dir():
                            continue  # skip hidden dirs
                    rel = str(child.relative_to(resolved))
                    if child.is_dir():
                        if child.name in skip_dirs:
                            continue
                        entries.append(rel + "/")
                        _walk(child, depth + 1, rel + "/")
                    else:
                        entries.append(rel)
                    if len(entries) >= max_entries:
                        return

            _walk(resolved, 1)
            if len(entries) >= max_entries:
                entries.append(f"... (truncated at {max_entries} entries)")
            return {"success": True, "entries": entries, "error": "", "blocked": False}
        except PermissionError:
            return {"success": False, "entries": [], "error": f"Permission denied: {path}", "blocked": False}
        except Exception as e:
            return {"success": False, "entries": [], "error": str(e), "blocked": False}

    async def find_files(self, pattern: str, path: str = "/workspace", file_type: str | None = None) -> dict[str, Any]:
        """Find files matching a glob or name pattern recursively.

        A much more efficient way to locate files than repeated list_dir calls.
        Uses 'find' command with smart filtering.

        Args:
            pattern: Glob pattern (e.g. "*.tsx", "CodeBlock*", "**/chat/*.tsx")
                     or partial filename to search for.
            path: Root directory to search from.
            file_type: Optional filter: "file", "dir", or None for both.

        Returns:
            {"success": bool, "output": str, "error": str, "blocked": bool}
        """
        resolved = Path(path).resolve()
        if not resolved.exists():
            return {"success": False, "output": "", "error": f"Path not found: {path}", "blocked": False}

        # Build find command with exclusions
        excludes = [
            "node_modules", ".git", "__pycache__", ".next", "dist", "build",
            ".venv", "venv", ".pytest_cache", ".oasis-worktrees",
        ]
        prune_args = " -o ".join(f'-name "{d}" -prune' for d in excludes)

        type_flag = ""
        if file_type == "file":
            type_flag = "-type f"
        elif file_type == "dir":
            type_flag = "-type d"

        # Support both glob and name patterns
        if "/" in pattern or "**" in pattern:
            # Glob-style: use -path
            name_filter = f'-path "*{pattern}"'
        else:
            # Simple name match: use -iname for case-insensitive
            name_filter = f'-iname "*{pattern}*"'

        cmd = f'find {resolved} \\( {prune_args} \\) -prune -o {type_flag} {name_filter} -print 2>/dev/null | head -100'

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd="/tmp",
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=COMMAND_TIMEOUT_SECONDS
            )
            output = stdout_bytes.decode("utf-8", errors="replace").strip()

            if not output:
                return {"success": True, "output": f"No files found matching '{pattern}' in {path}", "error": "", "blocked": False}

            # Make paths relative to search root for readability
            lines = output.split("\n")
            rel_lines = []
            for line in lines:
                line = line.strip()
                if line.startswith(str(resolved)):
                    line = line[len(str(resolved)):].lstrip("/")
                rel_lines.append(line)

            return {"success": True, "output": "\n".join(rel_lines), "error": "", "blocked": False}
        except asyncio.TimeoutError:
            return {"success": False, "output": "", "error": f"Find timed out after {COMMAND_TIMEOUT_SECONDS}s", "blocked": False}
        except Exception as e:
            return {"success": False, "output": "", "error": str(e), "blocked": False}
