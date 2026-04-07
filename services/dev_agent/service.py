"""Dev Agent: git worktree-based code editing service.

Runs NATIVELY on the host (not in Docker) so it has full git + filesystem access.
Uses git worktrees to isolate agent-made changes from the user's working tree.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

OASIS_CONFIG_DIR = Path.home() / ".oasis"
PROJECT_CONFIG_PATH = OASIS_CONFIG_DIR / "project-config.json"
PROJECTS_DIR = OASIS_CONFIG_DIR / "projects"
ACTIVE_PROJECT_PATH = OASIS_CONFIG_DIR / "active-project.json"

IGNORED_DIRS = {
    "node_modules", ".git", "__pycache__", "dist", "build", ".next",
    "venv", ".venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "target", "vendor", ".gradle", ".idea", ".vscode", "coverage",
    ".turbo", ".cache", ".parcel-cache", "out", ".output",
}

# Maps config file → tech stack label
TECH_STACK_FILES: dict[str, str] = {
    "package.json": "Node.js",
    "requirements.txt": "Python",
    "pyproject.toml": "Python",
    "setup.py": "Python",
    "Pipfile": "Python",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "pom.xml": "Java (Maven)",
    "build.gradle": "Java (Gradle)",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pubspec.yaml": "Dart/Flutter",
    "Package.swift": "Swift",
    "Makefile": "Make",
    "Dockerfile": "Docker",
    "docker-compose.yml": "Docker Compose",
    "docker-compose.yaml": "Docker Compose",
    "tsconfig.json": "TypeScript",
    ".eslintrc.json": "ESLint",
    ".eslintrc.js": "ESLint",
    "tailwind.config.js": "Tailwind CSS",
    "tailwind.config.ts": "Tailwind CSS",
    "vite.config.ts": "Vite",
    "vite.config.js": "Vite",
    "next.config.js": "Next.js",
    "next.config.mjs": "Next.js",
    "nest-cli.json": "NestJS",
}

# Maps dependency name → framework label
FRAMEWORK_DETECTORS: dict[str, str] = {
    "react": "React",
    "react-dom": "React",
    "next": "Next.js",
    "@nestjs/core": "NestJS",
    "express": "Express",
    "vue": "Vue.js",
    "nuxt": "Nuxt.js",
    "@angular/core": "Angular",
    "svelte": "Svelte",
    "fastapi": "FastAPI",
    "django": "Django",
    "flask": "Flask",
    "fastify": "Fastify",
    "tailwindcss": "Tailwind CSS",
    "prisma": "Prisma",
    "typeorm": "TypeORM",
    "sequelize": "Sequelize",
    "sqlalchemy": "SQLAlchemy",
    "livekit-client": "LiveKit",
    "framer-motion": "Framer Motion",
}

PROJECT_ROOT = os.getenv("PROJECT_ROOT", os.getcwd())


def _get_worktree_dir() -> str:
    """Return the worktree directory based on the *current* PROJECT_ROOT.

    This must be a function (not a module-level constant) because
    PROJECT_ROOT is updated at runtime when the user switches projects.
    """
    return os.path.join(PROJECT_ROOT, ".oasis-worktrees")


def set_project_root(new_root: str) -> None:
    """Update the module-level PROJECT_ROOT and log the change.

    Called by main.py whenever the active project changes so that
    service.py methods (worktree creation, bash cwd, etc.) use the
    correct path.
    """
    global PROJECT_ROOT
    PROJECT_ROOT = new_root
    os.environ["PROJECT_ROOT"] = new_root
    logger.info("service.py PROJECT_ROOT updated → %s", new_root)

# Host shell (bash) — long default so `npm install` can finish; override with DEV_AGENT_BASH_TIMEOUT_SECONDS
DEV_AGENT_BASH_TIMEOUT_SECONDS = int(os.getenv("DEV_AGENT_BASH_TIMEOUT_SECONDS", "600"))
DEV_AGENT_BASH_MAX_OUTPUT_BYTES = int(os.getenv("DEV_AGENT_BASH_MAX_OUTPUT_BYTES", "500000"))

# Safety: never allow writes outside the worktree
BLOCKED_PATH_SEGMENTS = ["..", ".git", ".env", "node_modules"]

# Worktree folder + git branch segment (oasis/<id>); keep strict to avoid path escape and broken refs.
_WORKTREE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$")


def _validate_worktree_name(worktree_id: str) -> tuple[bool, str]:
    if not worktree_id:
        return False, "Worktree name is empty"
    if ".." in worktree_id or "/" in worktree_id or "\\" in worktree_id:
        return False, "Invalid worktree name: no slashes or '..'"
    if not _WORKTREE_NAME_RE.match(worktree_id):
        return (
            False,
            "Invalid worktree name: use letters, numbers, dots, hyphens, underscores only (max 121 chars, "
            "must start with alphanumeric)",
        )
    return True, ""


_CANDIDATE_FILE_EXTS: tuple[str, ...] = (
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".vue",
    ".svelte",
    ".py",
    ".md",
    ".css",
    ".scss",
)


class DevAgentService:
    """Manages git worktrees for safe, isolated code editing."""

    def __init__(self):
        os.makedirs(_get_worktree_dir(), exist_ok=True)
        # Ensure .oasis-worktrees is in .gitignore
        gitignore = os.path.join(PROJECT_ROOT, ".gitignore")
        try:
            if os.path.exists(gitignore):
                content = open(gitignore).read()
                if ".oasis-worktrees" not in content:
                    with open(gitignore, "a") as f:
                        f.write("\n# Dev agent worktrees\n.oasis-worktrees/\n")
            else:
                with open(gitignore, "w") as f:
                    f.write("# Dev agent worktrees\n.oasis-worktrees/\n")
        except Exception as e:
            logger.warning("Could not update .gitignore: %s", e)

    def _validate_path(self, relative_path: str) -> tuple[bool, str]:
        """Validate a file path is safe (no traversal, no sensitive files)."""
        for segment in BLOCKED_PATH_SEGMENTS:
            if segment in relative_path.split(os.sep):
                return False, f"Path contains blocked segment: {segment}"
        if os.path.isabs(relative_path):
            return False, "Path must be relative"
        return True, ""

    def _worktree_path(self, worktree_id: str) -> Path:
        return Path(_get_worktree_dir()) / worktree_id

    def _resolve_existing_under_worktree(self, wt_path: Path, path: str) -> tuple[Path | None, str]:
        """Map a repo-relative path to an existing file inside the worktree.

        Handles trailing ``.`` and missing extensions (e.g. ``CodeBlock.`` → ``CodeBlock.tsx``).
        """
        from pathlib import PurePosixPath

        raw = path.replace("\\", "/").strip().lstrip("/")
        if not raw:
            return None, path
        if raw.endswith(".") and not raw.endswith(".."):
            raw = raw[:-1]
        candidates: list[str] = []
        seen: set[str] = set()

        def add(rel: str) -> None:
            r = rel.strip().lstrip("/")
            if not r or r in seen:
                return
            seen.add(r)
            candidates.append(r)

        add(raw)
        pp = PurePosixPath(raw)
        if not pp.suffix:
            stem = pp.name
            parent_s = pp.parent.as_posix() if str(pp.parent) != "." else ""
            for ext in _CANDIDATE_FILE_EXTS:
                rel = f"{parent_s}/{stem}{ext}" if parent_s else f"{stem}{ext}"
                add(rel)
        for rel in candidates:
            full = wt_path / rel
            if full.is_file():
                return full, rel
        return None, raw

    async def _run_git(
        self, *args: str, cwd: str | None = None, timeout: float = 30
    ) -> tuple[int, str, str]:
        """Run a git command and return (returncode, stdout, stderr)."""
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or PROJECT_ROOT,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            proc.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    @staticmethod
    def _normalize_repo_relative_path(path: str) -> str:
        """Align paths with read_file/gateway: strip /workspace, ./, leading slashes, trailing lone dot."""
        s = (path or "").replace("\\", "/").strip()
        if s.startswith("/workspace/"):
            s = s[len("/workspace/") :]
        elif s == "/workspace":
            s = ""
        s = s.lstrip("./").lstrip("/")
        if s.endswith(".") and not s.endswith(".."):
            s = s[:-1]
        return s

    @staticmethod
    def _strip_patch_fences(text: str) -> str:
        """Remove optional ```diff fences; keep patch otherwise intact (git apply needs a trailing newline)."""
        raw = text or ""
        head = raw.lstrip()
        if not head.startswith("```"):
            out = raw.rstrip("\r\n")
            if out and not out.endswith("\n"):
                out += "\n"
            return out
        lines = raw.split("\n")
        if lines and lines[0].lstrip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        joined = "\n".join(lines).strip()
        if joined and not joined.endswith("\n"):
            joined += "\n"
        return joined

    @staticmethod
    def _strip_line_number_prefixes(patch: str) -> str:
        """Strip line-number prefixes that the agent may have copied from numbered read output.

        Detects patterns like '  135 │ code' or '135: code' on context/add/remove lines
        and removes the number prefix, preserving the diff marker (+/-/space).
        Only applies when a significant fraction of hunk body lines have the prefix pattern.
        """
        import re
        # Pattern: optional diff marker (+/-/space), then digits + separator (│ | :), then content
        line_num_re = re.compile(r'^([+ -]?)\s*\d+\s*[│|:]\s?(.*)$')

        lines = patch.split('\n')
        # Check if this patch has line-number contamination
        # Only look at hunk body lines (not headers like diff, ---, +++, @@)
        body_lines = [
            l for l in lines
            if l and not l.startswith('diff ') and not l.startswith('--- ')
            and not l.startswith('+++ ') and not l.startswith('@@')
            and not l.startswith('\\')
        ]
        if not body_lines:
            return patch

        matches = sum(1 for l in body_lines if line_num_re.match(l))
        # If more than 60% of body lines have line-number prefixes, strip them
        if matches / len(body_lines) < 0.6:
            return patch

        result: list[str] = []
        for line in lines:
            # Don't touch headers
            if (line.startswith('diff ') or line.startswith('--- ') or
                    line.startswith('+++ ') or line.startswith('@@') or
                    line.startswith('\\')):
                result.append(line)
                continue
            m = line_num_re.match(line)
            if m:
                marker = m.group(1) or ' '  # default to context line (space)
                content = m.group(2)
                result.append(marker + content)
            else:
                result.append(line)

        logger.info("apply_patch: stripped line-number prefixes from patch (%d lines affected)", matches)
        return '\n'.join(result)

    def _validate_patch_paths(self, patch: str) -> tuple[bool, str]:
        # Only validate --- / +++ lines that are actual file headers (before @@
        # hunks), not diff content lines that happen to start with --- or +++.
        in_header = True  # start in header mode (before first @@ hunk)
        for line in patch.splitlines():
            if line.startswith("@@"):
                in_header = False
                continue
            if line.startswith("diff --git"):
                in_header = True  # new file section — back to header mode
                continue
            if not in_header:
                continue  # skip content lines inside hunks
            if not (line.startswith("--- ") or line.startswith("+++ ")):
                continue
            part = line[4:].strip()
            if "\t" in part:
                part = part.split("\t", 1)[0].strip()
            low = part.lower()
            if low in ("/dev/null", "nul", "null"):
                continue
            if part.startswith("a/") or part.startswith("b/"):
                part = part[2:]
            norm = part.replace("\\", "/")
            if norm.startswith("/"):
                return False, f"Patch must use repo-relative paths, not absolute: {part!r}"
            if ".." in norm.split("/"):
                return False, f"Unsafe path in patch (no '..'): {part!r}"
        return True, ""

    def _convert_absolute_paths_to_relative(self, patch: str) -> str:
        """Convert absolute paths in patch headers to repo-relative paths.

        Handles paths like /workspace/apps/foo.tsx -> apps/foo.tsx
        Only processes file header lines (before @@ hunks), not content lines.
        """
        lines = []
        in_header = True
        for line in patch.splitlines():
            if line.startswith("@@"):
                in_header = False
            elif line.startswith("diff --git"):
                in_header = True
            if in_header and (line.startswith("--- ") or line.startswith("+++ ")):
                prefix = line[:4]
                rest = line[4:].strip()
                
                # Handle tab-separated filename + timestamp
                timestamp = ""
                if "\t" in rest:
                    parts = rest.split("\t", 1)
                    filename = parts[0].strip()
                    timestamp = "\t" + parts[1] if len(parts) > 1 else ""
                else:
                    filename = rest
                    
                # Skip special markers
                low = filename.lower()
                if low in ("/dev/null", "nul", "null"):
                    lines.append(line)
                    continue
                    
                # Strip a/ or b/ prefix if present
                if filename.startswith("a/") or filename.startswith("b/"):
                    filename = filename[2:]
                    
                # Convert absolute to relative
                norm = filename.replace("\\", "/")
                if norm.startswith("/workspace/"):
                    norm = norm[len("/workspace/"):]
                elif norm.startswith("/"):
                    # Remove leading slash
                    norm = norm[1:]
                    
                lines.append(f"{prefix}{norm}{timestamp}")
            else:
                lines.append(line)
        return "\n".join(lines)

    @staticmethod
    def _repair_patch_headers(patch: str) -> str:
        """Fix common LLM patch issues: missing --- / +++ headers, or bare @@ hunks.

        If a patch starts with ``@@ ...`` without preceding ``---`` / ``+++``
        lines, try to infer the file path from a preceding ``diff --git`` line
        or from context, and insert the missing headers so ``git apply`` works.
        """
        lines = patch.splitlines()
        if not lines:
            return patch

        out: list[str] = []
        i = 0
        while i < len(lines):
            line = lines[i]

            # Case 1: `@@ ... @@` hunk without preceding ---/+++ headers
            if line.startswith("@@") and not line.startswith("@@@"):
                # Check if we already have proper headers
                has_header = False
                for j in range(max(0, len(out) - 3), len(out)):
                    if out[j].startswith("--- ") or out[j].startswith("+++ "):
                        has_header = True
                        break

                if not has_header:
                    # Try to find path from a preceding diff --git line
                    filepath = None
                    for j in range(len(out) - 1, -1, -1):
                        if out[j].startswith("diff --git"):
                            # diff --git a/path b/path
                            parts = out[j].split()
                            if len(parts) >= 4:
                                fp = parts[2]
                                if fp.startswith("a/"):
                                    fp = fp[2:]
                                filepath = fp
                            break

                    if filepath:
                        out.append(f"--- a/{filepath}")
                        out.append(f"+++ b/{filepath}")
                    else:
                        # No diff --git header either — look for path hints in the
                        # hunk lines (common pattern: LLM outputs filepath as comment)
                        # or in PARAM_PATH that might precede the patch.
                        # As last resort, use a placeholder that git apply might still handle
                        # by scanning earlier lines for anything path-like.
                        candidate = None
                        for j in range(len(out) - 1, max(len(out) - 5, -1), -1):
                            stripped = out[j].strip()
                            if "/" in stripped and not stripped.startswith("#") and len(stripped) < 200:
                                # Looks like a file path
                                candidate = stripped.lstrip("# ").strip()
                                break
                        if candidate:
                            out.append(f"--- a/{candidate}")
                            out.append(f"+++ b/{candidate}")

            out.append(line)
            i += 1

        return "\n".join(out)

    @staticmethod
    def _normalize_patch_prefixes(patch: str) -> str:
        """Ensure --- / +++ lines have a/ b/ prefixes that git apply expects.

        LLMs often output `--- apps/foo.tsx` instead of `--- a/apps/foo.tsx`.
        """
        lines = patch.splitlines()
        result: list[str] = []
        for line in lines:
            if line.startswith("--- ") or line.startswith("+++ "):
                prefix = line[:4]  # "--- " or "+++ "
                rest = line[4:].strip()
                # Handle tab-separated timestamp
                timestamp = ""
                if "\t" in rest:
                    parts = rest.split("\t", 1)
                    filename = parts[0].strip()
                    timestamp = "\t" + parts[1]
                else:
                    filename = rest
                low = filename.lower()
                if low in ("/dev/null", "nul", "null"):
                    result.append(line)
                    continue
                # Add a/ or b/ prefix if missing
                if not filename.startswith("a/") and not filename.startswith("b/"):
                    ab = "a/" if prefix.startswith("---") else "b/"
                    filename = ab + filename
                result.append(f"{prefix}{filename}{timestamp}")
            else:
                result.append(line)
        return "\n".join(result)

    @staticmethod
    def _repair_hunk_counts(patch: str) -> str:
        """Fix incorrect line counts in @@ hunk headers.

        LLMs frequently output wrong OLD_COUNT / NEW_COUNT values in
        `@@ -start,count +start,count @@` headers. This recalculates them
        from the actual hunk content so `git apply` doesn't reject the patch.
        """
        import re
        hunk_re = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$')
        lines = patch.split('\n')
        result: list[str] = []
        i = 0
        while i < len(lines):
            m = hunk_re.match(lines[i])
            if not m:
                result.append(lines[i])
                i += 1
                continue

            old_start = int(m.group(1))
            new_start = int(m.group(3))
            trailing = m.group(5) or ''

            # Collect hunk body lines (context, +, -)
            j = i + 1
            old_count = 0
            new_count = 0
            while j < len(lines):
                ln = lines[j]
                if ln.startswith('@@') or ln.startswith('diff ') or ln.startswith('--- ') or ln.startswith('+++ '):
                    break
                if ln.startswith('-'):
                    old_count += 1
                elif ln.startswith('+'):
                    new_count += 1
                elif ln.startswith(' ') or ln == '':
                    # Context line (or empty line as context)
                    old_count += 1
                    new_count += 1
                elif ln.startswith('\\'):
                    pass  # "\ No newline at end of file"
                else:
                    # Ambiguous line — likely a context line missing the leading space
                    old_count += 1
                    new_count += 1
                j += 1

            result.append(f'@@ -{old_start},{old_count} +{new_start},{new_count} @@{trailing}')
            # Add the body lines
            for k in range(i + 1, j):
                result.append(lines[k])
            i = j

        return '\n'.join(result)

    async def list_worktrees(self) -> list[dict[str, Any]]:
        """List all active oasis worktrees."""
        worktrees = []
        if not os.path.exists(_get_worktree_dir()):
            return worktrees
        for name in sorted(os.listdir(_get_worktree_dir())):
            wt_path = self._worktree_path(name)
            if wt_path.is_dir():
                # Get branch info
                code, branch, _ = await self._run_git(
                    "rev-parse", "--abbrev-ref", "HEAD", cwd=str(wt_path)
                )
                worktrees.append({
                    "id": name,
                    "path": str(wt_path),
                    "branch": branch.strip() if code == 0 else "unknown",
                })
        return worktrees

    async def create_worktree(self, name: str | None = None) -> dict[str, Any]:
        """Create a new git worktree with an isolated branch.

        Returns: {"success": bool, "worktree_id": str, "branch": str, "path": str, "error": str}
        """
        raw = (name or "").strip()
        worktree_id = raw if raw else f"oasis-{uuid.uuid4().hex[:8]}"
        ok_name, name_err = _validate_worktree_name(worktree_id)
        if not ok_name:
            logger.warning("create_worktree rejected name=%r: %s", name, name_err)
            return {
                "success": False,
                "worktree_id": worktree_id,
                "branch": "",
                "path": "",
                "error": name_err,
            }

        branch_name = f"oasis/{worktree_id}"
        wt_path = self._worktree_path(worktree_id)

        if wt_path.exists():
            return {
                "success": True,
                "worktree_id": worktree_id,
                "branch": branch_name,
                "path": str(wt_path),
                "error": "Worktree already exists, reusing it",
            }

        # Create worktree with a new branch based on current HEAD
        code, stdout, stderr = await self._run_git(
            "worktree", "add", str(wt_path), "-b", branch_name
        )

        if code != 0:
            # Branch might already exist, try without -b
            code, stdout, stderr = await self._run_git(
                "worktree", "add", str(wt_path), branch_name
            )
            if code != 0:
                err = (stderr or stdout or "").strip() or "git worktree add failed (no stderr)"
                logger.warning(
                    "create_worktree failed worktree_id=%r branch=%r: %s",
                    worktree_id,
                    branch_name,
                    err,
                )
                return {
                    "success": False,
                    "worktree_id": worktree_id,
                    "branch": branch_name,
                    "path": "",
                    "error": err,
                }

        logger.info("Created worktree: %s at %s (branch: %s)", worktree_id, wt_path, branch_name)
        return {
            "success": True,
            "worktree_id": worktree_id,
            "branch": branch_name,
            "path": str(wt_path),
            "error": "",
        }

    async def write_file(self, worktree_id: str, path: str, content: str) -> dict[str, Any]:
        """Write/overwrite a file in the worktree.

        Returns: {"success": bool, "path": str, "error": str}
        """
        path = self._normalize_repo_relative_path(path)
        if not path:
            return {"success": False, "path": path, "error": "Path is empty after normalization"}
        is_valid, reason = self._validate_path(path)
        if not is_valid:
            return {"success": False, "path": path, "error": reason}

        wt_path = self._worktree_path(worktree_id)
        if not wt_path.exists():
            hint = ""
            if any(c in worktree_id for c in "<>") or "create" in worktree_id.lower():
                hint = (
                    " If you pasted a prompt placeholder (e.g. <from create_worktree>), call create_worktree first "
                    "and use the real id it returns."
                )
            return {"success": False, "path": path, "error": f"Worktree '{worktree_id}' not found.{hint}"}

        full_path = wt_path / path
        try:
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            logger.info("Wrote file: %s in worktree %s (%d bytes)", path, worktree_id, len(content))
            return {"success": True, "path": path, "error": ""}
        except Exception as e:
            return {"success": False, "path": path, "error": str(e)}

    async def edit_file(self, worktree_id: str, path: str, old_string: str, new_string: str) -> dict[str, Any]:
        """Edit a file using search/replace in the worktree.

        Returns: {"success": bool, "path": str, "replacements": int, "error": str}
        """
        path = self._normalize_repo_relative_path(path)
        if not path:
            return {"success": False, "path": path, "replacements": 0, "error": "Path is empty after normalization"}
        is_valid, reason = self._validate_path(path)
        if not is_valid:
            return {"success": False, "path": path, "replacements": 0, "error": reason}

        wt_path = self._worktree_path(worktree_id)
        resolved, rel_used = self._resolve_existing_under_worktree(wt_path, path)
        if resolved is None:
            return {"success": False, "path": path, "replacements": 0, "error": f"File not found: {path}"}
        full_path = resolved

        try:
            content = full_path.read_text(encoding="utf-8")
            # Model paste often uses CRLF; file content from read_text is usually LF — try normalized needle first.
            old_norm = old_string.replace("\r\n", "\n").replace("\r", "\n")
            new_norm = new_string.replace("\r\n", "\n").replace("\r", "\n")
            if old_norm and content.count(old_norm) > 0:
                needle, repl, count = old_norm, new_norm, content.count(old_norm)
            elif old_string and content.count(old_string) > 0:
                needle, repl, count = old_string, new_string, content.count(old_string)
            else:
                # Try stripping line-number prefixes that agent may have copied from read output
                # Patterns: "  135 │ code" or "135: code" or "  135 | code"
                import re
                stripped_old = re.sub(r"(?m)^\s*\d+\s*[│|:]\s?", "", old_norm)
                stripped_new = re.sub(r"(?m)^\s*\d+\s*[│|:]\s?", "", new_norm)
                if stripped_old and stripped_old != old_norm and content.count(stripped_old) > 0:
                    needle, repl, count = stripped_old, stripped_new, content.count(stripped_old)
                    logger.info("edit_file: matched after stripping line-number prefixes from old_string")
                else:
                    # Try stripping leading/trailing whitespace per line
                    old_lines = old_norm.splitlines()
                    stripped_ws = "\n".join(l.rstrip() for l in old_lines)
                    if stripped_ws and stripped_ws != old_norm and content.count(stripped_ws) > 0:
                        new_lines = new_norm.splitlines()
                        needle = stripped_ws
                        repl = "\n".join(l.rstrip() for l in new_lines)
                        count = content.count(stripped_ws)
                        logger.info("edit_file: matched after stripping trailing whitespace")
                    else:
                        count = 0
                        needle, repl = old_string, new_string
            if count == 0:
                # Provide helpful error with a snippet of what's actually in the file near the expected location
                return {"success": False, "path": path, "replacements": 0, "error": "old_string not found in file. Re-read the file with read_worktree_file (use start_line/end_line) and copy the exact text."}
            new_content = content.replace(needle, repl)
            full_path.write_text(new_content, encoding="utf-8")
            logger.info(
                "Edited file: %s (resolved %s) in worktree %s (%d replacements)",
                path,
                rel_used,
                worktree_id,
                count,
            )
            return {"success": True, "path": rel_used, "replacements": count, "error": ""}
        except Exception as e:
            return {"success": False, "path": path, "replacements": 0, "error": str(e)}

    async def apply_patch(self, worktree_id: str, patch_text: str) -> dict[str, Any]:
        """Apply a unified diff in the worktree via git apply (progressively lenient whitespace).

        Returns: {"success": bool, "error": str, "files_touched": list[str], "summary": str}
        """
        raw = self._strip_patch_fences(patch_text)
        if not raw.strip():
            return {
                "success": False,
                "error": "Empty patch",
                "files_touched": [],
                "summary": "",
            }

        # Strip line-number prefixes if agent copied from numbered read output
        # Patterns: "  135 │ code" or "135: code" — only on context/+/- lines, not headers
        raw = self._strip_line_number_prefixes(raw)

        # Convert absolute paths to relative paths automatically
        raw = self._convert_absolute_paths_to_relative(raw)

        # Repair missing --- / +++ headers (common LLM generation issue)
        raw = self._repair_patch_headers(raw)

        # Normalize --- path → --- a/path, +++ path → +++ b/path
        raw = self._normalize_patch_prefixes(raw)

        # Fix incorrect @@ hunk line counts (very common LLM mistake)
        raw = self._repair_hunk_counts(raw)

        ok, perr = self._validate_patch_paths(raw)
        if not ok:
            logger.error("apply_patch validation failed: %s", perr)
            return {"success": False, "error": perr, "files_touched": [], "summary": ""}

        wt_path = self._worktree_path(worktree_id)
        if not wt_path.exists():
            hint = ""
            if any(c in worktree_id for c in "<>") or "create" in worktree_id.lower():
                hint = (
                    " If you pasted a prompt placeholder, call create_worktree first "
                    "and use the real id it returns."
                )
            return {
                "success": False,
                "error": f"Worktree '{worktree_id}' not found.{hint}",
                "files_touched": [],
                "summary": "",
            }

        import tempfile

        fd, tmppath = tempfile.mkstemp(suffix=".patch", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(raw)
        except OSError as e:
            try:
                os.unlink(tmppath)
            except OSError:
                pass
            return {"success": False, "error": str(e), "files_touched": [], "summary": ""}

        strategies: list[list[str]] = [
            ["apply", "--check", tmppath],
            ["apply", "--check", "--whitespace=nowarn", tmppath],
            ["apply", "--check", "--ignore-space-change", tmppath],
            ["apply", "--check", "--ignore-whitespace", tmppath],
        ]
        chosen: list[str] | None = None
        last_err = ""
        for check_args in strategies:
            code, out, err = await self._run_git(*check_args, cwd=str(wt_path), timeout=120)
            if code == 0:
                chosen = [a for a in check_args if a != "--check"]
                break
            last_err = (err or out or "").strip() or f"git {' '.join(check_args)} failed"

        if chosen is None:
            try:
                os.unlink(tmppath)
            except OSError:
                pass
            return {
                "success": False,
                "error": last_err[:4000],
                "files_touched": [],
                "summary": "",
            }

        code, out, err = await self._run_git(*chosen, cwd=str(wt_path), timeout=120)
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        if code != 0:
            msg = (err or out or "git apply failed").strip()
            return {
                "success": False,
                "error": msg[:4000],
                "files_touched": [],
                "summary": "",
            }

        touched: list[str] = []
        for line in raw.splitlines():
            if not line.startswith("+++ "):
                continue
            part = line[4:].strip().split("\t", 1)[0].strip()
            low = part.lower()
            if low in ("/dev/null", "nul", "null"):
                continue
            if part.startswith("b/"):
                part = part[2:]
            if part and part not in touched:
                touched.append(part)

        summary = f"Applied unified diff ({len(touched)} file(s)): {', '.join(touched[:12])}"
        if len(touched) > 12:
            summary += "…"
        logger.info("apply_patch worktree=%s files=%s", worktree_id, touched)
        return {
            "success": True,
            "error": "",
            "files_touched": touched,
            "summary": summary,
        }

    async def read_file(
        self,
        worktree_id: str,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        """Read a file from the worktree (to see current state before editing).

        Args:
            worktree_id: Worktree identifier.
            path: Repo-relative file path.
            start_line: 1-based start line (inclusive). Reads a chunk when set.
            end_line: 1-based end line (inclusive).

        Returns: {"success": bool, "content": str, "error": str, "total_lines": int,
            "read_metadata": dict} on success (truncation flags, file_size_bytes, returned_bytes, line range).
        """
        path = self._normalize_repo_relative_path(path)
        if not path:
            return {"success": False, "content": "", "error": "Path is empty after normalization"}
        wt_path = self._worktree_path(worktree_id)
        resolved, rel_used = self._resolve_existing_under_worktree(wt_path, path)
        if resolved is None:
            return {"success": False, "content": "", "error": f"File not found: {path}"}
        full_path = resolved

        try:
            file_size_bytes = full_path.stat().st_size
            all_lines = full_path.read_text(encoding="utf-8").splitlines(keepends=True)
            total_lines = len(all_lines)
            max_lines = 500
            byte_limit = 100_000

            truncated_by_line_cap = False
            truncated_by_byte_cap = False
            source_line_start: int | None = None
            source_line_end: int | None = None
            next_chunk_start_line: int | None = None
            has_more_lines_below = False
            has_more_lines_above = False

            if start_line is not None:
                s = max(1, start_line) - 1  # 0-based
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
                if total_lines > max_lines:
                    content = "".join(all_lines[:max_lines])
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

            if len(content) > byte_limit:
                content = content[:byte_limit] + "\n... (truncated)"
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
            if rel_used != path.replace("\\", "/").strip().lstrip("/").rstrip("."):
                logger.info("read_worktree_file resolved %r → %s", path, rel_used)
            return {
                "success": True,
                "content": content,
                "error": "",
                "total_lines": total_lines,
                "read_metadata": read_metadata,
            }
        except Exception as e:
            return {"success": False, "content": "", "error": str(e)}

    async def get_diff(self, worktree_id: str) -> dict[str, Any]:
        """Get unified diff of all changes in the worktree vs its base.

        Returns: {"success": bool, "diff": str, "files_changed": list, "stats": str, "error": str}
        """
        wt_path = self._worktree_path(worktree_id)
        if not wt_path.exists():
            hint = ""
            if any(c in worktree_id for c in "<>") or "create" in worktree_id.lower():
                hint = " If you used a documentation placeholder, run create_worktree and pass the actual id."
            return {
                "success": False,
                "diff": "",
                "files_changed": [],
                "stats": "",
                "error": f"Worktree '{worktree_id}' not found.{hint}",
            }

        # Stage all changes first (including new files)
        await self._run_git("add", "-A", cwd=str(wt_path))

        # Diff staged changes against HEAD
        code, diff, stderr = await self._run_git(
            "diff", "--staged", "--no-color", cwd=str(wt_path)
        )

        # Get changed file list
        _, files_out, _ = await self._run_git(
            "diff", "--staged", "--name-status", cwd=str(wt_path)
        )
        files_changed = [line.strip() for line in files_out.strip().split("\n") if line.strip()]

        # Get stats
        _, stats_out, _ = await self._run_git(
            "diff", "--staged", "--stat", cwd=str(wt_path)
        )

        return {
            "success": True,
            "diff": diff,
            "files_changed": files_changed,
            "stats": stats_out.strip(),
            "error": "",
        }

    async def run_bash(self, command: str, worktree_id: str | None = None) -> dict[str, Any]:
        """Run a shell command on the host (native dev-agent).

        Uses PROJECT_ROOT as cwd when no worktree is given; if worktree_id is set and the
        worktree exists, cwd is that worktree. Full process environment is inherited so
        host Node/npm/nvm paths work (unlike tool-executor's stripped PATH).

        Returns keys aligned with tool-executor execute_command for the HTTP layer.
        """
        cmd = (command or "").strip()
        if not cmd:
            return {
                "success": False,
                "stdout": "",
                "stderr": "No command provided",
                "exit_code": -1,
                "blocked": False,
                "reason": "",
            }

        pkg_install_re = re.compile(
            r"\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\buv\s+(pip\s+)?add\b",
            re.I,
        )
        if pkg_install_re.search(cmd) and not (worktree_id and str(worktree_id).strip()):
            msg = (
                "Refusing package install without worktree_id: installs must run in a git worktree cwd "
                "(call create_worktree, then bash with worktree_id so node_modules/package-lock stay on the agent branch)."
            )
            logger.warning("run_bash refused package install without worktree: cmd_preview=%s", cmd[:120])
            return {
                "success": False,
                "stdout": "",
                "stderr": msg,
                "exit_code": -1,
                "blocked": False,
                "reason": "package_install_requires_worktree",
            }

        root = Path(PROJECT_ROOT).resolve()
        cwd = str(root)
        if worktree_id:
            wt = self._worktree_path(worktree_id)
            if wt.is_dir():
                cwd = str(wt.resolve())
            else:
                logger.warning("run_bash: worktree %r missing; using PROJECT_ROOT", worktree_id)

        # Rewrite /workspace references in the command to the actual cwd.
        # The LLM thinks it's in a container with /workspace as the project root,
        # but on the host the project lives at PROJECT_ROOT (or worktree path).
        if "/workspace" in cmd:
            cmd = cmd.replace("/workspace/", f"{cwd}/").replace("/workspace", cwd)
            logger.info("Dev-agent bash: rewrote /workspace paths → %s", cwd)

        logger.info("Dev-agent bash cwd=%s cmd_preview=%s", cwd, cmd[:200])

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=os.environ.copy(),
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=DEV_AGENT_BASH_TIMEOUT_SECONDS
            )
            stdout = stdout_bytes.decode("utf-8", errors="replace")[:DEV_AGENT_BASH_MAX_OUTPUT_BYTES]
            stderr = stderr_bytes.decode("utf-8", errors="replace")[:DEV_AGENT_BASH_MAX_OUTPUT_BYTES]
            return {
                "success": proc.returncode == 0,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": proc.returncode if proc.returncode is not None else 0,
                "blocked": False,
                "reason": "",
            }
        except asyncio.TimeoutError:
            logger.warning(
                "Dev-agent bash timed out after %ss: %s",
                DEV_AGENT_BASH_TIMEOUT_SECONDS,
                cmd[:120],
            )
            return {
                "success": False,
                "stdout": "",
                "stderr": f"Command timed out after {DEV_AGENT_BASH_TIMEOUT_SECONDS}s",
                "exit_code": -1,
                "blocked": False,
                "reason": "timeout",
            }
        except Exception as e:
            logger.error("Dev-agent bash error: %s", e)
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
                "blocked": False,
                "reason": str(e),
            }

    async def apply_changes(self, worktree_id: str, commit_message: str | None = None) -> dict[str, Any]:
        """Apply worktree changes to the main working tree.

        Steps:
        1. Commit all changes in the worktree
        2. Generate a patch
        3. Apply the patch to the main working tree

        Returns: {"success": bool, "files_applied": list, "error": str}
        """
        wt_path = self._worktree_path(worktree_id)
        if not wt_path.exists():
            return {"success": False, "files_applied": [], "error": f"Worktree '{worktree_id}' not found"}

        # Stage all changes
        await self._run_git("add", "-A", cwd=str(wt_path))

        # Check if there are changes
        code, status, _ = await self._run_git("diff", "--staged", "--name-only", cwd=str(wt_path))
        if not status.strip():
            return {"success": False, "files_applied": [], "error": "No changes to apply"}

        files = [f.strip() for f in status.strip().split("\n") if f.strip()]

        # Commit in worktree
        msg = commit_message or f"oasis-agent: changes from {worktree_id}"
        code, _, stderr = await self._run_git(
            "commit", "-m", msg, cwd=str(wt_path)
        )
        if code != 0:
            return {"success": False, "files_applied": [], "error": f"Commit failed: {stderr.strip()}"}

        # Generate patch from the commit
        code, patch, stderr = await self._run_git(
            "format-patch", "-1", "--stdout", "HEAD", cwd=str(wt_path)
        )
        if code != 0 or not patch.strip():
            return {"success": False, "files_applied": [], "error": f"Patch generation failed: {stderr.strip()}"}

        # Apply patch to main working tree
        proc = await asyncio.create_subprocess_exec(
            "git", "apply", "--3way", "--whitespace=nowarn",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=PROJECT_ROOT,
        )
        stdout, stderr_bytes = await asyncio.wait_for(
            proc.communicate(input=patch.encode("utf-8")), timeout=30
        )

        if proc.returncode != 0:
            stderr_text = stderr_bytes.decode("utf-8", errors="replace")
            return {"success": False, "files_applied": [], "error": f"Apply failed: {stderr_text.strip()}"}

        logger.info("Applied %d files from worktree %s to main working tree", len(files), worktree_id)
        return {"success": True, "files_applied": files, "error": ""}

    async def discard_worktree(self, worktree_id: str) -> dict[str, Any]:
        """Remove a worktree and its branch.

        Returns: {"success": bool, "error": str}
        """
        wt_path = self._worktree_path(worktree_id)
        branch_name = f"oasis/{worktree_id}"

        try:
            # Force remove worktree
            if wt_path.exists():
                code, _, stderr = await self._run_git("worktree", "remove", str(wt_path), "--force")
                if code != 0:
                    # Fallback: just delete the directory
                    shutil.rmtree(str(wt_path), ignore_errors=True)
                    await self._run_git("worktree", "prune")

            # Delete the branch
            await self._run_git("branch", "-D", branch_name)

            logger.info("Discarded worktree: %s", worktree_id)
            return {"success": True, "error": ""}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Snapshots (for autonomous mode revert) ─────────────────────────────────

    SNAPSHOTS_DIR = OASIS_CONFIG_DIR / "snapshots"

    async def create_snapshot(
        self,
        session_id: str,
        iteration_count: int = 0,
    ) -> dict[str, Any]:
        """Capture worktree state for revert. Returns { success, snapshot_id, path }."""
        snapshot_id = f"{session_id}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
        session_dir = self.SNAPSHOTS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = session_dir / f"{snapshot_id}.json"

        worktrees = await self.list_worktrees()
        worktree_states = []
        for wt in worktrees:
            wt_path = wt["path"]
            code_unstaged, diff_unstaged, _ = await self._run_git("diff", cwd=wt_path)
            code_staged, diff_staged, _ = await self._run_git("diff", "--staged", cwd=wt_path)
            combined = (diff_unstaged if code_unstaged == 0 else "") + (diff_staged if code_staged == 0 else "")
            if combined.strip():
                worktree_states.append({
                    "worktree_id": wt["id"],
                    "path": wt_path,
                    "branch": wt["branch"],
                    "diff": combined,
                })

        data = {
            "snapshot_id": snapshot_id,
            "session_id": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "iteration_count": iteration_count,
            "worktrees": worktree_states,
        }
        try:
            snapshot_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            logger.info("Snapshot created: %s (%d worktrees)", snapshot_id, len(worktree_states))
            return {"success": True, "snapshot_id": snapshot_id, "path": str(snapshot_path)}
        except Exception as e:
            logger.warning("Snapshot create failed: %s", e)
            return {"success": False, "snapshot_id": snapshot_id, "error": str(e)}

    async def restore_snapshot(self, snapshot_id: str, session_id: str) -> dict[str, Any]:
        """Restore worktree state from snapshot. Returns { success, error }."""
        snapshot_path = self.SNAPSHOTS_DIR / session_id / f"{snapshot_id}.json"
        if not snapshot_path.exists():
            return {"success": False, "error": f"Snapshot not found: {snapshot_id}"}
        try:
            data = json.loads(snapshot_path.read_text(encoding="utf-8"))
        except Exception as e:
            return {"success": False, "error": f"Invalid snapshot: {e}"}

        for wt_state in data.get("worktrees", []):
            wt_path = wt_state.get("path")
            diff = wt_state.get("diff", "")
            if not wt_path or not diff or not Path(wt_path).exists():
                continue
            # Reset to clean, then apply patch to restore snapshot state
            await self._run_git("checkout", ".", cwd=wt_path)
            await self._run_git("restore", "--staged", ".", cwd=wt_path)
            proc = await asyncio.create_subprocess_exec(
                "git", "apply", "-",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=wt_path,
            )
            await asyncio.wait_for(proc.communicate(input=diff.encode("utf-8")), timeout=60)
        logger.info("Snapshot restored: %s", snapshot_id)
        return {"success": True, "error": ""}

    async def list_snapshots(self, session_id: str) -> list[dict[str, Any]]:
        """List snapshots for a session."""
        session_dir = self.SNAPSHOTS_DIR / session_id
        if not session_dir.exists():
            return []
        snapshots = []
        for p in sorted(session_dir.glob("*.json"), reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                snapshots.append({
                    "snapshot_id": data.get("snapshot_id", p.stem),
                    "timestamp": data.get("timestamp", ""),
                    "iteration_count": data.get("iteration_count", 0),
                })
            except Exception:
                pass
        return snapshots[:50]

    # ── Project indexing ─────────────────────────────────────────────────────

    async def index_project(self, project_path: str) -> dict[str, Any]:
        """Scan a project directory and return structured metadata.

        Returns a dict with: name, path, tech_stack, frameworks,
        directory_structure, file_stats, description.
        Also generates a .oasis-context.md file at the project root.
        """
        root = Path(project_path).resolve()
        if not root.is_dir():
            return {"success": False, "error": f"Not a directory: {project_path}"}

        try:
            tech_stack: set[str] = set()
            frameworks: set[str] = set()
            file_stats: dict[str, int] = defaultdict(int)
            project_name = root.name

            # --- Detect tech stack from key files ---
            for filename, label in TECH_STACK_FILES.items():
                if (root / filename).exists():
                    tech_stack.add(label)

            # --- Read package.json (root + subdirs up to 2 levels) for framework detection ---
            npm_deps: dict[str, str] = {}
            pkg_json_candidates = [root / "package.json"]
            # Scan apps/ and packages/ subdirectories for monorepo support
            for subdir in ["apps", "packages", "libs", "modules"]:
                sub = root / subdir
                if sub.is_dir():
                    for child in sub.iterdir():
                        if child.is_dir() and (child / "package.json").exists():
                            pkg_json_candidates.append(child / "package.json")

            for pkg_json_path in pkg_json_candidates:
                if pkg_json_path.exists():
                    try:
                        pkg = json.loads(pkg_json_path.read_text(encoding="utf-8"))
                        if pkg_json_path == root / "package.json":
                            project_name = pkg.get("name", project_name)
                        npm_deps.update(pkg.get("dependencies", {}))
                        npm_deps.update(pkg.get("devDependencies", {}))
                    except Exception:
                        pass

            if npm_deps:
                tech_stack.add("Node.js/TypeScript")

            for dep_name, fw_label in FRAMEWORK_DETECTORS.items():
                if dep_name in npm_deps:
                    frameworks.add(fw_label)

            # --- Detect Python frameworks from requirements / pyproject ---
            python_deps = await self._read_python_deps(root)
            # Also scan service subdirectories for requirements.txt
            for subdir in ["services"]:
                sub = root / subdir
                if sub.is_dir():
                    for child in sub.iterdir():
                        if child.is_dir():
                            child_deps = await self._read_python_deps(child)
                            python_deps.update(child_deps)

            if python_deps:
                tech_stack.add("Python")

            for dep_name, fw_label in FRAMEWORK_DETECTORS.items():
                if dep_name in python_deps:
                    frameworks.add(fw_label)

            # --- Count files by extension (async walk, skip ignored dirs) ---
            file_stats = await asyncio.to_thread(self._count_files, root)

            # --- Build directory tree (2 levels deep) ---
            dir_tree = self._build_dir_tree(root, max_depth=2)

            # --- Auto-generate description ---
            stack_str = ", ".join(sorted(tech_stack)) if tech_stack else "Unknown"
            fw_str = ", ".join(sorted(frameworks)) if frameworks else "none detected"
            total_files = sum(file_stats.values())
            description = (
                f"{project_name} is a {stack_str} project"
                f" using {fw_str}."
                f" Contains {total_files} files across {len(file_stats)} file types."
            )

            result = {
                "success": True,
                "name": project_name,
                "path": str(root),
                "tech_stack": sorted(tech_stack),
                "frameworks": sorted(frameworks),
                "directory_structure": dir_tree,
                "file_stats": dict(sorted(file_stats.items(), key=lambda x: -x[1])),
                "description": description,
                "error": "",
            }

            # --- Generate .oasis-context.md ---
            context_md = self._generate_context_md(result)
            context_path = root / ".oasis-context.md"
            try:
                context_path.write_text(context_md, encoding="utf-8")
                result["context_file"] = str(context_path)
            except Exception as e:
                logger.warning("Could not write .oasis-context.md: %s", e)
                result["context_file_error"] = str(e)

            logger.info("Indexed project: %s (%d files, stack: %s)", project_name, total_files, stack_str)
            return result

        except Exception as e:
            logger.exception("Error indexing project at %s", project_path)
            return {"success": False, "error": str(e)}

    @staticmethod
    def _count_files(root: Path) -> dict[str, int]:
        """Walk the directory tree counting files by extension, skipping ignored dirs."""
        stats: dict[str, int] = defaultdict(int)
        for dirpath, dirnames, filenames in os.walk(root):
            # Prune ignored directories in-place
            dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")]
            for fname in filenames:
                ext = Path(fname).suffix.lower() or "(no ext)"
                stats[ext] += 1
        return dict(stats)

    @staticmethod
    def _build_dir_tree(root: Path, max_depth: int = 2) -> str:
        """Build a simple text tree of the directory structure."""
        lines: list[str] = [root.name + "/"]

        def _walk(path: Path, prefix: str, depth: int) -> None:
            if depth > max_depth:
                return
            try:
                entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            except PermissionError:
                return
            # Filter
            entries = [
                e for e in entries
                if e.name not in IGNORED_DIRS
                and not e.name.startswith(".")
                and e.name != ".oasis-context.md"
            ]
            for i, entry in enumerate(entries):
                is_last = i == len(entries) - 1
                connector = "└── " if is_last else "├── "
                suffix = "/" if entry.is_dir() else ""
                lines.append(f"{prefix}{connector}{entry.name}{suffix}")
                if entry.is_dir():
                    extension = "    " if is_last else "│   "
                    _walk(entry, prefix + extension, depth + 1)

        _walk(root, "", 1)
        return "\n".join(lines)

    @staticmethod
    async def _read_python_deps(root: Path) -> set[str]:
        """Extract Python dependency names from requirements.txt or pyproject.toml."""
        deps: set[str] = set()

        req_path = root / "requirements.txt"
        if req_path.exists():
            try:
                for line in req_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and not line.startswith("-"):
                        # Extract package name (before ==, >=, etc.)
                        name = line.split("==")[0].split(">=")[0].split("<=")[0].split("~=")[0].split("[")[0].strip()
                        deps.add(name.lower())
            except Exception:
                pass

        pyproject_path = root / "pyproject.toml"
        if pyproject_path.exists():
            try:
                content = pyproject_path.read_text(encoding="utf-8")
                # Simple extraction — look for dependencies list
                in_deps = False
                for line in content.splitlines():
                    if "dependencies" in line and "=" in line:
                        in_deps = True
                        continue
                    if in_deps:
                        if line.strip().startswith("]"):
                            in_deps = False
                            continue
                        # Extract quoted package name
                        stripped = line.strip().strip(",").strip('"').strip("'")
                        if stripped:
                            name = stripped.split("==")[0].split(">=")[0].split("<=")[0].split("~=")[0].split("[")[0].strip()
                            if name and not name.startswith("#"):
                                deps.add(name.lower())
            except Exception:
                pass

        return deps

    @staticmethod
    def _generate_context_md(index: dict[str, Any]) -> str:
        """Generate a .oasis-context.md file from index results."""
        lines = [
            f"# {index['name']} — Project Context",
            "",
            "## Overview",
            index["description"],
            "",
            "## Tech Stack",
        ]
        for item in index["tech_stack"]:
            lines.append(f"- {item}")
        if index["frameworks"]:
            lines.append("")
            lines.append("## Frameworks & Libraries")
            for fw in index["frameworks"]:
                lines.append(f"- {fw}")
        lines.append("")
        lines.append("## Directory Structure")
        lines.append("```")
        lines.append(index["directory_structure"])
        lines.append("```")
        lines.append("")
        lines.append("## File Statistics")
        top_exts = list(index["file_stats"].items())[:15]
        for ext, count in top_exts:
            lines.append(f"- `{ext}`: {count} files")
        lines.append("")
        return "\n".join(lines)

    # ── Project config persistence ───────────────────────────────────────────

    @staticmethod
    def save_project_config(config: dict[str, Any]) -> dict[str, Any]:
        """Save project configuration to ~/.oasis/project-config.json (legacy global)."""
        try:
            OASIS_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            PROJECT_CONFIG_PATH.write_text(
                json.dumps(config, indent=2), encoding="utf-8"
            )
            logger.info("Saved project config: %s", config.get("project_name", "unknown"))
            return {"success": True, "error": ""}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def load_project_config() -> dict[str, Any]:
        """Load project configuration from ~/.oasis/project-config.json (legacy global)."""
        if not PROJECT_CONFIG_PATH.exists():
            return {"success": False, "config": None, "error": "No project config found"}
        try:
            config = json.loads(PROJECT_CONFIG_PATH.read_text(encoding="utf-8"))
            return {"success": True, "config": config, "error": ""}
        except Exception as e:
            return {"success": False, "config": None, "error": str(e)}

    # ── Per-project settings persistence ──────────────────────────────────────

    @staticmethod
    def _project_settings_path(project_id: str) -> Path:
        return PROJECTS_DIR / project_id / "settings.json"

    @staticmethod
    def save_project_settings(project_id: str, settings: dict[str, Any]) -> dict[str, Any]:
        """Save per-project settings to ~/.oasis/projects/{project_id}/settings.json."""
        try:
            path = DevAgentService._project_settings_path(project_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            logger.info("Saved project settings for %s", project_id)
            return {"success": True, "error": ""}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def load_project_settings(project_id: str) -> dict[str, Any]:
        """Load per-project settings from ~/.oasis/projects/{project_id}/settings.json."""
        path = DevAgentService._project_settings_path(project_id)
        if not path.exists():
            return {"success": True, "settings": {}, "error": ""}
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
            return {"success": True, "settings": settings, "error": ""}
        except Exception as e:
            return {"success": False, "settings": None, "error": str(e)}

    @staticmethod
    def set_active_project(project_id: str | None) -> dict[str, Any]:
        """Set the active project pointer in ~/.oasis/active-project.json."""
        try:
            OASIS_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            if project_id is None:
                if ACTIVE_PROJECT_PATH.exists():
                    ACTIVE_PROJECT_PATH.unlink()
                return {"success": True, "error": ""}
            ACTIVE_PROJECT_PATH.write_text(
                json.dumps({"project_id": project_id}, indent=2), encoding="utf-8"
            )
            logger.info("Active project set to %s", project_id)
            return {"success": True, "error": ""}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def get_active_project() -> dict[str, Any]:
        """Get the active project ID from ~/.oasis/active-project.json."""
        if not ACTIVE_PROJECT_PATH.exists():
            return {"success": True, "project_id": None, "error": ""}
        try:
            data = json.loads(ACTIVE_PROJECT_PATH.read_text(encoding="utf-8"))
            return {"success": True, "project_id": data.get("project_id"), "error": ""}
        except Exception as e:
            return {"success": False, "project_id": None, "error": str(e)}

    @staticmethod
    def get_active_project_settings() -> dict[str, Any]:
        """Load settings for the currently active project (convenience method)."""
        active = DevAgentService.get_active_project()
        pid = active.get("project_id")
        if not pid:
            return {"success": True, "project_id": None, "settings": {}, "error": ""}
        result = DevAgentService.load_project_settings(pid)
        result["project_id"] = pid
        return result
