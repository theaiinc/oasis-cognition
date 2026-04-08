"""Tool Executor microservice — sandboxed command execution."""

from __future__ import annotations

import logging
import sys
import os
from contextlib import asynccontextmanager
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI
from pydantic import BaseModel

from services.tool_executor.service import ToolExecutorService

logger = logging.getLogger(__name__)

executor = ToolExecutorService()

# Active workspace path (Docker-translated).  Updated by /workspace/switch.
_active_workspace: str = os.environ.get("OASIS_WORKSPACE_PATH", "/workspace")

# Prefix on host home that maps to /host-home inside Docker.
# The dev-agent sends host-absolute paths; we translate on the fly.
_HOST_HOME_MOUNT = "/host-home"


def _translate_path(path: str | None) -> str | None:
    """Translate host-absolute paths to Docker-visible paths.

    The docker-compose volume mounts ${HOME}:/host-home:ro, so
    /Users/stevetran/foo → /host-home/foo when HOME was /Users/stevetran.
    We also rewrite /workspace references to the active workspace.
    """
    if not path:
        return path
    # Rewrite /workspace → active workspace (the LLM often uses /workspace
    # as a default, but the active project may be mounted elsewhere).
    if _active_workspace != "/workspace":
        if path == "/workspace" or path == "/workspace/":
            return _active_workspace
        if path.startswith("/workspace/"):
            return _active_workspace + path[len("/workspace"):]
    # Rewrite relative "." to active workspace
    if path in (".", "./"):
        return _active_workspace
    # Already a Docker-internal path
    if path.startswith((_HOST_HOME_MOUNT, "/app", "/tmp")):
        return path
    # If the active workspace was set via /workspace/switch, translate paths
    # that start with the original host prefix into the Docker mount.
    host_home_prefix = os.environ.get("OASIS_HOST_HOME", "")
    if host_home_prefix and path.startswith(host_home_prefix):
        return _HOST_HOME_MOUNT + path[len(host_home_prefix):]
    # Fall back: if path looks like an absolute host path under /Users or /home,
    # try a best-effort mapping.
    for prefix in ("/Users/", "/home/"):
        if path.startswith(prefix):
            # e.g. /Users/stevetran/foo → /host-home/stevetran/foo
            #   (because ${HOME}=/Users/stevetran is mounted to /host-home)
            # We strip only the first segment (/Users or /home).
            remainder = path[len(prefix) - 1:]  # keep the /stevetran/foo part
            return _HOST_HOME_MOUNT + remainder
    return path


class ExecuteRequest(BaseModel):
    tool: str  # "bash", "read_file", "list_dir", "grep", "browse_url", "find_files"
    command: str | None = None  # for bash
    path: str | None = None  # for read_file / list_dir / grep / find_files
    pattern: str | None = None  # for grep / find_files
    url: str | None = None  # for browse_url
    working_dir: str | None = None
    recursive: bool = False  # for list_dir
    file_type: str | None = None  # for find_files: "file", "dir", or None
    start_line: int | None = None  # for read_file: 1-based start line
    end_line: int | None = None  # for read_file: 1-based end line (inclusive)


class ExecuteResponse(BaseModel):
    success: bool
    output: str
    blocked: bool = False
    reason: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logger.info("Tool Executor started")
    yield


app = FastAPI(title="Oasis Tool Executor Service", lifespan=lifespan)


@app.post("/workspace/switch")
async def switch_workspace(body: dict[str, Any]) -> dict[str, Any]:
    """Switch the active workspace (project path).

    Accepts a Docker-translated path (e.g. /host-home/stevetran/my-project).
    """
    global _active_workspace
    new_path = body.get("workspace_path", "")
    if not new_path:
        return {"success": False, "error": "workspace_path is required"}
    _active_workspace = new_path
    logger.info("Workspace switched to %s", _active_workspace)
    return {"success": True, "workspace": _active_workspace}


@app.post("/internal/tool/execute")
async def execute_tool(req: ExecuteRequest) -> dict[str, Any]:
    """Execute a tool call. Returns structured result."""
    # Translate host-absolute paths to Docker-visible paths
    req.path = _translate_path(req.path)
    req.working_dir = _translate_path(req.working_dir)
    # Default working_dir to active workspace
    if not req.working_dir and req.tool == "bash":
        req.working_dir = _active_workspace

    if req.tool == "bash":
        if not req.command:
            return {"success": False, "output": "No command provided", "blocked": False, "reason": ""}
        result = await executor.execute_command(req.command, working_dir=req.working_dir)
        output = result["stdout"]
        if result["stderr"]:
            output += ("\n" if output else "") + result["stderr"]
        return {
            "success": result["success"],
            "output": output.strip(),
            "blocked": result["blocked"],
            "reason": result["reason"],
            "exit_code": result["exit_code"],
        }

    elif req.tool == "read_file":
        if not req.path:
            return {"success": False, "output": "No path provided", "blocked": False, "reason": ""}
        result = await executor.read_file(req.path, start_line=req.start_line, end_line=req.end_line)
        output = result["content"] if result["success"] else result["error"]
        total = result.get("total_lines")
        if total and result["success"]:
            output = f"[{total} lines total]\n{output}"
        out: dict[str, Any] = {
            "success": result["success"],
            "output": output,
            "blocked": result["blocked"],
            "reason": result.get("error", ""),
        }
        if result.get("success") and result.get("read_metadata") is not None:
            out["read_metadata"] = result["read_metadata"]
        return out

    elif req.tool == "list_dir":
        effective_path = req.path or _active_workspace
        result = await executor.list_directory(effective_path, recursive=req.recursive)
        if result["success"]:
            return {"success": True, "output": "\n".join(result["entries"]), "blocked": False, "reason": ""}
        return {"success": False, "output": result["error"], "blocked": result["blocked"], "reason": result.get("error", "")}

    elif req.tool == "find_files":
        if not req.pattern:
            return {"success": False, "output": "No pattern provided", "blocked": False, "reason": ""}
        result = await executor.find_files(req.pattern, path=req.path or _active_workspace, file_type=req.file_type)
        if result["success"]:
            return {"success": True, "output": result["output"], "blocked": False, "reason": ""}
        return {"success": False, "output": result.get("error", ""), "blocked": result.get("blocked", False), "reason": result.get("error", "")}

    elif req.tool == "grep":
        if not req.pattern:
            return {"success": False, "output": "No pattern provided", "blocked": False, "reason": ""}
        result = await executor.grep(req.pattern, path=req.path or _active_workspace)
        if result["success"]:
            return {"success": True, "output": result["output"], "blocked": False, "reason": ""}
        return {"success": False, "output": result.get("error", result["output"]), "blocked": result.get("blocked", False), "reason": result.get("error", "")}

    elif req.tool == "web_search":
        if not req.command:  # reuse command field for the search query
            return {"success": False, "output": "No search query provided", "blocked": False, "reason": ""}
        result = await executor.web_search(req.command, num_results=5)
        if result["success"]:
            formatted = "\n\n".join(
                f"{i+1}. {r['title']}\n   {r['snippet']}\n   {r['url']}"
                for i, r in enumerate(result["results"])
            )
            return {"success": True, "output": formatted or "No results found", "blocked": False, "reason": "", "results": result["results"]}
        return {"success": False, "output": result.get("error", "Search failed"), "blocked": False, "reason": ""}

    elif req.tool == "browse_url":
        if not req.url:
            return {"success": False, "output": "No URL provided", "blocked": False, "reason": ""}
        result = await executor.browse_url(req.url)
        if result["success"]:
            output = result["text"]
            if result.get("screenshot_b64"):
                output += f"\n\n[Screenshot captured: {len(result['screenshot_b64']) // 1024} KB base64]"
            return {
                "success": True,
                "output": output.strip(),
                "blocked": False,
                "reason": "",
                "screenshot_b64": result.get("screenshot_b64", ""),
            }
        return {"success": False, "output": result["error"], "blocked": result.get("blocked", False), "reason": result.get("error", "")}

    else:
        return {"success": False, "output": f"Unknown tool: {req.tool}", "blocked": False, "reason": "unknown_tool"}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "tool-executor"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8007)
