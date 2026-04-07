"""Neo4j client for code indexing."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from neo4j import GraphDatabase

from services.code_indexer.models import (
    File,
    Symbol,
    ImportInfo,
    SymbolSearchResult,
    SymbolWithRelationships,
    SymbolReference,
    ComponentNode,
    IndexStatus,
)

logger = logging.getLogger(__name__)


class CodeGraphClient:
    """Client for code knowledge graph operations in Neo4j."""

    def __init__(self, uri: str, user: str, password: str) -> None:
        self._driver = GraphDatabase.driver(uri, auth=(user, password))
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        """Create constraints and indexes."""
        with self._driver.session() as session:
            # Constraints
            session.run("CREATE CONSTRAINT code_file_path IF NOT EXISTS FOR (f:CodeFile) REQUIRE f.path IS UNIQUE")
            session.run("CREATE CONSTRAINT code_symbol_id IF NOT EXISTS FOR (s:CodeSymbol) REQUIRE s.id IS UNIQUE")
            # CodeModule: no unique on name (relative imports can collide across packages)
            session.run("CREATE INDEX code_module_name IF NOT EXISTS FOR (m:CodeModule) ON (m.name)")

            # Indexes
            session.run("CREATE INDEX code_symbol_name IF NOT EXISTS FOR (s:CodeSymbol) ON (s.name)")
            session.run("CREATE INDEX code_symbol_type IF NOT EXISTS FOR (s:CodeSymbol) ON (s.type)")
            session.run("CREATE INDEX code_file_language IF NOT EXISTS FOR (f:CodeFile) ON (f.language)")

    def close(self) -> None:
        self._driver.close()

    def get_full_graph(
        self,
        max_symbols: int = 300,
    ) -> dict:
        """Return all CodeFile + CodeSymbol nodes and their relationships.

        Returns a dict with:
          nodes: list of {id, label, node_type, file_path, line}
          edges: list of {source, target, rel}
          stats: {files, symbols}
        """
        nodes: list[dict] = []
        edges: list[dict] = []
        seen_nodes: set[str] = set()

        with self._driver.session() as session:
            # ── Files ──────────────────────────────────────────────────────
            file_result = session.run(
                "MATCH (f:CodeFile) RETURN f.path AS path, f.name AS name ORDER BY f.path"
            )
            file_paths: list[str] = []
            for rec in file_result:
                fid = rec["path"]
                if fid not in seen_nodes:
                    seen_nodes.add(fid)
                    nodes.append({
                        "id": fid,
                        "label": rec["name"] or fid.split("/")[-1],
                        "node_type": "CodeFile",
                        "file_path": fid,
                    })
                    file_paths.append(fid)
            file_count = len(file_paths)

            # ── Symbols (capped) ───────────────────────────────────────────
            sym_result = session.run(
                """
                MATCH (s:CodeSymbol)
                RETURN s.id AS id, s.name AS name, s.type AS type,
                       s.file_path AS file_path, s.line_start AS line
                ORDER BY s.file_path, s.line_start
                LIMIT $limit
                """,
                limit=max_symbols,
            )
            symbol_count = 0
            for rec in sym_result:
                sid = rec["id"]
                if sid and sid not in seen_nodes:
                    seen_nodes.add(sid)
                    nodes.append({
                        "id": sid,
                        "label": rec["name"] or sid,
                        "node_type": rec["type"] or "symbol",
                        "file_path": rec["file_path"] or "",
                        "line": rec["line"] or 0,
                    })
                    symbol_count += 1

            # ── CONTAINS edges (File → Symbol) ─────────────────────────────
            contains_result = session.run(
                """
                MATCH (f:CodeFile)-[:CONTAINS]->(s:CodeSymbol)
                RETURN f.path AS file_path, s.id AS symbol_id
                """
            )
            for rec in contains_result:
                src = rec["file_path"]
                tgt = rec["symbol_id"]
                if src in seen_nodes and tgt in seen_nodes:
                    edges.append({"source": src, "target": tgt, "rel": "CONTAINS"})

            # ── IMPORTS edges (File → Module or File) ──────────────────────
            imports_result = session.run(
                """
                MATCH (f:CodeFile)-[r:IMPORTS]->(m:CodeModule)
                RETURN f.path AS from_path, m.name AS to_name
                """
            )
            for rec in imports_result:
                src = rec["from_path"]
                tgt_name = rec["to_name"]
                if src in seen_nodes and tgt_name:
                    # Try to match to a known file path
                    matched = next((fp for fp in file_paths if fp.endswith(tgt_name)), None)
                    tgt = matched or tgt_name
                    edges.append({"source": src, "target": tgt, "rel": "IMPORTS"})

            # ── CALLS edges (Symbol → Symbol) ──────────────────────────────
            calls_result = session.run(
                """
                MATCH (a:CodeSymbol)-[:CALLS]->(b:CodeSymbol)
                RETURN a.id AS src, b.id AS tgt
                LIMIT 500
                """
            )
            for rec in calls_result:
                src, tgt = rec["src"], rec["tgt"]
                if src in seen_nodes and tgt in seen_nodes:
                    edges.append({"source": src, "target": tgt, "rel": "CALLS"})

            # ── EXTENDS / IMPLEMENTS edges ─────────────────────────────────
            for rel_type in ("EXTENDS", "IMPLEMENTS"):
                rel_result = session.run(
                    f"""
                    MATCH (a:CodeSymbol)-[:{rel_type}]->(b:CodeSymbol)
                    RETURN a.id AS src, b.id AS tgt
                    """
                )
                for rec in rel_result:
                    src, tgt = rec["src"], rec["tgt"]
                    if src in seen_nodes and tgt in seen_nodes:
                        edges.append({"source": src, "target": tgt, "rel": rel_type})

        return {
            "nodes": nodes,
            "edges": edges,
            "stats": {"files": file_count, "symbols": symbol_count},
        }

    def store_file(self, file: File) -> None:
        """Store or update a file node."""
        with self._driver.session() as session:
            session.run(
                """
                MERGE (f:CodeFile {path: $path})
                SET f.name = $name,
                    f.language = $language,
                    f.content_hash = $content_hash,
                    f.last_indexed = $last_indexed,
                    f.line_count = $line_count,
                    f.is_test = $is_test,
                    f.is_entry_point = $is_entry_point
                """,
                path=file.path,
                name=file.name,
                language=file.language,
                content_hash=file.content_hash,
                last_indexed=file.last_indexed.isoformat(),
                line_count=file.line_count,
                is_test=file.is_test,
                is_entry_point=file.is_entry_point,
            )

    def store_symbol(self, symbol: Symbol) -> None:
        """Store or update a symbol node."""
        with self._driver.session() as session:
            session.run(
                """
                MERGE (s:CodeSymbol {id: $id})
                SET s.name = $name,
                    s.type = $type,
                    s.file_path = $file_path,
                    s.signature = $signature,
                    s.docstring = $docstring,
                    s.line_start = $line_start,
                    s.line_end = $line_end,
                    s.column_start = $column_start,
                    s.column_end = $column_end,
                    s.is_exported = $is_exported,
                    s.is_default_export = $is_default_export,
                    s.visibility = $visibility
                WITH s
                MATCH (f:CodeFile {path: $file_path})
                MERGE (f)-[:CONTAINS {order: $line_start}]->(s)
                """,
                id=symbol.id,
                name=symbol.name,
                type=symbol.type.value,
                signature=symbol.signature,
                docstring=symbol.docstring,
                line_start=symbol.line_start,
                line_end=symbol.line_end,
                column_start=symbol.column_start,
                column_end=symbol.column_end,
                is_exported=symbol.is_exported,
                is_default_export=symbol.is_default_export,
                visibility=symbol.visibility.value,
                file_path=symbol.file_path,
            )

    def store_import(self, file_path: str, import_info: ImportInfo) -> None:
        """Store an import relationship."""
        with self._driver.session() as session:
            session.run(
                """
                MATCH (f:CodeFile {path: $file_path})
                MERGE (m:CodeModule {name: $source})
                ON CREATE SET m.type = 'external'
                MERGE (f)-[:IMPORTS {
                    imported_names: $imported_names,
                    is_default: $is_default,
                    is_namespace: $is_namespace,
                    line: $line
                }]->(m)
                """,
                file_path=file_path,
                source=import_info.source,
                imported_names=json.dumps(import_info.imported_names),
                is_default=import_info.is_default,
                is_namespace=import_info.is_namespace,
                line=import_info.line,
            )

    def search_symbols(self, query: str, symbol_type: str | None = None, limit: int = 10) -> SymbolSearchResult:
        """Search symbols by name."""
        with self._driver.session() as session:
            type_filter = " AND s.type = $type" if symbol_type else ""
            params: dict[str, Any] = {"query": query, "limit": limit}
            if symbol_type:
                params["type"] = symbol_type
            result = session.run(
                f"""
                MATCH (s:CodeSymbol)
                WHERE (s.name CONTAINS $query OR coalesce(s.file_path, '') CONTAINS $query){type_filter}
                RETURN s
                ORDER BY s.name
                LIMIT $limit
                """,
                **params,
            )

            symbols = []
            for record in result:
                node = record["s"]
                symbols.append(self._node_to_symbol(node))

            return SymbolSearchResult(symbols=symbols, total=len(symbols))

    def get_symbol(self, symbol_id: str) -> Symbol | None:
        """Get a symbol by ID."""
        with self._driver.session() as session:
            result = session.run(
                "MATCH (s:CodeSymbol {id: $id}) RETURN s",
                id=symbol_id,
            )
            record = result.single()
            if record:
                return self._node_to_symbol(record["s"])
            return None

    def get_symbol_with_relationships(self, symbol_id: str) -> SymbolWithRelationships | None:
        """Get symbol with all its relationships."""
        with self._driver.session() as session:
            # Get symbol
            result = session.run(
                "MATCH (s:CodeSymbol {id: $id}) RETURN s",
                id=symbol_id,
            )
            record = result.single()
            if not record:
                return None

            symbol = self._node_to_symbol(record["s"])

            # Get imports (symbols this symbol imports/uses)
            imports_result = session.run(
                """
                MATCH (s:CodeSymbol {id: $id})-[:CALLS|REFERENCES]->(target:CodeSymbol)
                RETURN target
                LIMIT 20
                """,
                id=symbol_id,
            )
            imports = [self._node_to_symbol(r["target"]) for r in imports_result]

            # Get called_by (symbols that call/reference this)
            called_by_result = session.run(
                """
                MATCH (source:CodeSymbol)-[:CALLS|REFERENCES]->(s:CodeSymbol {id: $id})
                RETURN source
                LIMIT 20
                """,
                id=symbol_id,
            )
            called_by = [
                SymbolReference(
                    symbol=self._node_to_symbol(r["source"]),
                    file_path="",
                    line=0,
                    column=0,
                )
                for r in called_by_result
            ]

            # Get extends
            extends_result = session.run(
                """
                MATCH (s:CodeSymbol {id: $id})-[:EXTENDS]->(parent:CodeSymbol)
                RETURN parent
                """,
                id=symbol_id,
            )
            extends = [self._node_to_symbol(r["parent"]) for r in extends_result]

            # Get implements
            implements_result = session.run(
                """
                MATCH (s:CodeSymbol {id: $id})-[:IMPLEMENTS]->(iface:CodeSymbol)
                RETURN iface
                """,
                id=symbol_id,
            )
            implements = [self._node_to_symbol(r["iface"]) for r in implements_result]

            return SymbolWithRelationships(
                symbol=symbol,
                imports=imports,
                exports=[],
                extends=extends,
                implements=implements,
                called_by=called_by,
                calls=[],
            )

    def get_component_hierarchy(self, root_name: str) -> ComponentNode | None:
        """Get React/component hierarchy starting from root."""
        with self._driver.session() as session:
            # Find root symbol
            result = session.run(
                """
                MATCH (s:CodeSymbol)
                WHERE s.name = $name AND s.type IN ['function', 'class']
                RETURN s
                LIMIT 1
                """,
                name=root_name,
            )
            record = result.single()
            if not record:
                return None

            root = self._node_to_symbol(record["s"])
            root_node = ComponentNode(name=root.name, symbol_id=root.id)

            # Find children (symbols called by root)
            self._build_component_tree(session, root.id, root_node, depth=0, max_depth=5)

            return root_node

    def _build_component_tree(
        self,
        session,
        symbol_id: str,
        parent_node: ComponentNode,
        depth: int,
        max_depth: int,
    ) -> None:
        """Recursively build component tree."""
        if depth >= max_depth:
            return

        result = session.run(
            """
            MATCH (s:CodeSymbol {id: $id})-[:CALLS]->(child:CodeSymbol)
            WHERE child.type IN ['function', 'class']
            RETURN child
            LIMIT 10
            """,
            id=symbol_id,
        )

        for record in result:
            child = self._node_to_symbol(record["child"])
            child_node = ComponentNode(name=child.name, symbol_id=child.id)
            parent_node.children.append(child_node)
            self._build_component_tree(session, child.id, child_node, depth + 1, max_depth)

    def get_index_status(self) -> IndexStatus:
        """Get indexing status."""
        with self._driver.session() as session:
            file_result = session.run("MATCH (f:CodeFile) RETURN count(f) as count")
            file_count = file_result.single()["count"]

            symbol_result = session.run("MATCH (s:CodeSymbol) RETURN count(s) as count")
            symbol_count = symbol_result.single()["count"]

            last_index_result = session.run(
                "MATCH (f:CodeFile) RETURN max(f.last_indexed) as last"
            )
            last_record = last_index_result.single()
            last_indexed = None
            if last_record and last_record["last"]:
                try:
                    last_indexed = datetime.fromisoformat(last_record["last"])
                except ValueError:
                    pass

            return IndexStatus(
                total_files=file_count,
                indexed_files=file_count,
                indexed_symbols=symbol_count,
                pending_files=0,
                last_full_index=last_indexed,
                is_indexing=False,
            )

    def get_file(self, file_path: str) -> File | None:
        """Get a file by path."""
        with self._driver.session() as session:
            result = session.run(
                "MATCH (f:CodeFile {path: $path}) RETURN f",
                path=file_path,
            )
            record = result.single()
            if record:
                node = record["f"]
                return File(
                    path=node["path"],
                    name=node["name"],
                    language=node["language"],
                    content_hash=node["content_hash"],
                    last_indexed=datetime.fromisoformat(node["last_indexed"]),
                    line_count=node.get("line_count", 0),
                    is_test=node.get("is_test", False),
                    is_entry_point=node.get("is_entry_point", False),
                )
            return None

    def delete_file(self, file_path: str) -> None:
        """Delete a file and all its symbols."""
        with self._driver.session() as session:
            session.run(
                """
                MATCH (f:CodeFile {path: $path})
                OPTIONAL MATCH (f)-[:CONTAINS]->(s:CodeSymbol)
                DETACH DELETE s, f
                """,
                path=file_path,
            )

    def _node_to_symbol(self, node: Any) -> Symbol:
        """Convert Neo4j node to Symbol model."""
        from services.code_indexer.models import SymbolType, Visibility

        return Symbol(
            id=node["id"],
            name=node["name"],
            type=SymbolType(node.get("type", "function")),
            file_path=node.get("file_path") or "",
            signature=node.get("signature", ""),
            docstring=node.get("docstring", ""),
            line_start=node.get("line_start", 0),
            line_end=node.get("line_end", 0),
            column_start=node.get("column_start", 0),
            column_end=node.get("column_end", 0),
            is_exported=node.get("is_exported", False),
            is_default_export=node.get("is_default_export", False),
            visibility=Visibility(node.get("visibility", "public")),
        )
