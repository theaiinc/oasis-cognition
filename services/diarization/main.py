"""Lightweight speaker diarization service using FoxNoseTech/diarize.

Runs on CPU via ONNX Runtime — no PyTorch, no GPU, ~400MB RAM.
Provides speaker segments (speaker_id, start, end) for any audio file.

Start with:
    python -m uvicorn services.diarization.main:app --host 0.0.0.0 --port 8097
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time

import torch
import numpy as np
import soundfile as sf

from fastapi import FastAPI, File, Query, UploadFile, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ── Monkey-patch torchaudio.load to use soundfile ─────────────────────
# torchaudio >= 2.9 requires torchcodec + FFmpeg shared libs which are
# hard to get right locally. We patch torchaudio.load itself so ALL
# downstream code (silero_vad, diarize, etc.) transparently uses soundfile.

def _patched_torchaudio_load(filepath, *args, **kwargs):
    """Drop-in replacement for torchaudio.load using soundfile."""
    wav, sr = sf.read(str(filepath), dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    tensor = torch.from_numpy(wav.copy()).unsqueeze(0)  # (1, num_samples)
    return tensor, sr

try:
    import torchaudio
    torchaudio.load = _patched_torchaudio_load
    logger.info("Patched torchaudio.load to use soundfile (bypassing torchcodec)")
except ImportError:
    pass

# Also patch silero_vad.read_audio for good measure
def _patched_read_audio(path, sampling_rate: int = 16000):
    """Drop-in replacement for silero_vad.read_audio using soundfile."""
    wav, sr = sf.read(str(path), dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sr != sampling_rate:
        duration = len(wav) / sr
        target_len = int(duration * sampling_rate)
        indices = np.linspace(0, len(wav) - 1, target_len)
        wav = np.interp(indices, np.arange(len(wav)), wav)
    return torch.from_numpy(wav.copy())

try:
    import silero_vad.utils_vad as _vad_utils
    _vad_utils.read_audio = _patched_read_audio
    logger.info("Patched silero_vad.read_audio to use soundfile")
except ImportError:
    pass

app = FastAPI(title="Oasis Diarization Service")


# ── Models ─────────────────────────────────────────────────────────────

class Segment(BaseModel):
    speaker: str
    start: float
    end: float


class DiarizeResponse(BaseModel):
    segments: list[Segment]
    num_speakers: int
    speakers: list[str]
    audio_duration: float
    duration_ms: int


class DiarizeWithEmbeddingsResponse(DiarizeResponse):
    speaker_embeddings: dict[str, list[float]]


class SpeakerMatch(BaseModel):
    speaker_id: str
    matched_name: str | None
    similarity: float


class IdentifyResponse(BaseModel):
    matches: list[SpeakerMatch]
    unmatched: list[str]


class VoiceprintResponse(BaseModel):
    embedding: list[float]
    duration_seconds: float
    num_speech_segments: int


class KnownSpeaker(BaseModel):
    name: str
    embedding: list[float]


class IdentifyRequest(BaseModel):
    known_speakers: list[KnownSpeaker]


# ── Lazy-load diarize library ──────────────────────────────────────────

_diarize_fn = None
_vad_fn = None
_embed_fn = None
_cluster_fn = None


def _ensure_loaded():
    global _diarize_fn
    if _diarize_fn is not None:
        return
    from diarize import diarize
    _diarize_fn = diarize
    logger.info("Diarize library loaded (ONNX Runtime, CPU-only)")


def _ensure_pipeline_loaded():
    """Lazy-load the individual diarize pipeline components (VAD, embeddings, clustering)."""
    global _vad_fn, _embed_fn, _cluster_fn
    if _vad_fn is not None:
        return
    from diarize.vad import run_vad
    from diarize.embeddings import extract_embeddings
    from diarize.clustering import cluster_speakers
    _vad_fn = run_vad
    _embed_fn = extract_embeddings
    _cluster_fn = cluster_speakers
    logger.info("Diarize pipeline modules loaded (vad, embeddings, clustering)")


def _cleanup(tmp_path: str, wav_path: str | None) -> None:
    os.unlink(tmp_path)
    if wav_path and os.path.exists(wav_path):
        os.unlink(wav_path)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _run_pipeline(diarize_path: str, num_speakers=None, min_speakers=None, max_speakers=None):
    """Run VAD → embeddings → clustering pipeline. Returns (segments, speaker_embeddings, details)."""
    _ensure_pipeline_loaded()

    # Step 1: VAD
    speech_segments = _vad_fn(diarize_path)

    # Step 2: Extract embeddings
    embeddings, sub_segments = _embed_fn(diarize_path, speech_segments)

    # Step 3: Cluster
    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers
    labels, details = _cluster_fn(embeddings, **kwargs)

    # Build segments and per-speaker averaged embeddings
    speaker_set = sorted(set(int(l) for l in labels if l >= 0))
    speaker_map = {s: f"speaker_{s:03d}" for s in speaker_set}

    segments = []
    for i, sub_seg in enumerate(sub_segments):
        label = int(labels[i])
        if label < 0:
            continue
        segments.append(Segment(
            speaker=speaker_map[label],
            start=float(sub_seg.start) if hasattr(sub_seg, 'start') else float(sub_seg[0]),
            end=float(sub_seg.end) if hasattr(sub_seg, 'end') else float(sub_seg[1]),
        ))

    # Compute centroid embedding per speaker
    speaker_embeddings: dict[str, list[float]] = {}
    for speaker_label in speaker_set:
        mask = labels == speaker_label
        centroid = embeddings[mask].mean(axis=0)
        speaker_embeddings[speaker_map[speaker_label]] = centroid.tolist()

    # Get audio duration
    import soundfile as _sf
    info = _sf.info(diarize_path)
    audio_duration = info.duration

    return segments, speaker_embeddings, sorted(speaker_map.values()), audio_duration


# ── Endpoint ───────────────────────────────────────────────────────────

@app.post("/diarize", response_model=DiarizeResponse)
async def diarize_audio(
    file: UploadFile = File(...),
    num_speakers: int | None = Query(None, description="Known number of speakers"),
    min_speakers: int | None = Query(None, description="Minimum speakers to detect"),
    max_speakers: int | None = Query(None, description="Maximum speakers to detect"),
):
    """Diarize an audio file and return speaker segments."""
    _ensure_loaded()

    # Save upload to temp file
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    # Convert to 16kHz mono WAV if needed (diarize/silero_vad expect WAV)
    wav_path = None
    if suffix.lower() != ".wav":
        wav_path = tmp_path + ".wav"
        cmd = [
            os.environ.get("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg"), "-i", tmp_path,
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", wav_path,
        ]
        conv = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if conv.returncode != 0:
            logger.warning("ffmpeg conversion failed: %s", conv.stderr[:200])
            wav_path = None
        else:
            logger.info("Converted %s → WAV for diarization", suffix)

    diarize_path = wav_path or tmp_path

    try:
        t0 = time.time()

        # Build kwargs
        kwargs = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        result = _diarize_fn(diarize_path, **kwargs)
        elapsed_ms = int((time.time() - t0) * 1000)

        segments = [
            Segment(speaker=seg.speaker, start=seg.start, end=seg.end)
            for seg in result.segments
        ]

        logger.info(
            "Diarized %s: %d segments, %d speakers, %.1fs audio in %dms",
            file.filename, len(segments), result.num_speakers,
            result.audio_duration, elapsed_ms,
        )

        return DiarizeResponse(
            segments=segments,
            num_speakers=result.num_speakers,
            speakers=result.speakers,
            audio_duration=result.audio_duration,
            duration_ms=elapsed_ms,
        )

    except Exception as e:
        logger.exception("Diarization failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(tmp_path)
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)


# ── Diarize with Embeddings ───────────────────────────────────────────

@app.post("/diarize-with-embeddings", response_model=DiarizeWithEmbeddingsResponse)
async def diarize_with_embeddings(
    file: UploadFile = File(...),
    num_speakers: int | None = Query(None, description="Known number of speakers"),
    min_speakers: int | None = Query(None, description="Minimum speakers to detect"),
    max_speakers: int | None = Query(None, description="Maximum speakers to detect"),
):
    """Diarize an audio file and return speaker segments with per-speaker averaged embeddings."""
    file_bytes = await file.read()
    file._bytes = file_bytes

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    wav_path = None
    if suffix.lower() != ".wav":
        wav_path = tmp_path + ".wav"
        cmd = [
            os.environ.get("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg"), "-i", tmp_path,
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", wav_path,
        ]
        conv = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if conv.returncode != 0:
            logger.warning("ffmpeg conversion failed: %s", conv.stderr[:200])
            wav_path = None
        else:
            logger.info("Converted %s → WAV for diarization", suffix)

    diarize_path = wav_path or tmp_path

    try:
        t0 = time.time()
        segments, speaker_embeddings, speakers, audio_duration = _run_pipeline(
            diarize_path, num_speakers=num_speakers,
            min_speakers=min_speakers, max_speakers=max_speakers,
        )
        elapsed_ms = int((time.time() - t0) * 1000)

        logger.info(
            "Diarized+embeddings %s: %d segments, %d speakers, %.1fs audio in %dms",
            file.filename, len(segments), len(speakers), audio_duration, elapsed_ms,
        )

        return DiarizeWithEmbeddingsResponse(
            segments=segments,
            num_speakers=len(speakers),
            speakers=speakers,
            audio_duration=audio_duration,
            duration_ms=elapsed_ms,
            speaker_embeddings=speaker_embeddings,
        )
    except Exception as e:
        logger.exception("Diarize-with-embeddings failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(tmp_path, wav_path)


# ── Identify Speakers ─────────────────────────────────────────────────

@app.post("/identify-speakers", response_model=IdentifyResponse)
async def identify_speakers(
    file: UploadFile = File(...),
    known_speakers_json: str = Query(..., description="JSON array of {name, embedding} objects"),
    num_speakers: int | None = Query(None),
    min_speakers: int | None = Query(None),
    max_speakers: int | None = Query(None),
    threshold: float = Query(0.65, description="Cosine similarity threshold for matching"),
):
    """Diarize audio and identify speakers against known profiles."""
    import json as _json

    try:
        known_speakers = [KnownSpeaker(**ks) for ks in _json.loads(known_speakers_json)]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid known_speakers_json: {e}")

    file_bytes = await file.read()

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    wav_path = None
    if suffix.lower() != ".wav":
        wav_path = tmp_path + ".wav"
        cmd = [
            os.environ.get("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg"), "-i", tmp_path,
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", wav_path,
        ]
        conv = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if conv.returncode != 0:
            wav_path = None

    diarize_path = wav_path or tmp_path

    try:
        segments, speaker_embeddings, speakers, audio_duration = _run_pipeline(
            diarize_path, num_speakers=num_speakers,
            min_speakers=min_speakers, max_speakers=max_speakers,
        )

        known_embs = [(ks.name, np.array(ks.embedding, dtype=np.float32)) for ks in known_speakers]

        matches = []
        matched_speaker_ids = set()
        for spk_id, emb_list in speaker_embeddings.items():
            spk_emb = np.array(emb_list, dtype=np.float32)
            best_name = None
            best_sim = -1.0
            for name, known_emb in known_embs:
                sim = _cosine_similarity(spk_emb, known_emb)
                if sim > best_sim:
                    best_sim = sim
                    best_name = name
            if best_sim >= threshold:
                matches.append(SpeakerMatch(speaker_id=spk_id, matched_name=best_name, similarity=best_sim))
                matched_speaker_ids.add(spk_id)
            else:
                matches.append(SpeakerMatch(speaker_id=spk_id, matched_name=None, similarity=best_sim))

        unmatched = [spk_id for spk_id in speaker_embeddings if spk_id not in matched_speaker_ids]

        return IdentifyResponse(matches=matches, unmatched=unmatched)
    except Exception as e:
        logger.exception("Speaker identification failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(tmp_path, wav_path)


# ── Extract Voiceprint ────────────────────────────────────────────────

@app.post("/extract-voiceprint", response_model=VoiceprintResponse)
async def extract_voiceprint(
    file: UploadFile = File(...),
):
    """Extract a single averaged 256-dim voiceprint embedding for the dominant speaker."""
    file_bytes = await file.read()

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    wav_path = None
    if suffix.lower() != ".wav":
        wav_path = tmp_path + ".wav"
        cmd = [
            os.environ.get("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg"), "-i", tmp_path,
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", wav_path,
        ]
        conv = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if conv.returncode != 0:
            wav_path = None

    diarize_path = wav_path or tmp_path

    try:
        _ensure_pipeline_loaded()

        # Run VAD + embeddings (no clustering needed — just average everything)
        speech_segments = _vad_fn(diarize_path)
        if not speech_segments:
            raise HTTPException(status_code=400, detail="No speech detected in audio")

        embeddings, sub_segments = _embed_fn(diarize_path, speech_segments)
        if len(embeddings) == 0:
            raise HTTPException(status_code=400, detail="Could not extract embeddings")

        # Average all embeddings to get a single voiceprint
        centroid = embeddings.mean(axis=0)

        # Audio duration
        info = sf.info(diarize_path)

        return VoiceprintResponse(
            embedding=centroid.tolist(),
            duration_seconds=info.duration,
            num_speech_segments=len(speech_segments),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Voiceprint extraction failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(tmp_path, wav_path)


# ── Health ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "diarization", "engine": "FoxNoseTech/diarize", "runtime": "onnx-cpu"}
