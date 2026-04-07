"""FastAPI app for code indexer service."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException

from services.code_indexer.models import (
    SymbolSearchResult,
    SymbolWithRelationships,
    ComponentNode,
    IndexStatus,
    IndexResponse,
    SearchQuery,
    IndexRequest,
    SymbolType,
)
from services.code_indexer.service import CodeIndexerService
from services.code_indexer.watcher import CodeIndexerWatcher

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_indexer: CodeIndexerService | None = None
_watcher: CodeIndexerWatcher | None = None


def get_indexer() -> CodeIndexerService:
    global _indexer
    if _indexer is None:
        neo4j_uri = os.getenv("OASIS_NEO4J_URI", "bolt://neo4j:7687")
        neo4j_user = os.getenv("OASIS_NEO4J_USER", "neo4j")
        neo4j_password = os.getenv("OASIS_NEO4J_PASSWORD", "oasis-cognition")
        workspace = os.getenv("OASIS_WORKSPACE_PATH", "/workspace")
        _indexer = CodeIndexerService(
            neo4j_uri=neo4j_uri,
            neo4j_user=neo4j_user,
            neo4j_password=neo4j_password,
            workspace_path=workspace,
        )
    return _indexer


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _watcher
    logger.info("Code indexer starting...")
    indexer = get_indexer()

    if os.getenv("OASIS_CODE_INDEXER_INDEX_ON_START", "false").lower() == "true":
        try:
            logger.info("Auto-indexing workspace...")
            result = indexer.full_reindex()
            logger.info("Auto-index complete: %d files indexed", result.indexed)
        except Exception as e:
            logger.error("Auto-index failed: %s", e)

    if os.getenv("OASIS_CODE_INDEXER_WATCH", "false").lower() == "true":
        workspace = os.getenv("OASIS_WORKSPACE_PATH", "/workspace")
        _watcher = CodeIndexerWatcher(indexer, workspace_path=workspace)
        _watcher.start()

    yield

    if _watcher is not None:
        _watcher.stop()
        _watcher = None
    if _indexer is not None:
        _indexer.close()
        logger.info("Code indexer shutdown")


app = FastAPI(
    title="Code Indexer Service",
    description="Indexes and queries code knowledge graph",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, Any]:
    try:
        indexer = get_indexer()
        status = indexer.get_index_status()
        return {
            "status": "ok",
            "service": "code-indexer",
            "indexed_files": status.indexed_files,
            "indexed_symbols": status.indexed_symbols,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/symbols/search", response_model=SymbolSearchResult)
async def search_symbols(q: str, type: str | None = None, limit: int = 10) -> SymbolSearchResult:
    try:
        indexer = get_indexer()
        symbol_type = SymbolType(type) if type else None
        query = SearchQuery(q=q, type=symbol_type, limit=limit)
        return indexer.search_symbols(query)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid symbol type: {e}") from e
    except Exception as e:
        logger.error("Search failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/symbols/{symbol_id:path}/relationships")
async def get_symbol_relationships(symbol_id: str) -> SymbolWithRelationships:
    try:
        indexer = get_indexer()
        result = indexer.get_symbol_with_relationships(symbol_id)
        if not result:
            raise HTTPException(status_code=404, detail="Symbol not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Get relationships failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/symbols/{symbol_id:path}")
async def get_symbol(symbol_id: str) -> dict[str, Any]:
    try:
        indexer = get_indexer()
        symbol = indexer.get_symbol(symbol_id)
        if not symbol:
            raise HTTPException(status_code=404, detail="Symbol not found")
        return {"symbol": symbol}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Get symbol failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/graph/component-hierarchy")
async def get_component_hierarchy(root: str) -> ComponentNode:
    try:
        indexer = get_indexer()
        result = indexer.get_component_hierarchy(root)
        if not result:
            raise HTTPException(status_code=404, detail="Root component not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Get hierarchy failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/index/status", response_model=IndexStatus)
async def get_index_status() -> IndexStatus:
    try:
        return get_indexer().get_index_status()
    except Exception as e:
        logger.error("Get status failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/index", response_model=IndexResponse)
async def index_path(request: IndexRequest) -> IndexResponse:
    try:
        return get_indexer().index_path(request.path, request.force)
    except Exception as e:
        logger.error("Index failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/index/full", response_model=IndexResponse)
async def full_reindex() -> IndexResponse:
    try:
        return get_indexer().full_reindex()
    except Exception as e:
        logger.error("Full reindex failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/graph")
async def get_full_code_graph(max_symbols: int = 300) -> dict[str, Any]:
    """Return all CodeFile + CodeSymbol nodes and their relationships for the UI."""
    try:
        return get_indexer().get_full_graph(max_symbols=max_symbols)
    except Exception as e:
        logger.error("Get code graph failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/workspace/switch")
async def switch_workspace(body: dict[str, Any]) -> dict[str, Any]:
    """Switch the indexer workspace path (called when a project is activated).

    Expects: {"workspace_path": "/path/to/project"}
    Optionally: {"reindex": true} to trigger a full reindex after switching.
    """
    global _indexer, _watcher
    new_path = body.get("workspace_path")
    if not new_path:
        raise HTTPException(status_code=400, detail="workspace_path is required")

    from pathlib import Path as _Path
    workspace = _Path(new_path)
    if not workspace.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {new_path}")

    # Stop existing watcher if running
    if _watcher is not None:
        _watcher.stop()
        _watcher = None

    # Update the indexer's workspace
    indexer = get_indexer()
    indexer._workspace = workspace
    logger.info("Workspace switched to: %s", new_path)

    # Optionally reindex
    if body.get("reindex", False):
        try:
            result = indexer.full_reindex()
            return {"success": True, "workspace_path": new_path, "indexed": result.indexed}
        except Exception as e:
            logger.error("Reindex after workspace switch failed: %s", e)
            return {"success": True, "workspace_path": new_path, "reindex_error": str(e)}

    # Restart watcher on new workspace if watching was enabled
    if os.getenv("OASIS_CODE_INDEXER_WATCH", "false").lower() == "true":
        _watcher = CodeIndexerWatcher(indexer, workspace_path=new_path)
        _watcher.start()

    return {"success": True, "workspace_path": new_path}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8010"))
    uvicorn.run(app, host="0.0.0.0", port=port)
