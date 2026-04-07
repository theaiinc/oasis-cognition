"""File watcher for incremental code indexing."""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from services.code_indexer.service import CodeIndexerService

logger = logging.getLogger(__name__)


class CodeIndexingEventHandler(FileSystemEventHandler):
    """Debounced handler: re-index a file after short quiet period."""

    def __init__(self, indexer: CodeIndexerService, debounce_s: float = 0.6) -> None:
        self._indexer = indexer
        self._debounce_s = debounce_s
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def _should_handle(self, path: Path) -> bool:
        if path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx"}:
            return False
        for parser in self._indexer.parsers:
            if parser.can_parse(path):
                return True
        return False

    def _schedule(self, path: Path) -> None:
        key = str(path.resolve())
        with self._lock:
            t = self._timers.pop(key, None)
            if t is not None:
                t.cancel()

            def _run() -> None:
                with self._lock:
                    self._timers.pop(key, None)
                try:
                    if path.is_file():
                        ok = self._indexer.index_file(path, force=True)
                        if ok:
                            logger.info("Incrementally indexed: %s", path)
                except Exception as e:
                    logger.error("Incremental index failed for %s: %s", path, e)

            timer = threading.Timer(self._debounce_s, _run)
            self._timers[key] = timer
            timer.daemon = True
            timer.start()

    def on_modified(self, event: Any) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if self._should_handle(p):
            self._schedule(p)

    def on_created(self, event: Any) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if self._should_handle(p):
            self._schedule(p)


class CodeIndexerWatcher:
    """Watch workspace and trigger incremental indexing."""

    def __init__(
        self,
        indexer: CodeIndexerService,
        workspace_path: str = "/workspace",
    ) -> None:
        self._indexer = indexer
        self._workspace = Path(workspace_path)
        self._observer: Observer | None = None

    def start(self) -> None:
        if self._observer is not None:
            return
        if not self._workspace.is_dir():
            logger.warning("Watcher: workspace %s is not a directory; skipping", self._workspace)
            return
        self._observer = Observer()
        self._observer.schedule(
            CodeIndexingEventHandler(self._indexer),
            str(self._workspace),
            recursive=True,
        )
        self._observer.start()
        logger.info("Code indexer file watcher started on %s", self._workspace)

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5)
            self._observer = None
            logger.info("Code indexer file watcher stopped")
