"""Native transcription service using MLX Whisper on Apple Silicon.

Runs on the host (not Docker) to leverage the M3/M-series Neural Engine.
Provides a simple HTTP API for the Docker-based voice-agent to call.
"""

import asyncio
import base64
import logging
import time

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(name)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Oasis Transcription (MLX)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model singleton ──────────────────────────────────────────────────────────

import os

_model_loaded = False
# whisper-medium-mlx is ~4x faster than large-v3-turbo with good accuracy
# Override via WHISPER_MODEL env var if needed
_MODEL_REPO = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-medium-mlx")

# Minimum audio duration (seconds) to bother transcribing.
# Very short chunks (< 0.5s) produce garbage like "you", "You", "Thank you."
MIN_AUDIO_DURATION = 0.5


def _ensure_model():
    """Lazy-load the MLX whisper model on first request."""
    global _model_loaded
    if not _model_loaded:
        import mlx_whisper  # noqa: F401 — triggers model download on first use
        logger.info("MLX Whisper model ready: %s", _MODEL_REPO)
        _model_loaded = True


def _transcribe_sync(audio_np: np.ndarray, language: str | None = "en") -> dict:
    """Run MLX Whisper transcription (blocking). Called via asyncio.to_thread."""
    import mlx_whisper

    _ensure_model()
    kwargs = dict(
        path_or_hf_repo=_MODEL_REPO,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        word_timestamps=False,
    )
    if language:
        kwargs["language"] = language
    # When language is None/empty, Whisper auto-detects
    return mlx_whisper.transcribe(audio_np, **kwargs)


# ── API ──────────────────────────────────────────────────────────────────────

class TranscribeRequest(BaseModel):
    """Audio as base64-encoded float32 PCM + sample rate."""
    audio_b64: str
    sample_rate: int = 16000
    language: str = ""


class TranscribeResponse(BaseModel):
    text: str
    duration_ms: int
    language: str = ""


@app.on_event("startup")
async def _warmup():
    """Pre-load model on startup so first request isn't slow."""
    import asyncio
    asyncio.get_event_loop().run_in_executor(None, _ensure_model)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "transcription-mlx", "model": _MODEL_REPO}


# Only allow one transcription at a time — MLX/MPS crashes on concurrent GPU access
_transcribe_lock = asyncio.Semaphore(1)


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest):
    """Transcribe audio using MLX Whisper large-v3-turbo.

    Runs the blocking MLX call in a thread so the event loop stays
    responsive for health checks and concurrent requests.
    """
    # Decode float32 PCM from base64
    raw = base64.b64decode(req.audio_b64)
    audio_np = np.frombuffer(raw, dtype=np.float32)

    # Resample to 16kHz if needed
    if req.sample_rate != 16000:
        try:
            import scipy.signal
            num_samples = int(len(audio_np) * 16000 / req.sample_rate)
            audio_np = scipy.signal.resample(audio_np, num_samples).astype(np.float32)
        except ImportError:
            ratio = req.sample_rate // 16000
            if ratio > 1:
                audio_np = audio_np[::ratio].astype(np.float32)

    # Skip very short audio — produces garbage transcripts
    duration_secs = len(audio_np) / 16000
    if duration_secs < MIN_AUDIO_DURATION:
        logger.info("Skipping short audio (%.2fs < %.2fs)", duration_secs, MIN_AUDIO_DURATION)
        return TranscribeResponse(text="", duration_ms=0)

    lang = req.language or None  # None = auto-detect

    t0 = time.monotonic()
    # Serialize access — MPS/MLX segfaults on concurrent GPU operations
    try:
        async with _transcribe_lock:
            result = await asyncio.wait_for(
                asyncio.to_thread(_transcribe_sync, audio_np, lang),
                timeout=120.0,
            )
    except asyncio.TimeoutError:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.warning("Transcription timed out after %dms for %.1fs audio — returning empty", elapsed_ms, duration_secs)
        return TranscribeResponse(text="", duration_ms=elapsed_ms)

    elapsed_ms = int((time.monotonic() - t0) * 1000)

    text = (result.get("text") or "").strip()
    detected_lang = (result.get("language") or "").strip()
    logger.info("Transcribed %d samples (%.1fs) in %dms, lang=%s → %r", len(audio_np), duration_secs, elapsed_ms, detected_lang, text[:80])
    return TranscribeResponse(text=text, duration_ms=elapsed_ms, language=detected_lang)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8099)
