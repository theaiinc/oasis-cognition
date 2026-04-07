"""Transcription dispatch — GIPFormer for Vietnamese, MLX Whisper for others."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import httpx

from packages.shared_utils.config import get_settings

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".wma"}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm"}


async def transcribe_artifact(artifact: dict[str, Any], storage) -> str:
    """Transcribe audio/video artifact. Routes to GIPFormer for Vietnamese, MLX Whisper otherwise.

    If the diarization service is available, diarizes first, then transcribes
    each speaker segment separately and formats with speaker labels.
    """
    file_path = storage.file_path(artifact.get("file_path", ""))
    if not file_path.exists():
        logger.error("File not found: %s", file_path)
        return ""

    language = (artifact.get("language") or "").lower().strip()

    # Extract audio from video, or convert non-wav audio to wav for compatibility
    audio_path = file_path
    suffix = file_path.suffix.lower()
    if suffix in VIDEO_EXTENSIONS:
        audio_path = _extract_audio(file_path)
    elif suffix in AUDIO_EXTENSIONS and suffix != ".wav":
        audio_path = _convert_to_wav(file_path)

    # Auto-detect language from first 10s if not specified
    if not language:
        language = await _detect_language(audio_path)
        logger.info("Auto-detected language: %s", language)

    # Try diarize + per-segment transcription
    transcript = await _transcribe_with_diarization(audio_path, language)

    # Fallback: plain transcription without diarization
    if not transcript:
        if language in ("vi", "vie", "vietnamese"):
            transcript = await _transcribe_gipformer(audio_path, language)
        else:
            transcript = await _transcribe_whisper(audio_path, language)

    # Clean up temp audio if extracted from video
    if audio_path != file_path and audio_path.exists():
        audio_path.unlink()

    return transcript


async def _diarize(audio_path: Path) -> tuple[list[dict] | None, dict[str, list[float]] | None]:
    """Call the diarization service with embeddings. Returns (segments, speaker_embeddings) or (None, None)."""
    settings = get_settings()

    # Try diarize-with-embeddings first, fall back to plain diarize
    for endpoint in ("/diarize-with-embeddings", "/diarize"):
        url = f"{settings.diarization_service_url}{endpoint}"
        try:
            async with httpx.AsyncClient(timeout=600.0) as client:
                with open(audio_path, "rb") as f:
                    files = {"file": (audio_path.name, f, "audio/wav")}
                    resp = await client.post(url, files=files)
                resp.raise_for_status()
                data = resp.json()
                segments = data.get("segments", [])
                speaker_embeddings = data.get("speaker_embeddings")  # None for plain /diarize
                logger.info(
                    "Diarization (%s): %d segments, %d speakers, %.1fs audio in %dms, embeddings=%s",
                    endpoint, len(segments), data.get("num_speakers", 0),
                    data.get("audio_duration", 0), data.get("duration_ms", 0),
                    "yes" if speaker_embeddings else "no",
                )
                if segments:
                    return segments, speaker_embeddings
                return None, None
        except httpx.ConnectError:
            if endpoint == "/diarize-with-embeddings":
                continue  # try plain /diarize
            logger.info("Diarization service not available — skipping diarization")
            return None, None
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (404, 405) and endpoint == "/diarize-with-embeddings":
                logger.info("diarize-with-embeddings not available, trying plain /diarize")
                continue
            logger.warning("Diarization failed: %s — skipping", e)
            return None, None
        except Exception as e:
            logger.warning("Diarization failed: %s — skipping", e)
            return None, None
    return None, None


async def _identify_speakers(speaker_embeddings: dict[str, list[float]]) -> dict[str, str]:
    """Match speaker embeddings against known profiles in memory-service.

    Returns a mapping: { "speaker_001": "Steve", "speaker_002": "speaker_002" }
    Unknown speakers keep their auto-generated label.
    """
    settings = get_settings()
    memory_url = getattr(settings, "memory_service_url", None) or "http://localhost:8004"
    speaker_map: dict[str, str] = {}

    for spk_id, embedding in speaker_embeddings.items():
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{memory_url}/internal/memory/speakers/identify",
                    json={"embedding": embedding, "threshold": 0.65},
                )
                resp.raise_for_status()
                data = resp.json()
                matches = data.get("matches", [])
                if matches:
                    # Use the best match (highest similarity)
                    best = max(matches, key=lambda m: m.get("similarity", 0))
                    speaker_map[spk_id] = best.get("name", spk_id)
                    logger.info("Speaker %s identified as '%s' (sim=%.3f)",
                                spk_id, speaker_map[spk_id], best.get("similarity", 0))
                else:
                    speaker_map[spk_id] = spk_id
        except Exception as e:
            logger.debug("Speaker identification failed for %s: %s", spk_id, e)
            speaker_map[spk_id] = spk_id

    return speaker_map


def _merge_segments(segments: list[dict], gap_threshold: float = 1.0) -> list[dict]:
    """Merge consecutive segments from the same speaker if gap < threshold."""
    if not segments:
        return []
    merged = [dict(segments[0])]
    for seg in segments[1:]:
        prev = merged[-1]
        if seg["speaker"] == prev["speaker"] and (seg["start"] - prev["end"]) < gap_threshold:
            prev["end"] = seg["end"]
        else:
            merged.append(dict(seg))
    return merged


def _extract_segment_audio(audio_path: Path, start: float, end: float) -> Path:
    """Extract a time range from audio using ffmpeg."""
    import tempfile
    out = Path(tempfile.mktemp(suffix=".wav"))
    duration = end - start
    cmd = [
        "ffmpeg", "-ss", str(start), "-i", str(audio_path),
        "-t", str(duration),
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-y", str(out),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        logger.warning("ffmpeg segment extraction failed: %s", result.stderr[:200])
        return None
    return out


async def _transcribe_with_diarization(audio_path: Path, language: str) -> str:
    """Diarize first, then transcribe each speaker segment. Returns formatted transcript."""
    segments, speaker_embeddings = await _diarize(audio_path)
    if not segments:
        return ""

    # Merge consecutive same-speaker segments
    merged = _merge_segments(segments, gap_threshold=1.0)

    # Skip very short segments (< 0.5s — usually noise)
    merged = [s for s in merged if (s["end"] - s["start"]) >= 0.5]

    if not merged:
        return ""

    logger.info("Transcribing %d diarized segments (%s)", len(merged), language)

    # Identify speakers against known profiles (if embeddings available)
    speaker_name_map: dict[str, str] = {}
    if speaker_embeddings:
        try:
            speaker_name_map = await _identify_speakers(speaker_embeddings)
            logger.info("Speaker identification: %s", speaker_name_map)
        except Exception as e:
            logger.warning("Speaker identification failed: %s — using auto labels", e)

    # Choose transcriber based on language
    is_vietnamese = language in ("vi", "vie", "vietnamese")

    lines = []
    for i, seg in enumerate(merged):
        speaker = speaker_name_map.get(seg["speaker"], seg["speaker"])
        start = seg["start"]
        end = seg["end"]

        # Extract segment audio
        seg_audio = _extract_segment_audio(audio_path, start, end)
        if seg_audio is None:
            continue

        try:
            if is_vietnamese:
                # Call GIPFormer without diarization (we already diarized)
                from services.artifact_service.gipformer import transcribe_gipformer
                text = await transcribe_gipformer(seg_audio, diarize=False)
            else:
                text = await _transcribe_whisper(seg_audio, language)

            text = text.strip()
            if text:
                mins = int(start) // 60
                secs = int(start) % 60
                lines.append(f"[{mins:02d}:{secs:02d}] {speaker}: {text}")
        except Exception as e:
            logger.warning("Segment %d transcription failed: %s", i, e)
        finally:
            if seg_audio and seg_audio.exists():
                seg_audio.unlink()

        if (i + 1) % 10 == 0:
            logger.info("Transcribed %d/%d segments", i + 1, len(merged))

    result = "\n".join(lines)
    logger.info("Diarized transcription complete: %d lines, %d chars", len(lines), len(result))
    return result


async def _detect_language(audio_path: Path) -> str:
    """Detect language by finding the first 10s of actual speech, skipping silence/noise."""
    import base64
    import math
    import wave
    import struct
    import array

    settings = get_settings()
    url = f"{settings.transcription_service_url}/transcribe"
    MIN_RMS = 0.005  # Minimum RMS energy to count as speech
    SPEECH_SECONDS = 10  # How many seconds of speech to collect
    MAX_SCAN_SECONDS = 120  # Don't scan beyond this

    try:
        with wave.open(str(audio_path), "rb") as wf:
            sample_rate = wf.getframerate()
            n_channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            total_frames = wf.getnframes()
            max_frames = min(total_frames, MAX_SCAN_SECONDS * sample_rate)
            raw = wf.readframes(max_frames)

        actual_frames = max_frames
        if sample_width == 2:
            samples = struct.unpack(f"<{actual_frames * n_channels}h", raw)
        elif sample_width == 4:
            samples = struct.unpack(f"<{actual_frames * n_channels}i", raw)
            samples = [s >> 16 for s in samples]
        else:
            samples = list(raw)

        if n_channels > 1:
            mono = []
            for i in range(0, len(samples), n_channels):
                mono.append(sum(samples[i:i + n_channels]) // n_channels)
            samples = mono

        float_samples = [s / 32768.0 for s in samples]

        # Scan in 1-second windows, collect speech segments until we have SPEECH_SECONDS
        window = sample_rate  # 1 second
        speech_samples = []
        for i in range(0, len(float_samples), window):
            chunk = float_samples[i:i + window]
            rms = math.sqrt(sum(s * s for s in chunk) / len(chunk))
            if rms > MIN_RMS:
                speech_samples.extend(chunk)
                if len(speech_samples) >= SPEECH_SECONDS * sample_rate:
                    break

        if not speech_samples:
            logger.warning("No speech found in first %ds — defaulting to 'en'", MAX_SCAN_SECONDS)
            return "en"

        logger.info("Language detection: found %.1fs of speech in first %ds of audio",
                     len(speech_samples) / sample_rate, MAX_SCAN_SECONDS)

        chunk_arr = array.array("f", speech_samples[:SPEECH_SECONDS * sample_rate])
        audio_b64 = base64.b64encode(chunk_arr.tobytes()).decode("ascii")

        # Send without language — Whisper will auto-detect
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json={"audio_b64": audio_b64, "sample_rate": sample_rate})
            resp.raise_for_status()
            data = resp.json()
            detected = data.get("language", "").lower().strip()
            text = data.get("text", "")
            logger.info("Language detection: '%s' (text: %s...)", detected, text[:60])
            # Whisper returns ISO language codes like "vi", "en", "ja"
            if detected:
                return detected
            # Fallback: check if text looks Vietnamese (common diacritics)
            vietnamese_chars = set("àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ")
            if text and sum(1 for c in text.lower() if c in vietnamese_chars) > len(text) * 0.03:
                return "vi"
            return detected or "en"
    except Exception as e:
        logger.warning("Language detection failed: %s — defaulting to 'en'", e)
        return "en"


def _convert_to_wav(audio_path: Path) -> Path:
    """Convert any audio format to WAV for whisper compatibility."""
    wav_path = audio_path.with_suffix(".wav")
    if wav_path.exists():
        wav_path = Path(tempfile.mktemp(suffix=".wav", dir=audio_path.parent))
    cmd = [
        "ffmpeg", "-i", str(audio_path),
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-y", str(wav_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        logger.error("ffmpeg audio conversion failed: %s", result.stderr[:300])
        raise RuntimeError(f"Failed to convert {audio_path.suffix} to wav")
    return wav_path


def _extract_audio(video_path: Path) -> Path:
    """Extract audio from video using ffmpeg."""
    audio_path = video_path.with_suffix(".wav")
    cmd = [
        "ffmpeg", "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-y", str(audio_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        logger.error("ffmpeg audio extraction failed: %s", result.stderr[:300])
        raise RuntimeError("Failed to extract audio from video")
    return audio_path


async def _transcribe_whisper(audio_path: Path, language: str = "") -> str:
    """Send audio to the existing MLX Whisper transcription service.

    The service expects JSON: { audio_b64: base64(float32 PCM), sample_rate: 16000 }.
    For long audio (>30s), we chunk into segments and transcribe each.
    """
    import base64
    import wave
    import struct
    import array

    settings = get_settings()
    url = f"{settings.transcription_service_url}/transcribe"

    try:
        # Read wav and convert to float32 PCM
        with wave.open(str(audio_path), "rb") as wf:
            n_frames = wf.getnframes()
            sample_rate = wf.getframerate()
            n_channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            raw = wf.readframes(n_frames)

        if sample_width == 2:
            samples = struct.unpack(f"<{n_frames * n_channels}h", raw)
        elif sample_width == 4:
            samples = struct.unpack(f"<{n_frames * n_channels}i", raw)
            samples = [s >> 16 for s in samples]
        else:
            samples = list(raw)

        if n_channels > 1:
            mono = []
            for i in range(0, len(samples), n_channels):
                mono.append(sum(samples[i:i + n_channels]) // n_channels)
            samples = mono

        float_samples = [s / 32768.0 for s in samples]

        # Chunk into 30-second segments for reliability
        chunk_size = 30 * sample_rate  # 30 seconds
        chunks = [float_samples[i:i + chunk_size] for i in range(0, len(float_samples), chunk_size)]
        logger.info("Transcribing %d chunks (%.1fs total) via Whisper", len(chunks), len(float_samples) / sample_rate)

        transcripts = []
        limits = httpx.Limits(max_connections=1, max_keepalive_connections=1)
        async with httpx.AsyncClient(timeout=120.0, limits=limits) as client:
            for i, chunk in enumerate(chunks):
                chunk_arr = array.array("f", chunk)
                audio_b64 = base64.b64encode(chunk_arr.tobytes()).decode("ascii")
                payload = {"audio_b64": audio_b64, "sample_rate": sample_rate}
                if language:
                    payload["language"] = language
                max_retries = 3
                for attempt in range(max_retries):
                    try:
                        resp = await client.post(url, json=payload)
                        resp.raise_for_status()
                        text = resp.json().get("text", "").strip()
                        if text:
                            transcripts.append(text)
                        break
                    except Exception as e:
                        if attempt < max_retries - 1:
                            import asyncio
                            await asyncio.sleep(2)
                        else:
                            logger.warning("Chunk %d failed after %d retries: %s", i, max_retries, e)
                if (i + 1) % 10 == 0:
                    logger.info("Transcribed %d/%d chunks", i + 1, len(chunks))

        result = " ".join(transcripts)
        logger.info("Whisper transcription complete: %d chars", len(result))
        return result
    except Exception as e:
        logger.error("Whisper transcription failed: %s", e)
        return ""


async def _transcribe_gipformer(audio_path: Path, language: str = "vi") -> str:
    """Transcribe Vietnamese audio using GIPFormer host service.

    GIPFormer works best with Vietnamese — do not use for other languages.
    Falls back to Whisper if GIPFormer service is unavailable.
    """
    from services.artifact_service.gipformer import transcribe_gipformer

    text = await transcribe_gipformer(audio_path)
    if text:
        return text

    logger.warning("GIPFormer returned empty, falling back to Whisper with language=%s", language)
    return await _transcribe_whisper(audio_path, language)
