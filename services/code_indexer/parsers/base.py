"""Base parser interface for code indexing."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from services.code_indexer.models import Symbol, ImportInfo, File


class BaseParser(ABC):
    """Base class for language-specific parsers."""

    @property
    @abstractmethod
    def supported_extensions(self) -> set[str]:
        """File extensions this parser handles (e.g., {'.ts', '.tsx'})."""
        pass

    @property
    @abstractmethod
    def language_name(self) -> str:
        """Human-readable language name."""
        pass

    @abstractmethod
    def parse_file(self, file_path: Path, content: str | None = None) -> dict[str, Any]:
        """Parse a file and extract symbols, imports, and relationships."""
        pass

    def can_parse(self, file_path: Path) -> bool:
        """Check if this parser can handle the given file."""
        return file_path.suffix.lower() in self.supported_extensions

    def _compute_hash(self, content: str) -> str:
        """Compute content hash for change detection."""
        import hashlib

        return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]

    def _is_test_file(self, file_path: Path) -> bool:
        """Check if file is a test file."""
        name = file_path.name.lower()
        path_str = str(file_path).lower()
        return (
            name.startswith("test_")
            or name.endswith(".test.ts")
            or name.endswith(".test.tsx")
            or name.endswith(".spec.ts")
            or name.endswith(".spec.tsx")
            or name.endswith("_test.py")
            or "/test/" in path_str
            or "/tests/" in path_str
            or "/__tests__/" in path_str
        )

    def _is_entry_point(self, file_path: Path) -> bool:
        """Check if file is an entry point."""
        name = file_path.name.lower()
        return name in ("main.py", "index.ts", "index.tsx", "index.js", "app.ts", "app.tsx")
