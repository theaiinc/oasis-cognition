"""Native GIPFormer Vietnamese ASR service.

Runs on the host (not Docker) — uses sherpa-onnx for transcription.
Speaker diarization is handled by the standalone diarization service (port 8097).

Start:
    ./scripts/start-gipformer.sh
"""

import asyncio
import logging
import os
import signal
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(name)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Oasis Transcription (GIPFormer Vietnamese)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── GIPFormer model ─────────────────────────────────────────────────────────

REPO_ID = "g-group-ai-lab/gipformer-65M-rnnt"
SAMPLE_RATE = 16000
FEATURE_DIM = 80

_recognizer = None


def _ensure_recognizer():
    """Lazy-load the GIPFormer ONNX model."""
    global _recognizer
    if _recognizer is not None:
        return

    import sherpa_onnx
    from huggingface_hub import hf_hub_download

    files = {
        "encoder": "encoder-epoch-35-avg-6.int8.onnx",
        "decoder": "decoder-epoch-35-avg-6.int8.onnx",
        "joiner": "joiner-epoch-35-avg-6.int8.onnx",
    }

    logger.info("Downloading GIPFormer int8 model from %s...", REPO_ID)
    paths = {}
    for key, filename in files.items():
        paths[key] = hf_hub_download(repo_id=REPO_ID, filename=filename)
    paths["tokens"] = hf_hub_download(repo_id=REPO_ID, filename="tokens.txt")

    logger.info("Creating sherpa-onnx recognizer...")
    _recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=paths["encoder"],
        decoder=paths["decoder"],
        joiner=paths["joiner"],
        tokens=paths["tokens"],
        num_threads=2,
        sample_rate=SAMPLE_RATE,
        feature_dim=FEATURE_DIM,
        decoding_method="greedy_search",
    )
    logger.info("GIPFormer model ready (int8)")


# ── Core logic ──────────────────────────────────────────────────────────────

CHUNK_SECONDS = 30
MIN_RMS_ENERGY = 0.005  # Skip near-silent segments
MAX_REPEAT_RATIO = 0.4  # Discard if >40% of text is a repeated phrase


def _is_hallucination(text: str) -> bool:
    """Detect hallucinated/repetitive output from the ASR model."""
    if not text or len(text) < 10:
        return False

    # Split into words and check for excessive repetition
    words = text.split()
    if len(words) < 4:
        return False

    # Check bigram repetition ratio
    bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words) - 1)]
    if bigrams:
        from collections import Counter
        counts = Counter(bigrams)
        most_common_count = counts.most_common(1)[0][1]
        if most_common_count / len(bigrams) > MAX_REPEAT_RATIO:
            return True

    # Known hallucination patterns from GIPFormer
    hallucination_phrases = [
        "subscribe cho kênh",
        "đăng ký kênh để ủng hộ",
        "cảm ơn các bạn đã theo dõi",
        "không bỏ lỡ những video",
    ]
    text_lower = text.lower()
    for phrase in hallucination_phrases:
        if text_lower.count(phrase) >= 2:
            return True

    return False


def _has_speech_energy(samples: np.ndarray) -> bool:
    """Check if audio segment has enough energy to contain speech."""
    rms = np.sqrt(np.mean(samples ** 2))
    return rms > MIN_RMS_ENERGY


def _transcribe_samples(samples: np.ndarray, sample_rate: int) -> str:
    """Transcribe a numpy array of audio samples."""
    _ensure_recognizer()

    # Skip silent/near-silent audio
    if not _has_speech_energy(samples):
        return ""

    chunk_size = CHUNK_SECONDS * sample_rate

    if len(samples) <= chunk_size * 1.5:
        stream = _recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples.tolist())
        _recognizer.decode_streams([stream])
        text = stream.result.text.strip()
        return "" if _is_hallucination(text) else text

    # Chunk long segments
    transcripts = []
    for i in range(0, len(samples), chunk_size):
        chunk = samples[i:i + chunk_size]
        if not _has_speech_energy(chunk):
            continue
        stream = _recognizer.create_stream()
        stream.accept_waveform(sample_rate, chunk.tolist())
        _recognizer.decode_streams([stream])
        text = stream.result.text.strip()
        if text and not _is_hallucination(text):
            transcripts.append(text)

    return " ".join(transcripts)


def _transcribe_plain(audio_path: str) -> str:
    """Transcribe audio file."""
    samples, sr = sf.read(audio_path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return _transcribe_samples(samples, sr)


# ── API ──────────────────────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    text: str
    duration_ms: int


@app.get("/health")
async def health():
    return {"status": "ok", "service": "transcription-gipformer", "model": REPO_ID}


_transcribe_lock = asyncio.Semaphore(1)


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(file: UploadFile):
    """Transcribe Vietnamese audio.

    Speaker diarization is handled separately by the diarization service (port 8097).
    """
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    t0 = time.monotonic()
    try:
        async with _transcribe_lock:
            logger.info("Transcribing %s...", file.filename)
            text = await asyncio.wait_for(
                asyncio.to_thread(_transcribe_plain, tmp_path),
                timeout=600.0,
            )
    except asyncio.TimeoutError:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.warning("Transcription timed out after %dms", elapsed_ms)
        return TranscribeResponse(text="", duration_ms=elapsed_ms)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    logger.info("Transcribed %s in %dms → %d chars", file.filename, elapsed_ms, len(text))
    return TranscribeResponse(text=text, duration_ms=elapsed_ms)


if __name__ == "__main__":
    import uvicorn
    signal.signal(signal.SIGINT, lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    uvicorn.run(app, host="0.0.0.0", port=8098)
