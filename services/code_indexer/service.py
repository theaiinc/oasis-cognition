"""Code indexer service implementation."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from services.code_indexer.models import (
    SymbolSearchResult,
    SymbolWithRelationships,
    ComponentNode,
    IndexStatus,
    IndexResponse,
    SearchQuery,
)
from services.code_indexer.neo4j_client import CodeGraphClient
from services.code_indexer.parsers.base import BaseParser
from services.code_indexer.parsers.typescript import TypeScriptParser

logger = logging.getLogger(__name__)


class CodeIndexerService:
    """Main service for indexing and querying code."""

    def __init__(
        self,
        neo4j_uri: str,
        neo4j_user: str,
        neo4j_password: str,
        workspace_path: str = "/workspace",
    ) -> None:
        self._client = CodeGraphClient(neo4j_uri, neo4j_user, neo4j_password)
        self._workspace = Path(workspace_path)
        self._parsers: list[BaseParser] = [
            TypeScriptParser(),
        ]
        self._exclude_patterns = [
            'node_modules',
            '.git',
            'dist',
            'build',
            '.next',
            'coverage',
            '*.min.js',
            '*.d.ts',
        ]

    @property
    def parsers(self) -> list[BaseParser]:
        """Registered parsers (for file watcher)."""
        return self._parsers

    def _normalize_repo_path(self, file_path: Path) -> str:
        """Repo-relative posix path for Neo4j (matches /workspace layout)."""
        try:
            return file_path.resolve().relative_to(self._workspace.resolve()).as_posix()
        except ValueError:
            return str(file_path).replace("\\", "/")

    def index_file(self, file_path: Path, force: bool = False) -> bool:
        """Public API: index a single file (used by watcher)."""
        return self._index_file(file_path, force)

    def search_symbols(self, query: SearchQuery) -> SymbolSearchResult:
        """Search for symbols by name."""
        return self._client.search_symbols(
            query.q,
            query.type.value if query.type else None,
            query.limit,
        )

    def get_symbol(self, symbol_id: str) -> Symbol | None:
        """Get a symbol by ID."""
        return self._client.get_symbol(symbol_id)

    def get_symbol_with_relationships(self, symbol_id: str) -> SymbolWithRelationships | None:
        """Get symbol with all relationships."""
        return self._client.get_symbol_with_relationships(symbol_id)

    def get_component_hierarchy(self, root_name: str) -> ComponentNode | None:
        """Get component hierarchy."""
        return self._client.get_component_hierarchy(root_name)

    def get_index_status(self) -> IndexStatus:
        """Get indexing status."""
        return self._client.get_index_status()

    def get_full_graph(self, max_symbols: int = 300) -> dict:
        """Return all CodeFile + CodeSymbol nodes and relationships for the UI."""
        return self._client.get_full_graph(max_symbols=max_symbols)

    def index_path(self, path: str, force: bool = False) -> IndexResponse:
        """Index a file or directory."""
        start_time = time.time()
        target = self._workspace / path if not path.startswith('/') else Path(path)

        if not target.exists():
            return IndexResponse(indexed=0, removed=0, errors=[f"Path not found: {path}"])

        indexed = 0
        removed = 0
        errors = []

        if target.is_file():
            result = self._index_file(target, force)
            if result:
                indexed += 1
            else:
                errors.append(f"Failed to index: {target}")
        else:
            # Index directory
            for file_path in self._iter_source_files(target):
                try:
                    result = self._index_file(file_path, force)
                    if result:
                        indexed += 1
                    else:
                        errors.append(f"Failed to index: {file_path}")
                except Exception as e:
                    errors.append(f"Error indexing {file_path}: {e}")
                    logger.error("Error indexing %s: %s", file_path, e)

        duration_ms = int((time.time() - start_time) * 1000)
        return IndexResponse(indexed=indexed, removed=removed, errors=errors, duration_ms=duration_ms)

    def _index_file(self, file_path: Path, force: bool = False) -> bool:
        """Index a single file. Returns True if successful."""
        # Find appropriate parser
        parser = self._get_parser(file_path)
        if not parser:
            return False

        try:
            # Parse file
            result = parser.parse_file(file_path)

            if 'error' in result:
                logger.warning("Parse error for %s: %s", file_path, result['error'])
                return False

            norm_path = self._normalize_repo_path(file_path)
            file_info = result['file_info'].model_copy(update={"path": norm_path})
            symbols_norm = [
                s.model_copy(
                    update={
                        "file_path": norm_path,
                        "id": f"{norm_path}:{s.name}:{s.line_start}",
                    }
                )
                for s in result['symbols']
            ]
            result = {**result, "file_info": file_info, "symbols": symbols_norm}

            # Store in Neo4j
            file_info = result['file_info']

            # Check if already indexed with same hash
            if not force:
                existing = self._client.get_file(file_info.path)
                if existing and existing.content_hash == file_info.content_hash:
                    logger.debug("File unchanged, skipping: %s", file_path)
                    return True

            # Delete old data
            self._client.delete_file(file_info.path)

            # Store file
            self._client.store_file(file_info)

            # Store symbols
            for symbol in result['symbols']:
                self._client.store_symbol(symbol)

            # Store imports
            for import_info in result['imports']:
                self._client.store_import(file_info.path, import_info)

            logger.info("Indexed: %s (%d symbols)", file_path, len(result['symbols']))
            return True

        except Exception as e:
            logger.error("Error indexing %s: %s", file_path, e)
            return False

    def _get_parser(self, file_path: Path) -> BaseParser | None:
        """Get parser for a file."""
        for parser in self._parsers:
            if parser.can_parse(file_path):
                return parser
        return None

    def _iter_source_files(self, root: Path):
        """Iterate over source files to index."""
        for path in root.rglob('*'):
            if not path.is_file():
                continue

            # Check exclusions
            relative = str(path.relative_to(self._workspace))
            if path.name.endswith(".d.ts") or path.name.endswith(".min.js"):
                continue
            if any(p in relative for p in self._exclude_patterns if not p.startswith("*")):
                continue

            # Check if we have a parser
            if self._get_parser(path):
                yield path

    def full_reindex(self) -> IndexResponse:
        """Perform full reindex of workspace."""
        logger.info("Starting full reindex of %s", self._workspace)
        return self.index_path(str(self._workspace), force=True)

    def close(self) -> None:
        """Close connections."""
        self._client.close()
