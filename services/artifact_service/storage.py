"""Local filesystem storage for artifact files."""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)


class LocalStorage:
    """Stores artifact files on the local filesystem.

    Layout: {base_path}/{artifact_id}/{filename}
    """

    def __init__(self, base_path: str) -> None:
        self._base = Path(base_path)
        self._base.mkdir(parents=True, exist_ok=True)
        logger.info("LocalStorage initialised at %s", self._base)

    def artifact_dir(self, artifact_id: str) -> Path:
        return self._base / artifact_id

    def save(self, artifact_id: str, filename: str, data: bytes) -> str:
        """Save file bytes and return the relative path."""
        dest_dir = self.artifact_dir(artifact_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename
        dest.write_bytes(data)
        rel = f"{artifact_id}/{filename}"
        logger.info("Stored %d bytes → %s", len(data), rel)
        return rel

    async def save_stream(self, artifact_id: str, filename: str, stream) -> tuple[str, int]:
        """Save from an async file-like (UploadFile) and return (relative_path, size)."""
        dest_dir = self.artifact_dir(artifact_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename
        size = 0
        with open(dest, "wb") as f:
            while chunk := await stream.read(1024 * 1024):  # 1 MB chunks
                f.write(chunk)
                size += len(chunk)
        rel = f"{artifact_id}/{filename}"
        logger.info("Streamed %d bytes → %s", size, rel)
        return rel, size

    def read(self, relative_path: str) -> bytes:
        full = self._base / relative_path
        return full.read_bytes()

    def file_path(self, relative_path: str) -> Path:
        return self._base / relative_path

    def delete(self, artifact_id: str) -> None:
        dest_dir = self.artifact_dir(artifact_id)
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
            logger.info("Deleted artifact dir %s", dest_dir)

    def exists(self, relative_path: str) -> bool:
        return (self._base / relative_path).exists()
