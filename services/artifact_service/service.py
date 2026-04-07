"""Artifact Service — business logic for upload, processing, and search."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import unicodedata
import uuid
from pathlib import Path
from typing import Any

import httpx

from services.artifact_service.storage import LocalStorage
from packages.shared_utils.task_queue import BackgroundTaskQueue

logger = logging.getLogger(__name__)

# Mime-type categories
AUDIO_TYPES = {"audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/m4a"}
VIDEO_TYPES = {"video/mp4", "video/mpeg", "video/quicktime", "video/x-msvideo", "video/webm"}
DOCUMENT_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",  # .doc
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint",  # .ppt
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # .xlsx
    "application/vnd.ms-excel",  # .xls
    "application/rtf",
    "text/plain",
}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"}


class ArtifactService:
    """Orchestrates file storage and calls memory-service for Neo4j persistence."""

    def __init__(self, storage: LocalStorage, memory_url: str) -> None:
        self._storage = storage
        self._memory_url = memory_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=30.0)

        # Processing queue — reuses shared BackgroundTaskQueue
        self._task_queue = BackgroundTaskQueue(name="artifact")

    # ── Queue & SSE (delegated to shared BackgroundTaskQueue) ──────────

    async def enqueue(self, artifact_id: str) -> None:
        """Add artifact to processing queue."""
        position = await self._task_queue.enqueue(artifact_id)
        if position > 0:
            await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {"status": "queued"})
            logger.info("Enqueued artifact %s (position %d)", artifact_id, position)

    async def start_worker(self) -> None:
        """Start the background processing worker."""
        async def _pre_check(artifact_id: str) -> bool:
            await asyncio.sleep(1)  # let memory-service persist
            artifact = await self.get_artifact(artifact_id)
            if not artifact:
                logger.info("Artifact %s was deleted, skipping", artifact_id)
                return False
            return True

        async def _process(artifact_id: str) -> None:
            try:
                await self.process_artifact(artifact_id)
            except Exception as e:
                await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {"status": "error"})
                raise

        await self._task_queue.start(process_fn=_process, pre_check_fn=_pre_check)

    async def stop_worker(self) -> None:
        await self._task_queue.stop()

    def subscribe(self) -> asyncio.Queue:
        return self._task_queue.subscribe()

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._task_queue.unsubscribe(q)

    async def _broadcast(self, data: dict) -> None:
        await self._task_queue.broadcast(data)

    def get_queue_status(self) -> dict:
        return self._task_queue.status()

    # ── Memory-service helpers ───────────────────────────────────────────

    async def _mem_post(self, path: str, json: dict) -> dict:
        resp = await self._http.post(f"{self._memory_url}{path}", json=json)
        resp.raise_for_status()
        return resp.json()

    async def _mem_get(self, path: str, params: dict | None = None) -> dict:
        resp = await self._http.get(f"{self._memory_url}{path}", params=params)
        resp.raise_for_status()
        return resp.json()

    async def _mem_patch(self, path: str, json: dict) -> dict:
        resp = await self._http.patch(f"{self._memory_url}{path}", json=json)
        resp.raise_for_status()
        return resp.json()

    async def _mem_delete(self, path: str) -> dict:
        resp = await self._http.delete(f"{self._memory_url}{path}")
        resp.raise_for_status()
        return resp.json()

    # ── Upload ───────────────────────────────────────────────────────────

    async def upload(self, filename: str, file_obj, language: str | None = None,
                     project_id: str | None = None) -> dict[str, Any]:
        """Upload a file, store it, and create an Artifact node."""
        # Normalize Unicode (NFC) — fixes Vietnamese diacritics rendered as
        # combining characters (NFD) that break display in browsers/terminals.
        filename = unicodedata.normalize("NFC", filename)

        artifact_id = str(uuid.uuid4())
        _EXT_MIME = {
            # Audio
            ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
            ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
            # Video
            ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
            # Documents — mimetypes.guess_type doesn't know these in slim Docker images
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".ppt": "application/vnd.ms-powerpoint",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".xls": "application/vnd.ms-excel",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".rtf": "application/rtf",
            ".pdf": "application/pdf",
            ".txt": "text/plain",
            # Images
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
            ".svg": "image/svg+xml",
        }
        ext = os.path.splitext(filename)[1].lower()
        mime_type = mimetypes.guess_type(filename)[0] or _EXT_MIME.get(ext, "application/octet-stream")

        rel_path, file_size = await self._storage.save_stream(artifact_id, filename, file_obj)

        artifact = await self._mem_post("/internal/memory/artifacts", {
            "name": filename,
            "mime_type": mime_type,
            "file_path": rel_path,
            "file_size": file_size,
            "source_type": "upload",
            "language": language,
        })
        artifact_data = artifact.get("artifact", artifact)

        if project_id:
            await self._mem_post(f"/internal/memory/projects/{project_id}/artifacts", {
                "artifact_id": artifact_data["artifact_id"],
            })

        # Auto-process via queue (transcribe + embed)
        aid = artifact_data.get("artifact_id", artifact_id)
        await self.enqueue(aid)

        return artifact_data

    # ── YouTube ──────────────────────────────────────────────────────────

    async def upload_youtube(self, url: str, language: str | None = None,
                             project_id: str | None = None) -> dict[str, Any]:
        """Download a YouTube video and create an Artifact node."""
        from services.artifact_service.youtube import download_youtube

        artifact_id = str(uuid.uuid4())
        tmp_dir = self._storage.artifact_dir(artifact_id)
        tmp_dir.mkdir(parents=True, exist_ok=True)

        info = download_youtube(url, str(tmp_dir))
        filepath = Path(info["filepath"])
        filename = filepath.name
        file_size = info["filesize"]

        # File is already in the right directory from yt-dlp
        rel_path = f"{artifact_id}/{filename}"

        artifact = await self._mem_post("/internal/memory/artifacts", {
            "name": info["title"],
            "mime_type": "video/mp4",
            "file_path": rel_path,
            "file_size": file_size,
            "source_type": "youtube",
            "source_url": url,
            "language": language,
        })
        artifact_data = artifact.get("artifact", artifact)

        if project_id:
            await self._mem_post(f"/internal/memory/projects/{project_id}/artifacts", {
                "artifact_id": artifact_data["artifact_id"],
            })

        # Auto-process via queue (transcribe + embed)
        aid = artifact_data.get("artifact_id", artifact_id)
        await self.enqueue(aid)

        return artifact_data

    # ── Read ─────────────────────────────────────────────────────────────

    async def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        try:
            return await self._mem_get(f"/internal/memory/artifacts/{artifact_id}")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return None
            raise

    async def list_artifacts(self, project_id: str | None = None) -> list[dict[str, Any]]:
        params = {}
        if project_id:
            params["project_id"] = project_id
        data = await self._mem_get("/internal/memory/artifacts", params=params)
        return data.get("artifacts", [])

    def get_file_path(self, relative_path: str) -> Path | None:
        p = self._storage.file_path(relative_path)
        return p if p.exists() else None

    # ── Delete ───────────────────────────────────────────────────────────

    async def delete_artifact(self, artifact_id: str) -> bool:
        artifact = await self.get_artifact(artifact_id)
        if artifact:
            self._storage.delete(artifact_id)
        result = await self._mem_delete(f"/internal/memory/artifacts/{artifact_id}")
        return result.get("deleted", False)

    # ── Processing pipeline ──────────────────────────────────────────────

    async def process_artifact(self, artifact_id: str) -> dict[str, Any]:
        """Run the full processing pipeline: extract text → transcribe → embed."""
        artifact = await self.get_artifact(artifact_id)
        if not artifact:
            return {"error": "Artifact not found"}

        # Skip if already processing (prevent duplicate runs)
        if artifact.get("status") == "processing":
            logger.info("Artifact %s already processing, skipping", artifact_id)
            return {"status": "already_processing"}

        # Clear old transcript/summary when reprocessing
        if artifact.get("status") in ("ready", "error"):
            logger.info("Reprocessing artifact %s (was %s)", artifact_id, artifact.get("status"))

        await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {"status": "processing"})
        await self._broadcast({"event": "status", "artifact_id": artifact_id, "status": "processing"})

        try:
            mime = artifact.get("mime_type", "")
            text = ""

            # Step 1: Extract text or transcribe
            if mime in AUDIO_TYPES or mime in VIDEO_TYPES:
                text = await self._transcribe(artifact)
            elif mime in DOCUMENT_TYPES:
                text = await self._extract_text(artifact)
            elif mime in IMAGE_TYPES:
                text = await self._ocr_image(artifact)
            else:
                text = ""

            if text:
                await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {
                    "transcript": text[:50000],  # cap at 50k chars
                })

            # Step 2: Generate embeddings
            if text:
                await self._generate_embeddings(artifact_id, text)

            await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {"status": "ready"})
            await self._broadcast({"event": "status", "artifact_id": artifact_id, "status": "ready"})
            return {"status": "ready", "text_length": len(text)}

        except Exception as e:
            logger.exception("Processing failed for artifact %s", artifact_id)
            await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {"status": "error"})
            await self._broadcast({"event": "status", "artifact_id": artifact_id, "status": "error"})
            return {"status": "error", "error": str(e)}

    async def _transcribe(self, artifact: dict[str, Any]) -> str:
        """Dispatch transcription to GIPFormer (Vietnamese) or MLX Whisper."""
        from services.artifact_service.transcription import transcribe_artifact
        return await transcribe_artifact(artifact, self._storage)

    async def _extract_text(self, artifact: dict[str, Any]) -> str:
        """Extract text from document files."""
        from services.artifact_service.extractors import extract_text
        file_path = self._storage.file_path(artifact.get("file_path", ""))
        return extract_text(str(file_path), artifact.get("mime_type", ""))

    async def _ocr_image(self, artifact: dict[str, Any]) -> str:
        """OCR an image file."""
        try:
            from services.artifact_service.extractors import ocr_image
            file_path = self._storage.file_path(artifact.get("file_path", ""))
            return ocr_image(str(file_path))
        except Exception:
            logger.info("OCR not available, skipping image %s", artifact.get("artifact_id"))
            return ""

    async def _generate_embeddings(self, artifact_id: str, text: str) -> None:
        """Chunk text and generate embeddings via the embedding module."""
        from services.artifact_service.embeddings import get_embedder
        embedder = get_embedder()
        chunks = embedder.chunk_text(text)

        for i, chunk in enumerate(chunks):
            vector = embedder.embed(chunk)
            await self._mem_post("/internal/memory/embeddings", {
                "artifact_id": artifact_id,
                "chunk_index": i,
                "chunk_text": chunk,
                "vector": vector,
                "model": embedder.model_name,
            })
        logger.info("Generated %d embeddings for artifact %s", len(chunks), artifact_id)

    # ── Summarize ────────────────────────────────────────────────────────

    async def summarize_artifact(self, artifact_id: str, language: str = "",
                                  instructions: str = "") -> dict[str, Any]:
        """Generate a summary of the artifact's transcript or extracted text via response-generator.

        For long transcripts, splits into chunks and summarizes each chunk first,
        then produces a final combined summary.
        """
        artifact = await self.get_artifact(artifact_id)
        if not artifact:
            return {"error": "Artifact not found"}

        text = artifact.get("transcript", "")
        if not text:
            return {"error": "No transcript or text to summarize"}

        # Use artifact language if not explicitly provided
        lang = language or artifact.get("language", "") or ""

        # Map language codes to full names
        _lang_map = {
            "vi": "Vietnamese (Tiếng Việt)", "en": "English", "ja": "Japanese (日本語)",
            "zh": "Chinese (中文)", "ko": "Korean (한국어)", "fr": "French (Français)",
            "de": "German (Deutsch)", "es": "Spanish (Español)", "th": "Thai (ภาษาไทย)",
            "id": "Indonesian (Bahasa Indonesia)", "vietnamese": "Vietnamese (Tiếng Việt)",
        }
        lang_label = _lang_map.get(lang.lower(), lang) if lang else ""

        # Context window budget: reserve tokens for prompt + response
        context_window = int(os.environ.get("OASIS_CONTEXT_WINDOW", "32768"))
        max_response_tokens = 4096
        prompt_overhead_tokens = 600  # instructions + framing
        available_tokens = context_window - max_response_tokens - prompt_overhead_tokens
        # ~3.5 chars per token for Vietnamese/mixed text
        max_chars_per_chunk = int(available_tokens * 3.5)

        logger.info("Summarize %s: transcript=%d chars, chunk_limit=%d chars, lang=%s",
                     artifact_id, len(text), max_chars_per_chunk, lang or "auto")

        custom_instructions = ""
        if instructions:
            custom_instructions = f"{instructions}\n\n"

        if len(text) <= max_chars_per_chunk:
            # Single chunk — fits in context window
            summary = await self._summarize_chunk(text, lang, lang_label, custom_instructions)
        else:
            # Multi-chunk: split, summarize each, then combine
            chunks = self._split_transcript(text, max_chars_per_chunk)
            logger.info("Splitting into %d chunks for summarization", len(chunks))

            chunk_summaries = []
            for i, chunk in enumerate(chunks):
                logger.info("Summarizing chunk %d/%d (%d chars)", i + 1, len(chunks), len(chunk))
                s = await self._summarize_chunk(
                    chunk, lang, lang_label,
                    f"This is part {i+1} of {len(chunks)} of a longer transcript.\n{custom_instructions}",
                )
                if s:
                    chunk_summaries.append(f"--- Part {i+1}/{len(chunks)} ---\n{s}")

            if not chunk_summaries:
                return {"error": "All chunks failed to summarize"}

            # Final combination pass
            combined = "\n\n".join(chunk_summaries)
            # If combined summaries fit in one context, do a final merge
            if len(combined) <= max_chars_per_chunk:
                summary = await self._summarize_chunk(
                    combined, lang, lang_label,
                    "Below are partial summaries of different sections of the same transcript. "
                    "Merge them into ONE cohesive, well-structured summary. Remove duplicates.\n"
                    f"{custom_instructions}",
                )
            else:
                summary = combined  # too long to merge, just concatenate

        if summary:
            try:
                await self._mem_patch(f"/internal/memory/artifacts/{artifact_id}", {
                    "summary": summary,
                })
            except Exception as e:
                logger.warning("Failed to save summary for %s: %s", artifact_id, e)
        return {"status": "ok", "summary": summary}

    def _split_transcript(self, text: str, max_chars: int) -> list[str]:
        """Split transcript into chunks, trying to break at line/sentence boundaries."""
        chunks = []
        while text:
            if len(text) <= max_chars:
                chunks.append(text)
                break
            # Find a good break point (newline, period, space)
            cut = max_chars
            for sep in ["\n", ". ", " "]:
                idx = text.rfind(sep, 0, max_chars)
                if idx > max_chars * 0.5:  # don't cut too short
                    cut = idx + len(sep)
                    break
            chunks.append(text[:cut])
            text = text[cut:]
        return chunks

    async def _summarize_chunk(self, text: str, lang: str, lang_label: str,
                                extra_instructions: str = "") -> str:
        """Summarize a single chunk of text via response-generator."""
        # Build language directive
        if lang.lower() in ("vi", "vie", "vietnamese"):
            lang_directive = "BẮT BUỘC: Viết TOÀN BỘ bằng tiếng Việt. KHÔNG dùng tiếng Anh.\n\n"
        elif lang_label:
            lang_directive = f"MANDATORY: Write the ENTIRE summary in {lang_label}. Do NOT use English.\n\n"
        else:
            lang_directive = ""

        user_msg = (
            f"{lang_directive}"
            f"{extra_instructions}"
            "You are an expert analyst producing comprehensive, well-structured summaries from transcripts and documents.\n\n"
            "Follow this structure:\n\n"
            "1. **Opening context** (1 paragraph): Describe what this recording/document is about — the setting, "
            "participants, purpose, and scope. Infer this from the content itself (e.g. a meeting at a health clinic, "
            "a lecture on topic X, an interview about Y). Be specific about the subject matter.\n\n"
            "2. **Numbered topic sections**: Break the content into logical themes or topics discussed. "
            "For each section:\n"
            "   - Use a **bold numbered heading** that captures the theme\n"
            "   - Use bullet points with **bold key terms** for important concepts, names, or entities\n"
            "   - Include specific details, numbers, dates, and names mentioned\n"
            "   - Capture the nuance — not just what was said, but the context and implications\n\n"
            "3. **Proposals, decisions, or action items** (if any): List concrete requests, recommendations, "
            "decisions made, or next steps identified by the participants.\n\n"
            "4. **Closing summary** (1 paragraph): Wrap up with the overall outcome or conclusion of the "
            "session/document.\n\n"
            "Guidelines:\n"
            "- Be comprehensive and detailed — capture all substantive points, not just high-level themes\n"
            "- If speaker labels are present, identify key speakers and their roles where apparent\n"
            "- Use markdown formatting: **bold** for emphasis, bullet points for lists\n"
            "- Do NOT fabricate information not present in the transcript\n"
            "- If the transcript quality is poor in places, work with what is available and note gaps\n"
        )
        if lang_label:
            user_msg += f"\n⚠️ REMINDER: Your entire response MUST be written in {lang_label}.\n"
        user_msg += f"\n---\n{text}\n---"

        # Build a clean system prompt — NO generic Oasis agent identity
        if lang.lower() in ("vi", "vie", "vietnamese"):
            system_prompt = "Bạn là chuyên gia phân tích tài liệu. Chỉ tóm tắt nội dung được cung cấp. Viết hoàn toàn bằng tiếng Việt."
        elif lang_label:
            system_prompt = f"You are a document analyst. Only summarize the provided content. Write entirely in {lang_label}."
        else:
            system_prompt = "You are a document analyst. Only summarize the provided content. Do not add any external knowledge."

        response_url = os.environ.get("RESPONSE_GENERATOR_URL", "http://response-generator:8003")
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                resp = await client.post(f"{response_url}/internal/response/chat", json={
                    "user_message": user_msg,
                    "context": {
                        "max_tokens": 4096,
                        "system_override": system_prompt,
                    },
                })
                resp.raise_for_status()
                return resp.json().get("response_text", "")
        except Exception as e:
            logger.exception("Chunk summarization failed")
            return ""

    # ── Search ───────────────────────────────────────────────────────────

    async def search(self, query: str, limit: int = 10,
                     project_id: str | None = None) -> list[dict[str, Any]]:
        """Semantic search across artifact embeddings."""
        from services.artifact_service.embeddings import get_embedder
        embedder = get_embedder()
        query_vector = embedder.embed(query)
        data = await self._mem_post("/internal/memory/embeddings/search", {
            "query_vector": query_vector,
            "limit": limit,
            "project_id": project_id,
        })
        return data.get("results", [])
