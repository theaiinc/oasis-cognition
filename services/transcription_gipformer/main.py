"""Native GIPFormer Vietnamese ASR service with speaker diarization.

Runs on the host (not Docker) — uses sherpa-onnx for transcription and
pyannote-audio for speaker diarization.

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

app = FastAPI(title="Oasis Transcription (GIPFormer Vietnamese + Diarization)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

HF_TOKEN = os.getenv("HF_TOKEN", "")
# Set globally so pyannote's internal hf_hub_download calls also use it
os.environ["HF_TOKEN"] = HF_TOKEN

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


# ── Pyannote diarization ────────────────────────────────────────────────────

_diarization_pipeline = None


def _ensure_diarization():
    """Lazy-load the pyannote speaker diarization pipeline."""
    global _diarization_pipeline
    if _diarization_pipeline is not None:
        return

    import torch
    from pyannote.audio import Pipeline

    logger.info("Loading pyannote speaker-diarization-3.1...")
    _diarization_pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=HF_TOKEN,
    )

    # Use MPS (Apple Silicon GPU) if available for faster inference
    if torch.backends.mps.is_available():
        _diarization_pipeline.to(torch.device("mps"))
        logger.info("Pyannote diarization pipeline ready (MPS accelerated)")
    else:
        logger.info("Pyannote diarization pipeline ready (CPU)")


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
    """Transcribe without diarization."""
    samples, sr = sf.read(audio_path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return _transcribe_samples(samples, sr)


def _transcribe_with_diarization(audio_path: str) -> str:
    """Diarize then transcribe each speaker segment."""
    import torch
    import torchaudio

    _ensure_diarization()
    _ensure_recognizer()

    logger.info("Running speaker diarization on %s...", Path(audio_path).name)

    # Load audio with torchaudio (bypasses broken torchcodec)
    waveform, sr = torchaudio.load(audio_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)

    # pyannote accepts pre-loaded audio as a dict to avoid torchcodec
    output = _diarization_pipeline({"waveform": waveform, "sample_rate": sr})

    # DiarizeOutput wraps an Annotation — extract it
    diarization = getattr(output, "speaker_diarization", output)

    # Convert to numpy for GIPFormer
    samples = waveform.squeeze().numpy()

    # Collect segments per speaker
    segments: list[tuple[str, float, float]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append((speaker, turn.start, turn.end))

    if not segments:
        logger.warning("No speakers detected, falling back to plain transcription")
        return _transcribe_samples(samples, sr)

    # Merge consecutive segments from the same speaker (within 1s gap)
    merged: list[tuple[str, float, float]] = [segments[0]]
    for speaker, start, end in segments[1:]:
        prev_speaker, prev_start, prev_end = merged[-1]
        if speaker == prev_speaker and start - prev_end < 1.0:
            merged[-1] = (speaker, prev_start, end)
        else:
            merged.append((speaker, start, end))

    logger.info("Diarization: %d segments, %d speakers",
                len(merged), len(set(s for s, _, _ in merged)))

    # Transcribe each segment
    lines = []
    skipped = 0
    for speaker, start, end in merged:
        start_sample = int(start * sr)
        end_sample = int(end * sr)
        segment_samples = samples[start_sample:end_sample]

        # Skip very short segments (< 0.5s)
        if len(segment_samples) < sr * 0.5:
            skipped += 1
            continue

        text = _transcribe_samples(segment_samples, sr)
        if text:
            minutes_s = int(start) // 60
            seconds_s = int(start) % 60
            lines.append(f"[{minutes_s:02d}:{seconds_s:02d}] {speaker}: {text}")
        else:
            skipped += 1

    logger.info("Transcribed %d segments, skipped %d (silent/hallucinated)", len(lines), skipped)

    return "\n".join(lines)


# ── API ──────────────────────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    text: str
    duration_ms: int
    speakers: int = 0


@app.get("/health")
async def health():
    return {"status": "ok", "service": "transcription-gipformer", "model": REPO_ID}


# Only allow one transcription at a time — MPS segfaults on concurrent pyannote
_transcribe_lock = asyncio.Semaphore(1)


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(file: UploadFile, diarize: bool = True):
    """Transcribe Vietnamese audio, optionally with speaker diarization.

    Query param ?diarize=false to skip diarization.
    """
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    t0 = time.monotonic()
    try:
        async with _transcribe_lock:
            # Diarization is now handled by the standalone diarization service (port 8097).
            # GIPFormer only does transcription — always use plain mode.
            logger.info("Acquired transcribe lock for %s (diarize param ignored, using plain mode)", file.filename)
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

    # Count unique speakers from diarized output
    speaker_count = len(set(
        line.split("] ")[1].split(":")[0]
        for line in text.split("\n")
        if "] " in line and ":" in line
    )) if diarize else 0

    logger.info("Transcribed %s in %dms → %d chars, %d speakers",
                file.filename, elapsed_ms, len(text), speaker_count)
    return TranscribeResponse(text=text, duration_ms=elapsed_ms, speakers=speaker_count)


if __name__ == "__main__":
    import uvicorn
    signal.signal(signal.SIGINT, lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    uvicorn.run(app, host="0.0.0.0", port=8098)
