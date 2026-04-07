"""Memory microservice — POST /internal/memory/store, GET /internal/memory/query"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from fastapi import FastAPI, Query
from pydantic import BaseModel

from packages.reasoning_schema.models import MemoryEntry, ReasoningGraph
from packages.shared_utils.config import get_settings
from packages.shared_utils.logging import setup_logging
from services.memory_service.service import MemoryService

logger = logging.getLogger(__name__)

_settings = get_settings()
memory = MemoryService(_settings)


class StoreGraphRequest(BaseModel):
    reasoning_graph: dict[str, Any]
    user_id: str = "default"
    session_id: str | None = None  # thread/session for retrieval
    walls: list[str] | None = None  # wall/aha moments — paths that don't exist, patterns that found nothing


class StoreNotAchievableRequest(BaseModel):
    goal: str
    reason: str
    suggestion: str = ""
    session_id: str | None = None
    user_id: str = "default"


class FeedbackRequest(BaseModel):
    session_id: str
    node_id: str = ""
    feedback_type: str = "correction"
    comment: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(_settings.log_level)
    logger.info("Memory service started (neo4j=%s)", _settings.neo4j_uri)
    yield
    memory.close()


app = FastAPI(title="Oasis Memory Service", lifespan=lifespan)


def _parse_created_at(created_at: Any) -> datetime | None:
    """Parse created_at from MemoryEntry (datetime or ISO string)."""
    if created_at is None:
        return None
    if isinstance(created_at, datetime):
        return created_at
    if isinstance(created_at, str):
        try:
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return None
    return None


@app.get("/internal/memory/query")
async def query_memory(
    q: str = Query(..., description="Search query"),
    limit: int = Query(10, ge=1, le=100),
    session_id: str | None = Query(None, description="Filter by session/thread"),
    max_age_hours: float | None = Query(None, description="If set, entries older than this are flagged as stale"),
):
    results = await memory.retrieve(q, limit=limit, session_id=session_id)
    max_h = max_age_hours if max_age_hours is not None else _settings.memory_max_age_hours
    now = datetime.now(timezone.utc)
    stale_count = 0
    for r in results:
        ct = _parse_created_at(r.created_at)
        if ct and ct.tzinfo is None:
            ct = ct.replace(tzinfo=timezone.utc)
        if ct and (now - ct).total_seconds() > max_h * 3600:
            stale_count += 1

    stale_hint = None
    if stale_count > 0:
        stale_hint = (
            f"Some memory entries ({stale_count}) are over {max_h:.0f} hours old. "
            "Verify against ground truth (re-read files, re-run commands, list_dir) before relying on them. "
            "Renew knowledge by re-executing tools and storing fresh results."
        )

    return {
        "query": q,
        "count": len(results),
        "results": [r.model_dump(mode="json") for r in results],
        "stale_count": stale_count,
        "stale_hint": stale_hint,
    }


@app.get("/internal/memory/nodes-by-tier")
async def query_nodes_by_tier(
    tier: str = Query(..., description="Graph tier: foundational or active"),
    session_id: str | None = Query(None, description="Filter by session"),
    limit: int = Query(50, ge=1, le=200),
):
    nodes = await memory.retrieve_nodes_by_tier(tier, session_id=session_id, limit=limit)
    return {"tier": tier, "count": len(nodes), "nodes": nodes}


@app.get("/internal/memory/rules")
async def get_rules(
    keywords: str | None = Query(None, description="Comma-separated keywords to filter rules by relevance (e.g. 'worktree,code graph')"),
):
    kw_list = [k.strip() for k in keywords.split(",") if k.strip()] if keywords else None
    rules = await memory.retrieve_rules(keywords=kw_list)
    return {"count": len(rules), "rules": rules, "storage": memory.storage_backend, "filtered_by": kw_list}


@app.get("/internal/memory/rules/graph")
async def get_rules_graph():
    """Return rules as a connected graph (nodes + edges) for visualization."""
    graph = await memory.retrieve_rules_graph()
    return graph


@app.post("/internal/memory/store")
async def store_graph(req: StoreGraphRequest):
    graph = ReasoningGraph(**req.reasoning_graph)
    await memory.store_graph(graph, req.user_id, session_id=req.session_id, walls=req.walls)
    return {"status": "ok", "graph_id": graph.id}


@app.post("/internal/memory/store-not-achievable")
async def store_not_achievable(req: StoreNotAchievableRequest):
    await memory.store_not_achievable(
        goal=req.goal,
        reason=req.reason,
        suggestion=req.suggestion,
        session_id=req.session_id,
        user_id=req.user_id,
    )
    return {"status": "ok"}


@app.post("/internal/memory/feedback")
async def submit_feedback(req: FeedbackRequest):
    await memory.apply_feedback(
        session_id=req.session_id,
        node_id=req.node_id,
        feedback_type=req.feedback_type,
        comment=req.comment,
    )
    return {"status": "ok", "message": f"Feedback recorded ({req.feedback_type})"}


class StoreTeachingRequest(BaseModel):
    assertion: str
    category: str = "rule"
    domain: str = ""
    confidence: float = 0.5
    supporting_sources: list[dict[str, Any]] = []
    underlying_concept: str = ""


class DeleteRuleRequest(BaseModel):
    rule_id: str


class UpdateRuleRequest(BaseModel):
    rule_id: str
    condition: str | None = None
    conclusion: str | None = None
    confidence: float | None = None


@app.delete("/internal/memory/rules")
async def delete_rule(req: DeleteRuleRequest):
    """Delete a rule."""
    await memory.delete_rule(req.rule_id)
    return {"status": "ok"}


@app.patch("/internal/memory/rules")
async def update_rule(req: UpdateRuleRequest):
    """Update a rule."""
    await memory.update_rule(req.rule_id, condition=req.condition, conclusion=req.conclusion, confidence=req.confidence)
    return {"status": "ok"}


@app.post("/internal/memory/teach")
async def store_teaching(req: StoreTeachingRequest):
    """Store a validated teaching assertion as both a Rule and a semantic Memory."""
    from packages.reasoning_schema.enums import MemoryType as MT
    # Never use assertion as both IF and THEN: empty underlying_concept used to fall back to
    # assertion via `or`, which made condition == conclusion in the rules graph.
    # Also if the teacher repeats the same text for IF and THEN, treat IF as missing.
    _concept = (req.underlying_concept or "").strip()
    _assertion = (req.assertion or "").strip()
    if _concept and _concept.casefold() != _assertion.casefold():
        condition_for_rule = _concept
    else:
        condition_for_rule = "General applicability"

    await memory.store_rule(
        condition=condition_for_rule,
        conclusion=req.assertion,
        confidence=req.confidence,
    )
    entry = MemoryEntry(
        memory_type=MT.SEMANTIC,
        content={
            "type": "teaching",
            "assertion": req.assertion,
            "category": req.category,
            "domain": req.domain,
            "sources": req.supporting_sources,
            "concept": req.underlying_concept,
        },
        tags=["teaching", req.category, req.domain] if req.domain else ["teaching", req.category],
    )
    await memory.store(entry)
    return {"status": "ok", "memory_id": entry.memory_id}

class PendingTeachingState(BaseModel):
    session_id: str
    assertion: dict[str, Any] | None = None
    search_query: str = ""
    validation: dict[str, Any] | None = None


@app.get("/internal/memory/teaching/pending")
async def get_pending_teaching(session_id: str = Query(...)):
    state = await memory.get_pending_teaching(session_id)
    return {"session_id": session_id, "pending": state}


@app.post("/internal/memory/teaching/pending")
async def set_pending_teaching(req: PendingTeachingState):
    await memory.set_pending_teaching(
        req.session_id,
        payload={
            "assertion": req.assertion or {},
            "search_query": req.search_query,
            "validation": req.validation or {},
        },
    )
    return {"status": "ok"}


@app.delete("/internal/memory/teaching/pending")
async def clear_pending_teaching(session_id: str = Query(...)):
    await memory.clear_pending_teaching(session_id)
    return {"status": "ok"}


class PendingSelfTeachingState(BaseModel):
    self_teaching_id: str
    topic: str
    rules_snapshot_id: str | None = None
    llm_thoughts: list[dict[str, Any]] = []
    logic_solution: dict[str, Any] = {}
    teaching_plan: dict[str, Any] = {}


@app.get("/internal/memory/self-teaching/pending")
async def get_pending_self_teaching(self_teaching_id: str = Query(...)):
    return await memory.get_pending_self_teaching(self_teaching_id) or {}


@app.post("/internal/memory/self-teaching/pending")
async def set_pending_self_teaching(req: PendingSelfTeachingState):
    await memory.set_pending_self_teaching(
        req.self_teaching_id,
        payload={
            "topic": req.topic,
            "rules_snapshot_id": req.rules_snapshot_id,
            "llm_thoughts": req.llm_thoughts,
            "logic_solution": req.logic_solution,
            "teaching_plan": req.teaching_plan,
        },
    )
    return {"status": "ok"}


@app.delete("/internal/memory/self-teaching/pending")
async def clear_pending_self_teaching(self_teaching_id: str = Query(...)):
    await memory.clear_pending_self_teaching(self_teaching_id)
    return {"status": "ok"}


class SnapshotRulesRequest(BaseModel):
    session_id: str


class RestoreRulesRequest(BaseModel):
    snapshot_id: str


class DedupeRulesRequest(BaseModel):
    dry_run: bool = False


@app.post("/internal/memory/rules/snapshot")
async def snapshot_rules(req: SnapshotRulesRequest):
    """Create a snapshot of all current rules before a self-teaching session."""
    snapshot = await memory.snapshot_rules(req.session_id)
    return {"status": "ok", **snapshot}


@app.post("/internal/memory/rules/restore")
async def restore_rules(req: RestoreRulesRequest):
    """Restore rules from a snapshot."""
    result = await memory.restore_rules_snapshot(req.snapshot_id)
    return result


@app.post("/internal/memory/rules/dedupe")
async def dedupe_rules(req: DedupeRulesRequest):
    """Deduplicate Rule nodes by normalized (condition, conclusion)."""
    return await memory.dedupe_rules(dry_run=req.dry_run)


@app.get("/internal/memory/code/symbols")
async def code_symbols_search(
    q: str = Query(..., description="Symbol name or path substring"),
    type: str | None = Query(None, description="Optional: function, class, interface, type, ..."),
    limit: int = Query(10, ge=1, le=100),
    path_prefix: str | None = Query(None, description="Comma-separated path prefixes to scope results (e.g. 'services/code_indexer,apps/oasis-ui-react')"),
):
    """Search indexed code symbols (Neo4j CodeSymbol). Requires code-indexer to have run at least once."""
    prefixes = [p.strip() for p in path_prefix.split(",") if p.strip()] if path_prefix else None
    symbols = await memory.search_code_symbols(q, symbol_type=type, limit=limit, path_prefixes=prefixes)
    return {"query": q, "count": len(symbols), "symbols": symbols, "scope": prefixes}


@app.get("/internal/memory/code/references")
async def code_symbol_references(symbol_id: str = Query(..., description="Symbol id, e.g. path:name:line")):
    refs = await memory.get_symbol_references(symbol_id)
    return {"symbol_id": symbol_id, "count": len(refs), "references": refs}


@app.get("/internal/memory/code/hierarchy")
async def code_component_hierarchy(root: str = Query(..., description="Root component / symbol name")):
    nodes = await memory.get_component_hierarchy(root)
    return {"root": root, "count": len(nodes), "nodes": nodes}


@app.get("/internal/memory/code/imports")
async def code_file_imports(path: str = Query(..., description="Repo-relative file path")):
    imports = await memory.get_imports_for_file(path)
    return {"path": path, "count": len(imports), "imports": imports}


# ── Artifact Library: Project endpoints ──────────────────────────────

class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""
    project_path: str = ""


class UpdateProjectRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    project_path: str | None = None


class LinkArtifactRequest(BaseModel):
    artifact_id: str


class LinkChatRequest(BaseModel):
    session_id: str


class CreateRepoRequest(BaseModel):
    git_url: str
    project_path: str = ""
    name: str = ""


class LinkRepoRequest(BaseModel):
    repo_id: str


class ScopeRuleRequest(BaseModel):
    rule_id: str
    project_id: str


@app.post("/internal/memory/projects")
async def create_project(req: CreateProjectRequest):
    project = await memory.create_project(req.name, req.description, req.project_path)
    return {"status": "ok", "project": project}


@app.get("/internal/memory/projects")
async def list_projects():
    projects = await memory.list_projects()
    return {"count": len(projects), "projects": projects}


@app.get("/internal/memory/projects/{project_id}")
async def get_project(project_id: str):
    project = await memory.get_project(project_id)
    if not project:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@app.patch("/internal/memory/projects/{project_id}")
async def update_project(project_id: str, req: UpdateProjectRequest):
    ok = await memory.update_project(project_id, name=req.name, description=req.description, project_path=req.project_path)
    if not ok:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Project not found")
    return {"status": "ok"}


@app.delete("/internal/memory/projects/{project_id}")
async def delete_project(project_id: str):
    ok = await memory.delete_project(project_id)
    return {"status": "ok", "deleted": ok}


@app.post("/internal/memory/projects/{project_id}/artifacts")
async def link_artifact_to_project(project_id: str, req: LinkArtifactRequest):
    await memory.link_artifact_to_project(project_id, req.artifact_id)
    return {"status": "ok"}


@app.delete("/internal/memory/projects/{project_id}/artifacts/{artifact_id}")
async def unlink_artifact_from_project(project_id: str, artifact_id: str):
    await memory.unlink_artifact_from_project(project_id, artifact_id)
    return {"status": "ok"}


@app.post("/internal/memory/projects/{project_id}/chats")
async def link_chat_to_project(project_id: str, req: LinkChatRequest):
    await memory.link_chat_to_project(project_id, req.session_id)
    return {"status": "ok"}


@app.delete("/internal/memory/projects/{project_id}/chats/{session_id}")
async def unlink_chat_from_project(project_id: str, session_id: str):
    await memory.unlink_chat_from_project(project_id, session_id)
    return {"status": "ok"}


@app.post("/internal/memory/repos")
async def create_repo(req: CreateRepoRequest):
    repo = await memory.create_repo(req.git_url, req.project_path, req.name)
    return {"status": "ok", "repo": repo}


@app.post("/internal/memory/projects/{project_id}/repos")
async def link_repo_to_project(project_id: str, req: LinkRepoRequest):
    await memory.link_repo_to_project(project_id, req.repo_id)
    return {"status": "ok"}


@app.delete("/internal/memory/projects/{project_id}/repos/{repo_id}")
async def unlink_repo_from_project(project_id: str, repo_id: str):
    await memory.unlink_repo_from_project(project_id, repo_id)
    return {"status": "ok"}


@app.get("/internal/memory/projects/{project_id}/rules")
async def get_project_rules(
    project_id: str,
    keywords: str | None = Query(None),
):
    kw_list = [k.strip() for k in keywords.split(",") if k.strip()] if keywords else None
    rules = await memory.retrieve_rules_for_project(project_id, keywords=kw_list)
    return {"count": len(rules), "rules": rules, "project_id": project_id}


@app.post("/internal/memory/rules/scope")
async def scope_rule_to_project(req: ScopeRuleRequest):
    await memory.scope_rule_to_project(req.rule_id, req.project_id)
    return {"status": "ok"}


@app.get("/internal/memory/projects/{project_id}/chats")
async def get_project_chats(project_id: str):
    sessions = await memory.get_project_chat_sessions(project_id)
    return {"count": len(sessions), "session_ids": sessions}


# ── Artifact Library: Artifact endpoints ─────────────────────────────

class CreateArtifactRequest(BaseModel):
    name: str
    mime_type: str
    file_path: str
    file_size: int
    source_type: str = "upload"
    source_url: str | None = None
    language: str | None = None


class UpdateArtifactRequest(BaseModel):
    status: str | None = None
    transcript: str | None = None
    summary: str | None = None
    language: str | None = None
    name: str | None = None
    mime_type: str | None = None


@app.post("/internal/memory/artifacts")
async def create_artifact(req: CreateArtifactRequest):
    artifact = await memory.create_artifact(
        name=req.name, mime_type=req.mime_type, file_path=req.file_path,
        file_size=req.file_size, source_type=req.source_type,
        source_url=req.source_url, language=req.language,
    )
    return {"status": "ok", "artifact": artifact}


@app.get("/internal/memory/artifacts/{artifact_id}")
async def get_artifact(artifact_id: str):
    artifact = await memory.get_artifact(artifact_id)
    if not artifact:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Artifact not found")
    return artifact


@app.get("/internal/memory/artifacts")
async def list_artifacts(project_id: str | None = Query(None)):
    artifacts = await memory.list_artifacts(project_id=project_id)
    return {"count": len(artifacts), "artifacts": artifacts}


@app.patch("/internal/memory/artifacts/{artifact_id}")
async def update_artifact(artifact_id: str, req: UpdateArtifactRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    ok = await memory.update_artifact(artifact_id, **updates)
    if not ok:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Artifact not found")
    return {"status": "ok"}


@app.delete("/internal/memory/artifacts/{artifact_id}")
async def delete_artifact(artifact_id: str):
    ok = await memory.delete_artifact(artifact_id)
    return {"status": "ok", "deleted": ok}


# ── Artifact Library: Embedding endpoints ────────────────────────────

class StoreEmbeddingRequest(BaseModel):
    artifact_id: str
    chunk_index: int
    chunk_text: str
    vector: list[float]
    model: str


class SearchEmbeddingsRequest(BaseModel):
    query_vector: list[float]
    limit: int = 10
    project_id: str | None = None


@app.post("/internal/memory/embeddings")
async def store_embedding(req: StoreEmbeddingRequest):
    eid = await memory.store_embedding(
        req.artifact_id, req.chunk_index, req.chunk_text, req.vector, req.model,
    )
    return {"status": "ok", "embedding_id": eid}


@app.post("/internal/memory/embeddings/search")
async def search_embeddings(req: SearchEmbeddingsRequest):
    results = await memory.search_embeddings(req.query_vector, limit=req.limit, project_id=req.project_id)
    return {"count": len(results), "results": results}


# ── Speaker Profile endpoints ──────────────────────────────────────────

class CreateSpeakerRequest(BaseModel):
    name: str
    embedding: list[float]
    source_artifact_id: str | None = None


class UpdateSpeakerRequest(BaseModel):
    name: str | None = None
    embedding: list[float] | None = None
    sample_count: int | None = None


class IdentifySpeakerRequest(BaseModel):
    embedding: list[float]
    threshold: float = 0.65


@app.post("/internal/memory/speakers")
async def create_speaker(req: CreateSpeakerRequest):
    speaker = await memory.create_speaker_profile(
        name=req.name, embedding=req.embedding,
        source_artifact_id=req.source_artifact_id,
    )
    return {"status": "ok", "speaker": speaker}


@app.get("/internal/memory/speakers")
async def list_speakers():
    speakers = await memory.list_speaker_profiles()
    return {"count": len(speakers), "speakers": speakers}


@app.get("/internal/memory/speakers/{speaker_id}")
async def get_speaker(speaker_id: str):
    speaker = await memory.get_speaker_profile(speaker_id)
    if not speaker:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Speaker profile not found")
    return speaker


@app.patch("/internal/memory/speakers/{speaker_id}")
async def update_speaker(speaker_id: str, req: UpdateSpeakerRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    ok = await memory.update_speaker_profile(speaker_id, **updates)
    if not ok:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Speaker profile not found")
    return {"status": "ok"}


@app.delete("/internal/memory/speakers/{speaker_id}")
async def delete_speaker(speaker_id: str):
    ok = await memory.delete_speaker_profile(speaker_id)
    return {"status": "ok", "deleted": ok}


@app.post("/internal/memory/speakers/identify")
async def identify_speaker(req: IdentifySpeakerRequest):
    matches = await memory.search_speaker_by_embedding(
        req.embedding, threshold=req.threshold,
    )
    return {"count": len(matches), "matches": matches}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "memory-service"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8004)
