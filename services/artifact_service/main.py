"""Artifact Service — FastAPI app for file upload, processing, and search.

Port 8012. Stores files locally, delegates metadata to memory-service (Neo4j).
Processing pipeline: extract text / transcribe → generate embeddings.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI, File, Form, Query, UploadFile, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from packages.shared_utils.config import get_settings
from packages.shared_utils.logging import setup_logging
from services.artifact_service.service import ArtifactService
from services.artifact_service.storage import LocalStorage

logger = logging.getLogger(__name__)

_settings = get_settings()
_storage = LocalStorage(_settings.artifact_storage_path)
_service = ArtifactService(_storage, memory_url=os.environ.get("MEMORY_URL", "http://localhost:8004"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info("Artifact service started (storage=%s)", _settings.artifact_storage_path)

    # Start the processing worker
    await _service.start_worker()

    # Recover stuck artifacts from previous crashes — re-enqueue them
    try:
        artifacts = await _service.list_artifacts()
        stuck = [a for a in artifacts if a.get("status") in ("processing", "queued")]
        for a in stuck:
            aid = a["artifact_id"]
            logger.warning("Recovering stuck artifact %s (was %s) — re-enqueuing", aid, a.get("status"))
            await _service._mem_patch(f"/internal/memory/artifacts/{aid}", {"status": "pending"})
            await _service.enqueue(aid)
        if stuck:
            logger.info("Re-enqueued %d stuck artifacts", len(stuck))
    except Exception as e:
        logger.warning("Startup recovery failed: %s", e)

    yield

    # Shutdown worker
    await _service.stop_worker()


app = FastAPI(title="Oasis Artifact Service", lifespan=lifespan)


# ── Upload ──────────────────────────────────────────────────────────────

@app.post("/internal/artifacts/upload")
async def upload_artifact(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    project_id: str | None = Form(None),
):
    """Upload a file and create an Artifact node."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    artifact = await _service.upload(file.filename, file, language=language, project_id=project_id)
    return {"status": "ok", "artifact": artifact}


@app.post("/internal/artifacts/youtube")
async def upload_youtube(
    url: str = Form(...),
    language: str | None = Form(None),
    project_id: str | None = Form(None),
):
    """Download a YouTube video and create an Artifact node."""
    artifact = await _service.upload_youtube(url, language=language, project_id=project_id)
    return {"status": "ok", "artifact": artifact}


# ── SSE Events (must be before {artifact_id} routes) ──────────────────

@app.get("/internal/artifacts/events")
async def artifact_events():
    """SSE stream of artifact status changes."""
    q = _service.subscribe()

    async def generate():
        try:
            # Send initial snapshot
            snapshot = _service.get_queue_status()
            yield f"data: {json.dumps({'event': 'snapshot', **snapshot})}\n\n"
            # Stream updates
            while True:
                data = await q.get()
                yield f"data: {json.dumps(data)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _service.unsubscribe(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Queue Status ───────────────────────────────────────────────────────

@app.get("/internal/artifacts/queue")
async def queue_status():
    """Current processing queue state."""
    return _service.get_queue_status()


# ── Search (must be before {artifact_id} routes) ──────────────────────

@app.get("/internal/artifacts/search")
async def search_artifacts(
    q: str = Query(..., description="Search query"),
    limit: int = Query(10, ge=1, le=100),
    project_id: str | None = Query(None),
):
    """Semantic search across artifact embeddings."""
    results = await _service.search(q, limit=limit, project_id=project_id)
    return {"query": q, "count": len(results), "results": results}


# ── CRUD ────────────────────────────────────────────────────────────────

@app.get("/internal/artifacts")
async def list_artifacts(project_id: str | None = Query(None)):
    artifacts = await _service.list_artifacts(project_id=project_id)
    return {"count": len(artifacts), "artifacts": artifacts}


@app.get("/internal/artifacts/{artifact_id}")
async def get_artifact(artifact_id: str):
    artifact = await _service.get_artifact(artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return artifact


@app.delete("/internal/artifacts/{artifact_id}")
async def delete_artifact(artifact_id: str):
    ok = await _service.delete_artifact(artifact_id)
    return {"status": "ok", "deleted": ok}


# ── File download ───────────────────────────────────────────────────────

@app.get("/internal/artifacts/{artifact_id}/file")
async def download_file(artifact_id: str):
    """Download the raw file for an artifact."""
    artifact = await _service.get_artifact(artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    file_path = _service.get_file_path(artifact.get("file_path", ""))
    if not file_path:
        raise HTTPException(status_code=404, detail="File not found on disk")
    mime = artifact.get("mime_type", "")
    name = artifact.get("name", "download")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    EXT_MIME = {
        "m4a": "audio/mp4", "mp3": "audio/mpeg", "wav": "audio/wav",
        "ogg": "audio/ogg", "flac": "audio/flac", "aac": "audio/aac",
        "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    }
    if not mime or mime == "application/octet-stream":
        mime = EXT_MIME.get(ext, mime or "application/octet-stream")
    return FileResponse(str(file_path), filename=name, media_type=mime)


# ── Processing ──────────────────────────────────────────────────────────

@app.post("/internal/artifacts/{artifact_id}/process")
async def process_artifact(artifact_id: str):
    """Enqueue artifact for processing (transcribe → embed)."""
    artifact = await _service.get_artifact(artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    await _service.enqueue(artifact_id)
    return {"status": "queued", "artifact_id": artifact_id}


# ── Summarize ──────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    language: str = ""
    instructions: str = ""

@app.post("/internal/artifacts/{artifact_id}/summarize")
async def summarize_artifact(artifact_id: str, req: SummarizeRequest | None = None):
    """Generate a summary of the artifact's transcript/text."""
    body = req or SummarizeRequest()
    result = await _service.summarize_artifact(artifact_id, language=body.language,
                                                instructions=body.instructions)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Health ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "artifact-service"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8012)
