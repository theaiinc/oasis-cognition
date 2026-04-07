"""Pydantic models for code indexer service."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class SymbolType(str, Enum):
    """Types of code symbols."""

    FUNCTION = "function"
    CLASS = "class"
    INTERFACE = "interface"
    TYPE = "type"
    VARIABLE = "variable"
    CONST = "const"
    ENUM = "enum"
    PROPERTY = "property"
    METHOD = "method"
    MODULE = "module"


class Visibility(str, Enum):
    """Symbol visibility."""

    PUBLIC = "public"
    PRIVATE = "private"
    PROTECTED = "protected"


class File(BaseModel):
    """Represents a source file."""

    path: str
    name: str
    language: str
    content_hash: str
    last_indexed: datetime
    line_count: int = 0
    is_test: bool = False
    is_entry_point: bool = False


class Symbol(BaseModel):
    """Represents a code symbol (function, class, etc.)."""

    id: str  # composite: file_path:name:line_start
    name: str
    type: SymbolType
    file_path: str
    signature: str = ""
    docstring: str = ""
    line_start: int
    line_end: int
    column_start: int = 0
    column_end: int = 0
    is_exported: bool = False
    is_default_export: bool = False
    visibility: Visibility = Visibility.PUBLIC


class ImportInfo(BaseModel):
    """Import relationship details."""

    source: str  # module path or file
    imported_names: list[str] = Field(default_factory=list)
    is_default: bool = False
    is_namespace: bool = False
    line: int = 0


class SymbolRelationship(BaseModel):
    """Relationship between symbols."""

    from_symbol: str  # symbol id
    to_symbol: str  # symbol id
    relationship_type: str  # CALLS, EXTENDS, IMPLEMENTS, REFERENCES
    line: int = 0
    column: int = 0


class FileWithSymbols(BaseModel):
    """File with its contained symbols."""

    file: File
    symbols: list[Symbol]


class SymbolSearchResult(BaseModel):
    """Result of symbol search."""

    symbols: list[Symbol]
    total: int


class SymbolReference(BaseModel):
    """Reference to a symbol."""

    symbol: Symbol
    file_path: str
    line: int
    column: int
    context: str = ""  # surrounding code


class SymbolWithRelationships(BaseModel):
    """Symbol with its relationships."""

    symbol: Symbol
    imports: list[Symbol]
    exports: list[Symbol]
    extends: list[Symbol]
    implements: list[Symbol]
    called_by: list[SymbolReference]
    calls: list[SymbolReference]


class ComponentNode(BaseModel):
    """Node in component hierarchy."""

    name: str
    symbol_id: str
    children: list[ComponentNode] = Field(default_factory=list)


class IndexStatus(BaseModel):
    """Indexing status."""

    total_files: int
    indexed_files: int
    indexed_symbols: int = 0
    pending_files: int
    last_full_index: datetime | None = None
    is_indexing: bool = False


class IndexRequest(BaseModel):
    """Request to index a path."""

    path: str
    force: bool = False  # reindex even if hash matches


class IndexResponse(BaseModel):
    """Response from indexing operation."""

    indexed: int
    removed: int
    errors: list[str]
    duration_ms: int = 0


class SearchQuery(BaseModel):
    """Symbol search query."""

    q: str
    type: SymbolType | None = None
    path: str | None = None
    limit: int = 10
    offset: int = 0


class GraphPathRequest(BaseModel):
    """Request to find path between symbols."""

    from_symbol: str
    to_symbol: str
    max_depth: int = 5


class GraphPathResponse(BaseModel):
    """Response with path between symbols."""

    path: list[str]  # symbol names
    relationships: list[str]
    found: bool
