"""Dev Agent microservice — native git worktree-based code editing.

Runs on the HOST (not Docker) for full git/filesystem access.
Start with: ./scripts/start-dev-agent.sh
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services.dev_agent.chrome_bridge import chrome_bridge

from services.dev_agent.service import DevAgentService, set_project_root as _svc_set_project_root
from services.dev_agent.tunnel import TunnelManager

logger = logging.getLogger(__name__)

dev_agent = DevAgentService()
tunnel_manager = TunnelManager()

PROJECT_ROOT = os.getenv("PROJECT_ROOT", os.getcwd())


# ── Request/Response models ──────────────────────────────────────────────────

class CreateWorktreeRequest(BaseModel):
    name: str | None = None


class WriteFileRequest(BaseModel):
    worktree_id: str
    path: str
    content: str


class EditFileRequest(BaseModel):
    worktree_id: str
    path: str
    old_string: str
    new_string: str


class ReadFileRequest(BaseModel):
    worktree_id: str
    path: str


class ApplyRequest(BaseModel):
    worktree_id: str
    commit_message: str | None = None


class ConfigureProjectRequest(BaseModel):
    project_path: str
    project_type: str = "local"  # "local" | "git"
    git_url: str | None = None
    project_id: str | None = None  # if provided, save settings to this project


class ActivateProjectRequest(BaseModel):
    project_id: str | None = None  # None to deactivate
    project_path: str | None = None  # optional: passed by gateway from Neo4j


class SaveProjectSettingsRequest(BaseModel):
    project_id: str
    settings: dict  # per-project overrides (project_path, llm_model, etc.)


class CreateSnapshotRequest(BaseModel):
    session_id: str
    iteration_count: int = 0


class RestoreSnapshotRequest(BaseModel):
    snapshot_id: str
    session_id: str


# ── Unified tool execution (called by API gateway) ──────────────────────────

class ToolRequest(BaseModel):
    tool: str  # "create_worktree", "write_file", "edit_file", "apply_patch", "read_worktree_file", "get_diff", "bash", "computer_action"
    worktree_id: str | None = None
    name: str | None = None
    path: str | None = None
    content: str | None = None
    old_string: str | None = None
    new_string: str | None = None
    patch: str | None = None  # unified diff for apply_patch
    command: str | None = None  # for bash (e.g. npm install)
    # ── computer_action fields ──
    action: str | None = None       # e.g. "click", "type_text", "screenshot", "key_press", "scroll"
    x: int | None = None
    y: int | None = None
    text: str | None = None         # for type_text
    key: str | None = None          # for key_press / hotkey
    keys: list[str] | None = None   # for hotkey combos
    button: str | None = None       # "left" / "right" / "middle"
    direction: str | None = None    # "up" / "down" for scroll
    amount: int | None = None       # scroll amount
    clicks: int | None = None       # for click (1 = single, 2 = double)
    screen_region: dict | None = None  # {x, y, width, height} for screen-specific capture
    # ── chunked read fields ──
    start_line: int | None = None   # 1-based start line for read_worktree_file
    end_line: int | None = None     # 1-based end line (inclusive) for read_worktree_file


MEMORY_SERVICE_URL = os.getenv("MEMORY_SERVICE_URL", "http://localhost:8004")
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:8000")


async def _auto_create_project(project_path: str) -> str | None:
    """Auto-create a project in the gateway and return its project_id."""
    project_name = Path(project_path).name
    max_retries = 5
    for attempt in range(1, max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{GATEWAY_URL}/api/v1/projects",
                    json={
                        "name": project_name,
                        "description": f"Auto-created from {project_path}",
                        "project_path": project_path,
                    },
                )
                if resp.status_code in (200, 201):
                    data = resp.json()
                    new_pid = data.get("project", {}).get("project_id")
                    if new_pid:
                        logger.info("Auto-created project '%s' → %s", project_name, new_pid)
                        return new_pid
                logger.warning("Auto-create project attempt %d failed: %s", attempt, resp.text)
        except Exception as e:
            logger.warning("Auto-create project attempt %d error: %s", attempt, e)
        if attempt < max_retries:
            import asyncio
            await asyncio.sleep(3)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global PROJECT_ROOT
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    )
    # On startup, load the active project's settings and override PROJECT_ROOT
    active = dev_agent.get_active_project_settings()
    pid = active.get("project_id")
    project_path = None

    if pid:
        project_settings = active.get("settings") or {}
        project_path = project_settings.get("project_path")
        if project_path and os.path.isdir(project_path):
            PROJECT_ROOT = project_path
            os.environ["PROJECT_ROOT"] = project_path
            _svc_set_project_root(project_path)
            logger.info("Active project %s → PROJECT_ROOT=%s", pid, project_path)
        else:
            logger.info("Active project %s has no valid project_path, using default", pid)
            project_path = None

    # Auto-create a project if none exists, using PROJECT_ROOT
    if not pid and os.path.isdir(PROJECT_ROOT):
        logger.info("No active project found, auto-creating from PROJECT_ROOT=%s", PROJECT_ROOT)
        new_pid = await _auto_create_project(PROJECT_ROOT)
        if new_pid:
            pid = new_pid
            project_path = PROJECT_ROOT
            dev_agent.set_active_project(pid)
            dev_agent.save_project_settings(pid, {"project_path": PROJECT_ROOT})

    # Notify Docker services about the workspace + trigger code indexing
    if project_path and os.path.isdir(project_path):
        try:
            await _notify_tool_executor_workspace(project_path)
            await _notify_code_indexer_workspace(project_path, reindex=True)
            await _notify_response_generator_workspace(project_path)
        except Exception as e:
            logger.warning("Failed to notify Docker services on startup: %s", e)

    logger.info("Dev Agent started (project_root=%s, project_id=%s)", PROJECT_ROOT, pid)
    yield


app = FastAPI(title="Oasis Dev Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CODE_INDEXER_URL = os.getenv("CODE_INDEXER_URL", "http://localhost:8010")
TOOL_EXECUTOR_URL = os.getenv("TOOL_EXECUTOR_URL", "http://localhost:8007")


def _host_to_docker_path(project_path: str) -> str:
    """Translate host-absolute paths to Docker-visible /host-home paths."""
    home = str(Path.home())
    if project_path.startswith(home):
        return "/host-home" + project_path[len(home):]
    return project_path


async def _update_project_path_in_memory(project_id: str, project_path: str) -> None:
    """Persist project_path back to Neo4j via the memory service so it is
    available when the project is activated later (single source of truth)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.patch(
                f"{MEMORY_SERVICE_URL}/internal/memory/projects/{project_id}",
                json={"project_path": project_path},
            )
            if resp.status_code == 200:
                logger.info("Updated project_path in Neo4j for %s: %s", project_id, project_path)
            else:
                logger.warning("Failed to update project_path in Neo4j: %s", resp.text)
    except Exception as e:
        logger.warning("Could not reach memory service to update project_path: %s", e)


async def _notify_code_indexer_workspace(project_path: str, reindex: bool = False) -> None:
    """Tell the code indexer to switch its workspace to the given path.

    The code indexer runs in Docker, so translate host paths:
    /Users/<user>/... → /host-home/... (via the docker-compose volume mount).
    If reindex=True, the code indexer will re-index the workspace after switching.
    """
    docker_path = _host_to_docker_path(project_path)

    try:
        async with httpx.AsyncClient(timeout=30 if reindex else 10) as client:
            resp = await client.post(
                f"{CODE_INDEXER_URL}/workspace/switch",
                json={"workspace_path": docker_path, "reindex": reindex},
            )
            if resp.status_code == 200:
                logger.info("Code indexer workspace switched to %s (reindex=%s)", docker_path, reindex)
            else:
                logger.warning("Code indexer workspace switch failed: %s", resp.text)
    except Exception as e:
        logger.warning("Could not reach code indexer for workspace switch: %s", e)


async def _notify_tool_executor_workspace(project_path: str) -> None:
    """Tell the tool executor to switch its active workspace to the given path."""
    docker_path = _host_to_docker_path(project_path)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{TOOL_EXECUTOR_URL}/workspace/switch",
                json={"workspace_path": docker_path},
            )
            if resp.status_code == 200:
                logger.info("Tool executor workspace switched to %s", docker_path)
            else:
                logger.warning("Tool executor workspace switch failed: %s", resp.text)
    except Exception as e:
        logger.warning("Could not reach tool executor for workspace switch: %s", e)


RESPONSE_GENERATOR_URL = os.getenv("RESPONSE_GENERATOR_URL", "http://localhost:8005")


async def _notify_response_generator_workspace(project_path: str) -> None:
    """Tell the response-generator to switch its project context."""
    docker_path = _host_to_docker_path(project_path)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{RESPONSE_GENERATOR_URL}/workspace/switch",
                json={"project_path": docker_path},
            )
            if resp.status_code == 200:
                logger.info("Response-generator workspace switched to %s", docker_path)
            else:
                logger.warning("Response-generator workspace switch failed: %s", resp.text)
    except Exception as e:
        logger.warning("Could not reach response-generator for workspace switch: %s", e)


# ── Chrome Bridge WebSocket endpoint ───────────────────────────────────────────

@app.websocket("/ws/chrome-bridge")
async def chrome_bridge_ws(ws: WebSocket):
    """WebSocket endpoint for the Oasis Chrome Bridge extension."""
    await chrome_bridge.accept(ws)
    try:
        while True:
            data = await ws.receive_json()
            chrome_bridge.handle_message(data)
    except WebSocketDisconnect:
        chrome_bridge.disconnect()
    except Exception as e:
        logger.warning("Chrome Bridge WS error: %s", e)
        chrome_bridge.disconnect()


# ── Unified tool endpoint (mirrors tool-executor pattern) ────────────────────

@app.post("/internal/dev-agent/execute")
async def execute_tool(req: ToolRequest) -> dict[str, Any]:
    """Execute a dev-agent tool call. Called by the API gateway."""

    if req.tool == "create_worktree":
        result = await dev_agent.create_worktree(name=req.name)
        output = f"Worktree '{result['worktree_id']}' created on branch '{result['branch']}'" if result["success"] else result["error"]
        return {"success": result["success"], "output": output, "blocked": False, "reason": "", "worktree_id": result.get("worktree_id", "")}

    elif req.tool == "write_file":
        if not req.worktree_id or not req.path or req.content is None:
            return {"success": False, "output": "Missing worktree_id, path, or content", "blocked": False, "reason": ""}
        result = await dev_agent.write_file(req.worktree_id, req.path, req.content)
        output = f"Wrote {req.path}" if result["success"] else result["error"]
        return {"success": result["success"], "output": output, "blocked": False, "reason": ""}

    elif req.tool == "edit_file":
        # new_string may be "" (delete); old_string must be non-empty for search/replace.
        if not req.worktree_id or not req.path or not req.old_string or req.new_string is None:
            return {"success": False, "output": "Missing worktree_id, path, old_string, or new_string", "blocked": False, "reason": ""}
        result = await dev_agent.edit_file(req.worktree_id, req.path, req.old_string, req.new_string)
        output = f"Edited {req.path} ({result['replacements']} replacements)" if result["success"] else result["error"]
        return {"success": result["success"], "output": output, "blocked": False, "reason": ""}

    elif req.tool == "apply_patch":
        if not req.worktree_id or req.patch is None or not str(req.patch).strip():
            return {"success": False, "output": "Missing worktree_id or patch (unified diff text)", "blocked": False, "reason": ""}
        result = await dev_agent.apply_patch(req.worktree_id, req.patch)
        output = result["summary"] if result["success"] else result["error"]
        return {"success": result["success"], "output": output, "blocked": False, "reason": ""}

    elif req.tool == "read_worktree_file":
        if not req.worktree_id or not req.path:
            return {"success": False, "output": "Missing worktree_id or path", "blocked": False, "reason": ""}
        result = await dev_agent.read_file(req.worktree_id, req.path, start_line=req.start_line, end_line=req.end_line)
        output = result["content"] if result["success"] else result["error"]
        total = result.get("total_lines")
        if total and result["success"]:
            output = f"[{total} lines total]\n{output}"
        out: dict[str, Any] = {"success": result["success"], "output": output, "blocked": False, "reason": ""}
        if result.get("success") and result.get("read_metadata") is not None:
            out["read_metadata"] = result["read_metadata"]
        return out

    elif req.tool == "get_diff":
        if not req.worktree_id:
            return {"success": False, "output": "Missing worktree_id", "blocked": False, "reason": ""}
        result = await dev_agent.get_diff(req.worktree_id)
        if result["success"]:
            output = f"Files changed:\n{chr(10).join(result['files_changed'])}\n\n{result['stats']}\n\n{result['diff']}"
        else:
            output = result["error"]
        return {
            "success": result["success"],
            "output": output,
            "blocked": False,
            "reason": "",
            "diff": result.get("diff", ""),
            "files_changed": result.get("files_changed", []),
            "worktree_id": req.worktree_id,
        }

    elif req.tool == "bash":
        if not req.command or not str(req.command).strip():
            return {"success": False, "output": "No command provided", "blocked": False, "reason": ""}
        result = await dev_agent.run_bash(req.command.strip(), req.worktree_id)
        output = result["stdout"]
        if result["stderr"]:
            output += ("\n" if output else "") + result["stderr"]
        return {
            "success": result["success"],
            "output": output.strip(),
            "blocked": result.get("blocked", False),
            "reason": result.get("reason", ""),
            "exit_code": result.get("exit_code", 0),
        }

    elif req.tool == "computer_action":
        if not req.action:
            return {"success": False, "output": "Missing action parameter for computer_action", "blocked": False, "reason": ""}
        from services.dev_agent.computer_use import execute_computer_action
        extra = {}
        if req.screen_region:
            extra["screen_region"] = req.screen_region
        result = await execute_computer_action(
            action=req.action,
            x=req.x,
            y=req.y,
            text=req.text,
            key=req.key,
            keys=req.keys,
            clicks=req.clicks or 1,
            button=req.button or "left",
            direction=req.direction or "down",
            amount=req.amount or 3,
            **extra,
        )
        resp = {
            "success": result.get("success", True),
            "output": result.get("output", ""),
            "blocked": False,
            "reason": "",
            "screenshot": result.get("screenshot", ""),
        }
        # Pass through extra fields from specific actions
        for extra_key in ("windows", "bounds", "screens", "thumbnail"):
            if extra_key in result:
                resp[extra_key] = result[extra_key]
        return resp

    else:
        return {"success": False, "output": f"Unknown dev-agent tool: {req.tool}", "blocked": False, "reason": "unknown_tool"}


# ── Direct endpoints (for UI apply/discard buttons) ─────────────────────────

@app.get("/internal/dev-agent/worktrees")
async def list_worktrees():
    worktrees = await dev_agent.list_worktrees()
    return {"worktrees": worktrees}


@app.post("/internal/dev-agent/apply")
async def apply_changes(req: ApplyRequest):
    result = await dev_agent.apply_changes(req.worktree_id, req.commit_message)
    return result


@app.delete("/internal/dev-agent/worktree/{worktree_id}")
async def discard_worktree(worktree_id: str):
    result = await dev_agent.discard_worktree(worktree_id)
    return result


@app.get("/internal/dev-agent/diff/{worktree_id}")
async def get_diff(worktree_id: str):
    result = await dev_agent.get_diff(worktree_id)
    return result


# ── Project indexing & config endpoints ───────────────────────────────────

@app.post("/internal/dev-agent/project/configure")
async def configure_project(req: ConfigureProjectRequest):
    """Save project config and trigger indexing.

    Also persists project_path/project_type/git_url into the active project's
    per-project settings so they are remembered across restarts.
    """
    global PROJECT_ROOT
    # Index the project first
    index_result = await dev_agent.index_project(req.project_path)
    if not index_result.get("success"):
        return {"success": False, "error": index_result.get("error", "Indexing failed")}

    # Build and save legacy global config
    config = {
        "project_path": req.project_path,
        "project_name": index_result["name"],
        "project_type": req.project_type,
        "git_url": req.git_url,
        "last_indexed": datetime.now(timezone.utc).isoformat(),
        "context_summary": index_result["description"],
        "tech_stack": index_result.get("tech_stack", []),
        "frameworks": index_result.get("frameworks", []),
    }
    save_result = dev_agent.save_project_config(config)
    if not save_result["success"]:
        return {"success": False, "error": save_result["error"]}

    # Save to per-project settings — use active project or explicit project_id
    active = dev_agent.get_active_project()
    active_pid = active.get("project_id") or req.project_id
    if active_pid:
        # If no project was active but project_id was provided, activate it now
        if not active.get("project_id") and req.project_id:
            dev_agent.set_active_project(req.project_id)
            logger.info("Auto-activated project %s during configure", req.project_id)

        existing = dev_agent.load_project_settings(active_pid).get("settings") or {}
        existing.update({
            "project_path": req.project_path,
            "project_type": req.project_type,
            "git_url": req.git_url,
            "last_indexed": config["last_indexed"],
            "context_summary": config["context_summary"],
            "tech_stack": config.get("tech_stack", []),
            "frameworks": config.get("frameworks", []),
        })
        dev_agent.save_project_settings(active_pid, existing)
        # Persist project_path to Neo4j so activation always resolves it
        await _update_project_path_in_memory(active_pid, req.project_path)
        # Update PROJECT_ROOT
        if os.path.isdir(req.project_path):
            PROJECT_ROOT = req.project_path
            os.environ["PROJECT_ROOT"] = req.project_path
            _svc_set_project_root(req.project_path)
            # Notify Docker services about the new workspace + trigger code indexing
            await _notify_code_indexer_workspace(req.project_path, reindex=True)
            await _notify_tool_executor_workspace(req.project_path)
            await _notify_response_generator_workspace(req.project_path)

    return {
        "success": True,
        "config": config,
        "index": {
            "tech_stack": index_result["tech_stack"],
            "frameworks": index_result["frameworks"],
            "file_stats": index_result["file_stats"],
        },
    }


@app.get("/internal/dev-agent/project/config")
async def get_project_config():
    """Return the current project configuration.

    If an active project has per-project settings, merge them into the response
    so the UI sees the project-specific values (not just the global legacy config).
    """
    result = dev_agent.load_project_config()
    if not result["success"]:
        # Fall back to per-project settings if legacy config doesn't exist
        active = dev_agent.get_active_project_settings()
        pid = active.get("project_id")
        if pid and active.get("settings"):
            s = active["settings"]
            cfg = {
                "project_path": s.get("project_path", ""),
                "project_name": s.get("project_name", ""),
                "project_type": s.get("project_type", "local"),
                "git_url": s.get("git_url", ""),
                "last_indexed": s.get("last_indexed", ""),
                "context_summary": s.get("context_summary", ""),
                "tech_stack": s.get("tech_stack", []),
                "frameworks": s.get("frameworks", []),
            }
            return {"success": True, "config": cfg}
        return {"success": False, "config": None, "error": result["error"]}

    cfg = result["config"]

    # Merge per-project settings on top (they take priority)
    active = dev_agent.get_active_project_settings()
    pid = active.get("project_id")
    if pid and active.get("settings"):
        s = active["settings"]
        for key in ("project_path", "project_type", "git_url", "last_indexed",
                     "context_summary", "tech_stack", "frameworks"):
            if key in s and s[key] not in (None, "", []):
                cfg[key] = s[key]

    # Use the resolved active project path as the authoritative project_path
    resolved = _resolve_active_project_path()
    if resolved:
        cfg["project_path"] = resolved
    return {"success": True, "config": cfg}


def _resolve_active_project_path() -> str | None:
    """Resolve the project path from the active project's per-project settings.

    This is the single method that configure, reindex, and activate use to
    determine which path to operate on.  Returns None if no active project or
    no valid project_path is configured — callers should treat this as an error
    rather than silently falling back to a potentially stale PROJECT_ROOT."""
    active = dev_agent.get_active_project()
    active_pid = active.get("project_id")
    if active_pid:
        settings = (dev_agent.load_project_settings(active_pid).get("settings") or {})
        path = settings.get("project_path")
        if path and os.path.isdir(path):
            return path
    return None


@app.post("/internal/dev-agent/project/reindex")
async def reindex_project():
    """Re-index the currently configured project."""
    cfg_result = dev_agent.load_project_config()
    if not cfg_result["success"] or not cfg_result["config"]:
        return {"success": False, "error": "No project configured. Use /project/configure first."}

    project_path = _resolve_active_project_path()
    if not project_path:
        return {"success": False, "error": "No active project with a valid project_path. Configure the project first."}

    # Keep PROJECT_ROOT in sync with the resolved path
    global PROJECT_ROOT
    if project_path != PROJECT_ROOT:
        PROJECT_ROOT = project_path
        os.environ["PROJECT_ROOT"] = project_path
        _svc_set_project_root(project_path)

    index_result = await dev_agent.index_project(project_path)
    if not index_result.get("success"):
        return {"success": False, "error": index_result.get("error", "Indexing failed")}

    # Update config with latest index results
    cfg_result["config"]["project_path"] = project_path
    cfg_result["config"]["last_indexed"] = datetime.now(timezone.utc).isoformat()
    cfg_result["config"]["context_summary"] = index_result["description"]
    cfg_result["config"]["tech_stack"] = index_result.get("tech_stack", [])
    cfg_result["config"]["frameworks"] = index_result.get("frameworks", [])
    dev_agent.save_project_config(cfg_result["config"])

    # Sync project_path to Neo4j
    active = dev_agent.get_active_project()
    active_pid = active.get("project_id")
    if active_pid:
        await _update_project_path_in_memory(active_pid, project_path)

    # Trigger the code-indexer to re-scan files (symbols, embeddings, etc.)
    try:
        await _notify_code_indexer_workspace(project_path, reindex=True)
        await _notify_tool_executor_workspace(project_path)
        await _notify_response_generator_workspace(project_path)
        logger.info("Code-indexer reindex triggered for %s", project_path)
    except Exception as e:
        logger.warning("Code-indexer reindex failed (non-fatal): %s", e)

    return {
        "success": True,
        "name": index_result["name"],
        "tech_stack": index_result["tech_stack"],
        "frameworks": index_result["frameworks"],
        "file_stats": index_result["file_stats"],
        "description": index_result["description"],
    }


# ── Per-project settings & activation endpoints ──────────────────────────

@app.post("/internal/dev-agent/project/activate")
async def activate_project(req: ActivateProjectRequest):
    """Set or clear the active project. Updates PROJECT_ROOT from project settings."""
    global PROJECT_ROOT
    result = dev_agent.set_active_project(req.project_id)
    if not result["success"]:
        return {"success": False, "error": result["error"]}

    # If activating (not deactivating), apply project_path as PROJECT_ROOT
    if req.project_id:
        settings_result = dev_agent.load_project_settings(req.project_id)
        project_settings = settings_result.get("settings") or {}
        project_path = project_settings.get("project_path")

        # If local settings don't have project_path, use the one from Neo4j (passed by gateway)
        if not project_path and req.project_path:
            project_path = req.project_path
            # Persist it locally so it survives future restarts
            project_settings["project_path"] = project_path
            dev_agent.save_project_settings(req.project_id, project_settings)
            logger.info("Saved project_path from Neo4j for project %s: %s", req.project_id, project_path)

        # Ensure Neo4j always has the resolved project_path (covers cases where
        # local settings had it but Neo4j was empty, or vice-versa)
        if project_path:
            await _update_project_path_in_memory(req.project_id, project_path)

        if project_path and os.path.isdir(project_path):
            PROJECT_ROOT = project_path
            os.environ["PROJECT_ROOT"] = project_path
            _svc_set_project_root(project_path)
            logger.info("Activated project %s → PROJECT_ROOT=%s", req.project_id, project_path)

            # Notify code indexer (with reindex), tool executor, and response-generator to switch workspace
            await _notify_code_indexer_workspace(project_path, reindex=True)
            await _notify_tool_executor_workspace(project_path)
            await _notify_response_generator_workspace(project_path)
        else:
            logger.warning("Project %s has no valid project_path (got: %s), keeping PROJECT_ROOT=%s", req.project_id, project_path, PROJECT_ROOT)

        # Reload shared settings so other services pick up overrides
        try:
            from packages.shared_utils.config import reload_settings  # noqa: F811
            reload_settings()
        except Exception:
            pass

    return {"success": True, "project_id": req.project_id, "project_root": PROJECT_ROOT}


@app.get("/internal/dev-agent/project/settings/{project_id}")
async def get_project_settings(project_id: str):
    """Return per-project settings."""
    result = dev_agent.load_project_settings(project_id)
    return result


@app.post("/internal/dev-agent/project/settings")
async def save_project_settings(req: SaveProjectSettingsRequest):
    """Save per-project settings. Also updates PROJECT_ROOT if this is the active project."""
    global PROJECT_ROOT
    result = dev_agent.save_project_settings(req.project_id, req.settings)
    if not result["success"]:
        return result

    # If this is the active project, apply project_path immediately
    active = dev_agent.get_active_project()
    if active.get("project_id") == req.project_id:
        project_path = req.settings.get("project_path")
        if project_path and os.path.isdir(project_path):
            PROJECT_ROOT = project_path
            os.environ["PROJECT_ROOT"] = project_path
            _svc_set_project_root(project_path)
            logger.info("Updated active project settings → PROJECT_ROOT=%s", project_path)
            # Sync to Neo4j
            await _update_project_path_in_memory(req.project_id, project_path)

        # Reload shared settings
        try:
            from packages.shared_utils.config import reload_settings  # noqa: F811
            reload_settings()
        except Exception:
            pass

    return {"success": True, "error": ""}


@app.get("/internal/dev-agent/project/active")
async def get_active_project():
    """Return the active project ID and its settings."""
    result = dev_agent.get_active_project_settings()
    resolved = _resolve_active_project_path() or PROJECT_ROOT
    return {
        "success": True,
        "project_id": result.get("project_id"),
        "settings": result.get("settings", {}),
        "project_root": resolved,
    }


@app.post("/internal/dev-agent/snapshots/create")
async def create_snapshot(req: CreateSnapshotRequest):
    result = await dev_agent.create_snapshot(
        session_id=req.session_id,
        iteration_count=req.iteration_count,
    )
    return result


@app.post("/internal/dev-agent/snapshots/restore")
async def restore_snapshot(req: RestoreSnapshotRequest):
    result = await dev_agent.restore_snapshot(
        snapshot_id=req.snapshot_id,
        session_id=req.session_id,
    )
    return result


@app.get("/internal/dev-agent/snapshots")
async def list_snapshots(session_id: str = Query(..., description="Session ID")):
    snapshots = await dev_agent.list_snapshots(session_id)
    return {"snapshots": snapshots}


@app.get("/internal/dev-agent/project/context")
async def get_project_context():
    """Return the generated .oasis-context.md content."""
    cfg_result = dev_agent.load_project_config()
    if not cfg_result["success"] or not cfg_result["config"]:
        return {"success": False, "content": "", "error": "No project configured."}

    context_path = Path(cfg_result["config"]["project_path"]) / ".oasis-context.md"
    if not context_path.exists():
        return {"success": False, "content": "", "error": ".oasis-context.md not found. Run /project/reindex first."}

    try:
        content = context_path.read_text(encoding="utf-8")
        return {"success": True, "content": content}
    except Exception as e:
        return {"success": False, "content": "", "error": str(e)}


# ── Cloudflare Tunnel management (for mobile companion) ────────────────────

class TunnelStartRequest(BaseModel):
    port: int = 8015


@app.post("/internal/dev-agent/tunnel/start")
async def start_tunnel(req: TunnelStartRequest):
    """Start a Cloudflare quick tunnel pointing at the mobile relay."""
    try:
        url = tunnel_manager.start(local_port=req.port)
        return {"success": True, "url": url}
    except RuntimeError as e:
        return {"success": False, "error": str(e)}


@app.delete("/internal/dev-agent/tunnel/stop")
async def stop_tunnel():
    """Stop the active Cloudflare tunnel."""
    tunnel_manager.stop()
    return {"success": True}


@app.get("/internal/dev-agent/tunnel/status")
async def tunnel_status():
    """Check Cloudflare tunnel status."""
    return tunnel_manager.status()


@app.get("/health")
async def health():
    import platform as _platform
    return {
        "status": "ok",
        "service": "dev-agent",
        "native": True,
        "platform": _platform.system().lower(),
        "tunnel": tunnel_manager.status(),
        "chrome_bridge": chrome_bridge.connected,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8008)
