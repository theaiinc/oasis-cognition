"""MTEB v2 embedding generation for artifact text chunks."""

from __future__ import annotations

import logging
from typing import Any

from packages.shared_utils.config import get_settings

logger = logging.getLogger(__name__)

_embedder_instance = None


class Embedder:
    """Lazy-loaded sentence-transformers embedder (MTEB v2 compatible)."""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self._model = None

    def _load(self):
        if self._model is None:
            logger.info("Loading embedding model: %s", self.model_name)
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name)
            logger.info("Embedding model loaded: %s (dim=%d)", self.model_name, self._model.get_sentence_embedding_dimension())

    def embed(self, text: str) -> list[float]:
        """Embed a single text string, returns float list."""
        self._load()
        vec = self._model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts."""
        self._load()
        vecs = self._model.encode(texts, normalize_embeddings=True, batch_size=32)
        return [v.tolist() for v in vecs]

    @property
    def dimension(self) -> int:
        self._load()
        return self._model.get_sentence_embedding_dimension()

    def chunk_text(self, text: str, chunk_size: int = 512, overlap: int = 64) -> list[str]:
        """Split text into overlapping chunks by approximate token count (words/0.75)."""
        words = text.split()
        if not words:
            return []

        # Approximate: 1 token ≈ 0.75 words
        words_per_chunk = max(1, int(chunk_size * 0.75))
        words_overlap = max(0, int(overlap * 0.75))

        chunks = []
        start = 0
        while start < len(words):
            end = start + words_per_chunk
            chunk = " ".join(words[start:end])
            if chunk.strip():
                chunks.append(chunk.strip())
            start = end - words_overlap
            if start >= len(words):
                break
            # Prevent infinite loop on tiny overlap
            if end >= len(words):
                break

        return chunks


def get_embedder() -> Embedder:
    """Get the singleton Embedder instance."""
    global _embedder_instance
    if _embedder_instance is None:
        settings = get_settings()
        _embedder_instance = Embedder(settings.embedding_model)
    return _embedder_instance
