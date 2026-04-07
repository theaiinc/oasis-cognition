"""Voice agent for Oasis Cognition.

Uses the LiveKit Python SDK directly to:
  - Join a LiveKit room as the "oasis-agent" participant
  - Receive user audio, transcribe with faster-whisper
  - Capture screen share frames → OCR for development context
  - Send transcript + thinking + response events as LiveKit data messages
  - Call the Oasis reasoning pipeline with screen context
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import httpx
import numpy as np

logger = logging.getLogger(__name__)

OASIS_API_URL = os.getenv("OASIS_API_URL", "http://localhost:8000")
RESPONSE_GENERATOR_URL = os.getenv("RESPONSE_GENERATOR_URL", "http://localhost:8005")
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
LIVEKIT_EXTERNAL_URL = os.getenv("LIVEKIT_EXTERNAL_URL", "ws://localhost:7880")
TRANSCRIPTION_URL = os.getenv("TRANSCRIPTION_URL", "http://host.docker.internal:8099")
logger.info("Voice agent config: TRANSCRIPTION_URL=%s", TRANSCRIPTION_URL)

# ─── Transcript cleanup (LLM) ────────────────────────────────────────────────

async def cleanup_transcript(raw_text: str) -> str:
    """Rewrite raw ASR text into a clean version for downstream LLMs."""
    raw = (raw_text or "").strip()
    if not raw:
        return ""
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(
                f"{RESPONSE_GENERATOR_URL}/internal/response/transcript-cleanup",
                json={"raw_text": raw},
            )
            resp.raise_for_status()
            data = resp.json()
            cleaned = (data.get("cleaned_text") or "").strip()
            return cleaned or raw
        except Exception as e:
            logger.warning("Transcript cleanup failed; using raw transcript. err=%s", e)
            return raw

# ─── Oasis API caller ────────────────────────────────────────────────────────

def _parse_ndjson_interaction(text: str) -> dict:
    last: dict | None = None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            continue
        if obj.get("_oasis_keepalive"):
            continue
        if obj.get("_oasis_error"):
            body = obj.get("body") or {}
            if isinstance(body, dict):
                detail = body.get("detail", body.get("error", json.dumps(body)))
            else:
                detail = str(body)
            raise RuntimeError(str(detail))
        last = obj
    if not last:
        raise RuntimeError("empty interaction response")
    return last


async def call_oasis(text: str, session_id: str, screen_image: str = "", client_message_id: str | None = None) -> dict:
    """Send user text + screen image to the Oasis reasoning pipeline."""
    timeout = httpx.Timeout(connect=30.0, read=3600.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            context: dict = {"source": "voice"}
            if client_message_id:
                context["client_message_id"] = client_message_id
            if screen_image:
                context["screen_image"] = screen_image

            resp = await client.post(
                f"{OASIS_API_URL}/api/v1/interaction",
                json={
                    "user_message": text,
                    "session_id": session_id,
                    "context": context,
                },
            )
            resp.raise_for_status()
            ct = resp.headers.get("content-type", "")
            if "ndjson" in ct:
                data = _parse_ndjson_interaction(resp.text)
            else:
                data = resp.json()
            return {
                "response": data.get("response", "I couldn't process that."),
                "confidence": str(data.get("confidence", "")),
            }
        except httpx.HTTPStatusError as e:
            # Gateway returned an HTTP error — try to parse the JSON body for detail
            logger.error("Oasis API HTTP %d: %s", e.response.status_code, e.response.text[:200])
            try:
                body = e.response.json()
                detail = body.get("detail", body.get("error", ""))
                if isinstance(detail, dict):
                    detail = detail.get("detail", str(detail))
                friendly = f"Pipeline error: {detail}" if detail else "The reasoning pipeline encountered an error."
            except Exception:
                friendly = f"The reasoning pipeline returned an error (HTTP {e.response.status_code})."
            return {"response": friendly, "confidence": ""}
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            logger.error("Oasis API unreachable: %s", e)
            return {"response": "The reasoning engine is currently unreachable. Please try again in a moment.", "confidence": ""}
        except Exception as e:
            logger.error("Oasis API call failed: %s", e)
            return {"response": "An unexpected error occurred while processing your request.", "confidence": ""}


# ─── Screen Context Capture ──────────────────────────────────────────────────

class ScreenContextCapture:
    """Captures screen share video frames as base64 JPEG for vision LLM."""

    def __init__(self):
        self._latest_image_b64: str = ""
        self._last_capture_time: float = 0
        self._capture_interval: float = 2.0  # seconds between captures
        self._is_active: bool = False

    async def process_video_frame(self, frame) -> None:
        """Capture a video frame as a compressed JPEG base64 string."""
        now = time.monotonic()
        if (now - self._last_capture_time) < self._capture_interval:
            return

        self._is_active = True
        self._last_capture_time = now

        try:
            # LiveKit VideoFrame: convert to RGBA via frame.convert(RGBA) then use .data
            from livekit import rtc as _rtc
            rgba_frame = frame.convert(_rtc.VideoBufferType.RGBA)
            width = rgba_frame.width
            height = rgba_frame.height

            if width == 0 or height == 0:
                return

            arr = np.frombuffer(rgba_frame.data, dtype=np.uint8)

            expected = width * height * 4
            if len(arr) < expected:
                logger.warning("Frame buffer too small: got %d, expected %d", len(arr), expected)
                return

            arr = arr[:expected].reshape((height, width, 4))
            rgb = arr[:, :, :3]  # RGBA → RGB

            b64 = await asyncio.get_event_loop().run_in_executor(
                None, self._encode_jpeg, rgb
            )
            if b64:
                self._latest_image_b64 = b64
                logger.info("Screen capture: %dx%d → %d KB base64", width, height, len(b64) // 1024)

        except Exception as e:
            logger.error("Frame processing error: %s", e, exc_info=True)

    @staticmethod
    def _encode_jpeg(rgb_array: np.ndarray) -> str:
        """Encode RGB numpy array to base64 JPEG."""
        import base64
        import io
        from PIL import Image

        img = Image.fromarray(rgb_array)
        # Resize for reasonable payload size — keep high enough for text readability
        max_dim = 1920
        if img.width > max_dim or img.height > max_dim:
            ratio = max_dim / max(img.width, img.height)
            img = img.resize(
                (int(img.width * ratio), int(img.height * ratio)),
                Image.LANCZOS,  # high-quality downscale for sharp text
            )
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    @property
    def latest_image(self) -> str:
        """Return the most recent screen frame as base64 JPEG (or empty string)."""
        return self._latest_image_b64

    @property
    def has_context(self) -> bool:
        return bool(self._latest_image_b64)

    @property
    def is_active(self) -> bool:
        return self._is_active


# ─── Speaker Verification (Voice ID) ─────────────────────────────────────────

VOICE_PROFILE_PATH = os.getenv("VOICE_PROFILE_PATH", "/tmp/oasis-voice-profile.npy")


class SpeakerVerifier:
    """Speaker verification using resemblyzer voice embeddings.

    Compares incoming audio against an enrolled voice profile.
    Only audio that matches the enrolled speaker is accepted.
    """

    def __init__(self, similarity_threshold: float = 0.75):
        self._encoder = None
        self._enrolled_embedding: np.ndarray | None = None
        self._similarity_threshold = similarity_threshold
        self._enabled = True
        # Load saved profile if it exists
        self._load_profile()

    def _ensure_encoder(self):
        if self._encoder is None:
            try:
                from resemblyzer import VoiceEncoder
                self._encoder = VoiceEncoder(device="cpu")
                logger.info("Speaker encoder loaded (resemblyzer)")
            except ImportError:
                logger.error("resemblyzer not installed — speaker verification disabled")
                self._enabled = False

    def _load_profile(self):
        """Load previously saved voice profile from disk."""
        try:
            if os.path.exists(VOICE_PROFILE_PATH):
                self._enrolled_embedding = np.load(VOICE_PROFILE_PATH)
                logger.info("Loaded voice profile from %s", VOICE_PROFILE_PATH)
        except Exception as e:
            logger.warning("Failed to load voice profile: %s", e)

    def _save_profile(self):
        """Save current voice profile to disk for persistence."""
        if self._enrolled_embedding is not None:
            try:
                np.save(VOICE_PROFILE_PATH, self._enrolled_embedding)
                logger.info("Saved voice profile to %s", VOICE_PROFILE_PATH)
            except Exception as e:
                logger.warning("Failed to save voice profile: %s", e)

    @property
    def is_enrolled(self) -> bool:
        return self._enrolled_embedding is not None

    @property
    def is_enabled(self) -> bool:
        return self._enabled and self._enrolled_embedding is not None

    def enroll(self, audio_np: np.ndarray, sample_rate: int) -> bool:
        """Enroll the user's voice from an audio sample (at least 2-3 seconds).

        Returns True if enrollment succeeded.
        """
        self._ensure_encoder()
        if not self._enabled:
            return False

        try:
            # Resample to 16kHz if needed (resemblyzer expects 16kHz)
            audio_16k = self._resample(audio_np, sample_rate)
            if len(audio_16k) < 16000:  # Need at least 1 second
                logger.warning("Enrollment audio too short (%d samples)", len(audio_16k))
                return False

            from resemblyzer import preprocess_wav
            processed = preprocess_wav(audio_16k, source_sr=16000)
            embedding = self._encoder.embed_utterance(processed)
            self._enrolled_embedding = embedding
            self._save_profile()
            logger.info("Voice enrollment successful (embedding shape: %s)", embedding.shape)
            return True
        except Exception as e:
            logger.error("Enrollment failed: %s", e)
            return False

    def verify(self, audio_np: np.ndarray, sample_rate: int) -> tuple[bool, float]:
        """Check if audio matches the enrolled speaker.

        Returns (is_match, similarity_score).
        """
        if not self._enabled or self._enrolled_embedding is None:
            return True, 1.0  # If not enabled/enrolled, always pass

        self._ensure_encoder()
        if not self._enabled:
            return True, 1.0

        try:
            audio_16k = self._resample(audio_np, sample_rate)
            if len(audio_16k) < 8000:  # Need at least 0.5s for a reliable embedding
                return True, 1.0  # Too short to verify — let it through

            from resemblyzer import preprocess_wav
            processed = preprocess_wav(audio_16k, source_sr=16000)
            embedding = self._encoder.embed_utterance(processed)

            # Cosine similarity
            similarity = float(np.dot(self._enrolled_embedding, embedding) / (
                np.linalg.norm(self._enrolled_embedding) * np.linalg.norm(embedding) + 1e-8
            ))

            is_match = similarity >= self._similarity_threshold
            if not is_match:
                logger.info("Speaker rejected (similarity=%.3f, threshold=%.3f)", similarity, self._similarity_threshold)
            return is_match, similarity
        except Exception as e:
            logger.error("Speaker verification error: %s", e)
            return True, 1.0  # On error, let it through

    def clear_enrollment(self):
        """Clear the enrolled voice profile."""
        self._enrolled_embedding = None
        try:
            if os.path.exists(VOICE_PROFILE_PATH):
                os.remove(VOICE_PROFILE_PATH)
                logger.info("Voice profile cleared")
        except Exception as e:
            logger.warning("Failed to remove voice profile: %s", e)

    @staticmethod
    def _resample(audio_np: np.ndarray, sample_rate: int) -> np.ndarray:
        """Resample audio to 16kHz."""
        if sample_rate == 16000:
            return audio_np.astype(np.float32)
        try:
            import scipy.signal
            num_samples = int(len(audio_np) * 16000 / sample_rate)
            return scipy.signal.resample(audio_np, num_samples).astype(np.float32)
        except ImportError:
            ratio = sample_rate // 16000
            if ratio > 1:
                return audio_np[::ratio].astype(np.float32)
            return audio_np.astype(np.float32)


# ─── Audio buffer + VAD + STT ─────────────────────────────────────────────────

class AudioTranscriber:
    """Buffers incoming audio, detects silence, transcribes with faster-whisper.

    Uses adaptive noise floor estimation so background noise (fans, traffic,
    keyboard clicks) is ignored while speech is still detected reliably.
    """

    def __init__(self):
        self._buffer: list[np.ndarray] = []
        self._buffer_duration = 0.0
        self._silence_start: float | None = None
        self._is_speaking = False
        self._model = None
        # Require at least 0.8s of speech before accepting an utterance.
        self._min_speech_duration = 0.8
        # Wait 5s of silence before finalising — tolerates natural pauses
        # (thinking, short breaths) without cutting the speaker off mid-thought.
        self._silence_threshold = 5.0
        # Hard cap per utterance to avoid buffering minutes of audio. This roughly
        # corresponds to how long you can talk continuously before we *force* a cut.
        # Increased to ~60s so longer thoughts aren't truncated prematurely.
        self._max_utterance_duration = 60.0

        # ── Adaptive noise gate ──────────────────────────────────────────
        # Instead of a fixed energy threshold, we track the ambient noise
        # floor and set the speech threshold dynamically above it.
        self._noise_floor = 0.01          # initial estimate (will adapt down)
        self._noise_floor_alpha = 0.02    # EMA smoothing for noise floor (slow)
        self._speech_multiplier = 3.5     # speech must be 3.5x louder than noise
        self._min_energy_threshold = 0.008  # absolute minimum (prevents zero-floor)
        self._max_energy_threshold = 0.06   # cap so loud environments still work
        # Track consecutive speech frames to avoid single-frame triggers (clicks)
        self._speech_frame_count = 0
        self._min_speech_frames = 3       # need 3+ consecutive frames above threshold

    def _get_energy_threshold(self) -> float:
        """Compute adaptive energy threshold from current noise floor."""
        adaptive = self._noise_floor * self._speech_multiplier
        return max(self._min_energy_threshold, min(adaptive, self._max_energy_threshold))

    def _update_noise_floor(self, rms: float):
        """Update noise floor estimate using EMA (only when NOT speaking)."""
        if not self._is_speaking:
            self._noise_floor = (
                self._noise_floor_alpha * rms
                + (1 - self._noise_floor_alpha) * self._noise_floor
            )

    def add_audio(self, audio_np: np.ndarray, sample_rate: int) -> str | None:
        rms = float(np.sqrt(np.mean(audio_np ** 2))) if len(audio_np) > 0 else 0.0
        frame_duration = len(audio_np) / sample_rate
        now = time.monotonic()

        threshold = self._get_energy_threshold()

        if rms > threshold:
            self._speech_frame_count += 1
            # Only start speaking after sustained frames above threshold
            # This filters out transient spikes (clicks, coughs, bumps)
            if self._speech_frame_count >= self._min_speech_frames or self._is_speaking:
                self._is_speaking = True
                self._silence_start = None
                self._buffer.append(audio_np)
                self._buffer_duration += frame_duration
                # If we have been speaking for too long, force a cut.
                if self._buffer_duration >= self._max_utterance_duration:
                    transcript = self._transcribe(sample_rate)
                    self._reset()
                    return transcript
            else:
                # Collecting pre-speech frames (add to buffer so we don't clip the start)
                self._buffer.append(audio_np)
                self._buffer_duration += frame_duration
        else:
            self._speech_frame_count = 0
            self._update_noise_floor(rms)

            if self._is_speaking:
                self._buffer.append(audio_np)
                self._buffer_duration += frame_duration
                if self._silence_start is None:
                    self._silence_start = now
                elif (now - self._silence_start) >= self._silence_threshold:
                    if self._buffer_duration >= self._min_speech_duration:
                        transcript = self._transcribe(sample_rate)
                        self._reset()
                        return transcript
                    else:
                        self._reset()
            elif self._buffer_duration > 0 and not self._is_speaking:
                # Had some pre-speech frames but never hit min_speech_frames — discard
                self._reset()
        return None

    def set_speaker_verifier(self, verifier: SpeakerVerifier):
        """Attach a speaker verifier to filter out non-enrolled voices."""
        self._speaker_verifier = verifier

    @staticmethod
    def _trim_silence(audio_np: np.ndarray, sample_rate: int, threshold: float = 0.01, margin: float = 0.15) -> np.ndarray:
        """Trim leading and trailing silence from audio. Keeps a small margin."""
        frame_len = int(sample_rate * 0.02)  # 20ms frames
        margin_samples = int(sample_rate * margin)
        energies = []
        for i in range(0, len(audio_np) - frame_len, frame_len):
            energies.append(float(np.sqrt(np.mean(audio_np[i:i + frame_len] ** 2))))
        if not energies:
            return audio_np
        # Find first and last frame above threshold
        start_frame = 0
        for i, e in enumerate(energies):
            if e > threshold:
                start_frame = i
                break
        end_frame = len(energies) - 1
        for i in range(len(energies) - 1, -1, -1):
            if energies[i] > threshold:
                end_frame = i
                break
        start_sample = max(0, start_frame * frame_len - margin_samples)
        end_sample = min(len(audio_np), (end_frame + 1) * frame_len + margin_samples)
        trimmed = audio_np[start_sample:end_sample]
        if len(trimmed) < int(sample_rate * 0.3):
            return audio_np  # Don't trim to nothing
        return trimmed

    def _transcribe(self, sample_rate: int) -> str | None:
        if not self._buffer:
            return None

        audio_np = np.concatenate(self._buffer)

        # Trim leading/trailing silence to reduce transcription payload
        original_dur = len(audio_np) / sample_rate
        audio_np = self._trim_silence(audio_np, sample_rate)
        trimmed_dur = len(audio_np) / sample_rate
        if original_dur - trimmed_dur > 0.5:
            logger.info("Trimmed audio: %.1fs → %.1fs", original_dur, trimmed_dur)

        # ── Speaker verification: reject if voice doesn't match enrolled user ──
        verifier: SpeakerVerifier | None = getattr(self, "_speaker_verifier", None)
        if verifier and verifier.is_enabled:
            is_match, similarity = verifier.verify(audio_np, sample_rate)
            if not is_match:
                logger.info("Discarding utterance — speaker not matched (sim=%.3f)", similarity)
                return None

        # Call native MLX transcription service (Apple Silicon GPU)
        text = self._transcribe_via_mlx(audio_np, sample_rate)
        if text is None:
            return None

        # ── Hallucination filter ──
        text_lower = text.lower().strip(" .")
        hallucinations = {
            "", "thank you", "thanks for watching", "you", "bye",
            "thanks", "thank you for watching", "okay", "oh",
            "subscribe", "like and subscribe", "thanks for listening",
            "bye bye", "good bye", "goodbye", "see you",
            "the end", "subtitles by", "translated by",
        }
        if text_lower in hallucinations:
            logger.info("Filtered hallucination (exact): %r", text)
            return None
        hallucination_substrings = [
            "subscribe to", "like and subscribe", "thanks for watching",
            "subtitles by", "translated by", "captions by",
            "♪", "[music]", "(music)", "[applause]", "(applause)",
        ]
        for pattern in hallucination_substrings:
            if pattern in text_lower:
                logger.info("Filtered hallucination (substring %r): %r", pattern, text)
                return None
        words = text_lower.split()
        if len(words) >= 3 and len(set(words)) <= 2:
            logger.info("Filtered hallucination (repetitive): %r", text)
            return None
        if len(words) == 1 and len(text) < 4:
            logger.info("Filtered hallucination (too short): %r", text)
            return None
        return text

    # Track consecutive transcription failures for caller notification
    _consecutive_failures: int = 0
    _last_failure_reason: str = ""

    @staticmethod
    def _transcribe_via_mlx(audio_np: np.ndarray, sample_rate: int) -> str | None:
        """Call the native MLX transcription service running on the host.

        Retries up to 3 times with exponential backoff for transient failures.
        Tracks consecutive failures so the caller can notify the user.
        """
        import base64

        # Encode float32 PCM as base64
        audio_bytes = audio_np.astype(np.float32).tobytes()
        audio_b64 = base64.b64encode(audio_bytes).decode("ascii")

        payload = {"audio_b64": audio_b64, "sample_rate": sample_rate}
        url = f"{TRANSCRIPTION_URL}/transcribe"

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                with httpx.Client(timeout=120.0) as client:
                    resp = client.post(url, json=payload)
                    resp.raise_for_status()
                    result = resp.json()
                    text = (result.get("text") or "").strip()
                    duration_ms = result.get("duration_ms", 0)
                    logger.info("MLX transcription: %dms → %r", duration_ms, text[:80])
                    AudioTranscriber._consecutive_failures = 0
                    AudioTranscriber._last_failure_reason = ""
                    return text if text else None
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                reason = f"unreachable: {e}"
                logger.error(
                    "MLX transcription %s (attempt %d/%d). Ensure transcription is running: make transcription-ensure",
                    reason, attempt, max_retries,
                )
                AudioTranscriber._last_failure_reason = reason
                if attempt < max_retries:
                    time.sleep(2.0 * attempt)  # 2s, 4s backoff
                    continue
            except Exception as e:
                reason = f"failed: {e}"
                logger.error("MLX transcription %s (attempt %d/%d)", reason, attempt, max_retries)
                AudioTranscriber._last_failure_reason = reason
                if attempt < max_retries:
                    time.sleep(2.0 * attempt)
                    continue

        AudioTranscriber._consecutive_failures += 1
        return None

    def _reset(self):
        self._buffer.clear()
        self._buffer_duration = 0.0
        self._silence_start = None
        self._is_speaking = False
        self._speech_frame_count = 0

    @property
    def is_speaking(self) -> bool:
        return self._is_speaking


# ─── LiveKit agent logic ─────────────────────────────────────────────────────

_active_agents: dict[str, asyncio.Task] = {}
# Mutable session_id lists keyed by room_name, shared with running agents
_active_sessions: dict[str, list[str]] = {}
# Global speaker verifier (one user per machine, shared across rooms)
_global_verifier = SpeakerVerifier()
# Flag for auto-enrollment: when True, the next speech segment enrolls the user
_auto_enroll_pending = False


async def run_livekit_agent(room_name: str, participant_name: str, initial_session_id: str | None = None):
    """Join a LiveKit room and handle voice + screen share interaction."""
    from livekit import rtc

    fallback_session_id = initial_session_id or str(uuid.uuid4())
    # Mutable so UI can send set_session to align timeline SSE with text session.
    # Also registered in _active_sessions so /join can update it externally.
    effective_session_id: list[str] = [fallback_session_id]
    _active_sessions[room_name] = effective_session_id
    transcriber = AudioTranscriber()
    # Use the global verifier so enrollment persists and /voice-id endpoints work
    transcriber.set_speaker_verifier(_global_verifier)
    screen_capture = ScreenContextCapture()
    room = rtc.Room()

    async def publish_data(data: dict):
        try:
            payload = json.dumps(data).encode("utf-8")
            await room.local_participant.publish_data(payload, reliable=True)
            logger.info("Published data: type=%s", data.get("type"))
        except Exception as e:
            logger.error("Failed to publish data: %s", e)

    async def handle_audio_track(track: rtc.Track, participant: rtc.RemoteParticipant):
        logger.info("Processing audio from %s", participant.identity)
        audio_stream = rtc.AudioStream(track)

        async for event in audio_stream:
            frame = event.frame
            audio_data = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0
            if frame.num_channels > 1:
                audio_data = audio_data.reshape(-1, frame.num_channels).mean(axis=1)

            # Auto-enrollment: capture audio for voice profile before VAD processes it
            global _auto_enroll_pending
            if _auto_enroll_pending and not _global_verifier.is_enrolled:
                # Accumulate enrollment audio in a temporary buffer
                if not hasattr(handle_audio_track, '_enroll_buffer'):
                    handle_audio_track._enroll_buffer = []
                    handle_audio_track._enroll_duration = 0.0
                    handle_audio_track._enroll_sr = frame.sample_rate

                handle_audio_track._enroll_buffer.append(audio_data)
                handle_audio_track._enroll_duration += len(audio_data) / frame.sample_rate

                if handle_audio_track._enroll_duration >= 5.0:
                    # We have enough audio — enroll
                    enroll_audio = np.concatenate(handle_audio_track._enroll_buffer)
                    success = _global_verifier.enroll(enroll_audio, handle_audio_track._enroll_sr)
                    if success:
                        logger.info("Auto-enrollment successful!")
                        await publish_data({"type": "oasis-system", "text": "✓ Voice profile enrolled! I'll only listen to your voice now."})
                    else:
                        logger.warning("Auto-enrollment failed — need more speech")
                        await publish_data({"type": "oasis-system", "text": "Voice enrollment failed. Please try again with more speech."})
                    _auto_enroll_pending = False
                    del handle_audio_track._enroll_buffer
                    del handle_audio_track._enroll_duration
                    del handle_audio_track._enroll_sr

            transcript = transcriber.add_audio(audio_data, frame.sample_rate)

            # Notify user if transcription service is failing repeatedly
            if AudioTranscriber._consecutive_failures > 0 and AudioTranscriber._consecutive_failures % 3 == 0:
                await publish_data({
                    "type": "oasis-system",
                    "text": "⚠️ Transcription service is temporarily unavailable. Your speech is not being captured. It should auto-recover shortly.",
                })

            if transcript:
                logger.info("TRANSCRIPT: %s", transcript)

                # Per-interaction client-side correlation id (used by UI timeline)
                client_message_id = str(uuid.uuid4())

                # 1. Send RAW transcript immediately so user sees their words right away
                await publish_data({"type": "oasis-transcript-interim", "text": transcript, "client_message_id": client_message_id})

                # 2. Clean up transcript (LLM call — may take a moment)
                cleaned_transcript = await cleanup_transcript(transcript)
                if cleaned_transcript != transcript:
                    logger.info("CLEANED TRANSCRIPT: %s", cleaned_transcript)

                # Include screen image if screen is being shared.
                # If screen share is active but no frame captured yet, wait briefly.
                ctx = screen_capture.latest_image
                if not ctx and screen_capture.is_active:
                    for _ in range(10):  # wait up to 2s for first frame
                        await asyncio.sleep(0.2)
                        ctx = screen_capture.latest_image
                        if ctx:
                            break
                if ctx:
                    logger.info("Including screen image (%d KB) with voice message", len(ctx) // 1024)

                # 3. Send final cleaned transcript (replaces interim in UI)
                await publish_data({"type": "oasis-transcript", "text": cleaned_transcript, "client_message_id": client_message_id})

                # 4. Notify browser: thinking (include client_message_id for timeline correlation)
                await publish_data({"type": "oasis-thinking", "client_message_id": client_message_id})

                # 5. Call Oasis API with screen context + client_message_id (use effective_session_id so timeline SSE receives events)
                result = await call_oasis(cleaned_transcript, effective_session_id[0], screen_image=ctx, client_message_id=client_message_id)
                logger.info("Oasis response: %s", result["response"][:80])

                # 6. Send response to browser
                await publish_data({
                    "type": "oasis-response",
                    "text": result["response"],
                    "confidence": result["confidence"],
                    "client_message_id": client_message_id,
                })

    async def handle_video_track(track: rtc.Track, participant: rtc.RemoteParticipant):
        """Process screen share video frames for OCR context extraction."""
        logger.info("Processing screen share video from %s", participant.identity)
        video_stream = rtc.VideoStream(track)

        async for event in video_stream:
            frame = event.frame
            await screen_capture.process_video_frame(frame)

    @room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.create_task(handle_audio_track(track, participant))
        elif track.kind == rtc.TrackKind.KIND_VIDEO:
            logger.info("Video track subscribed: name=%s", track.name)
            asyncio.create_task(handle_video_track(track, participant))

    @room.on("data_received")
    def on_data_received(data: rtc.DataPacket):
        try:
            raw = data.data.decode("utf-8")
            obj = json.loads(raw)
            if obj.get("type") == "set_session" and obj.get("session_id"):
                effective_session_id[0] = obj["session_id"]
                logger.info("Using client session_id for timeline: %s", effective_session_id[0])
        except Exception as e:
            logger.debug("Ignore data message: %s", e)

    try:
        token = _generate_token(room_name, participant_name)
        await room.connect(LIVEKIT_URL, token)
        logger.info("Agent joined room '%s' as '%s' (session=%s)", room_name, participant_name, effective_session_id[0])

        disconnect_event = asyncio.Event()

        @room.on("disconnected")
        def on_disconnect(*args):
            logger.info("Agent disconnected from room '%s'", room_name)
            disconnect_event.set()

        await disconnect_event.wait()

    except Exception as e:
        logger.error("Agent error: %s", e, exc_info=True)
    finally:
        await room.disconnect()
        _active_agents.pop(room_name, None)
        _active_sessions.pop(room_name, None)
        logger.info("Agent cleaned up for room '%s'", room_name)


# ─── LiveKit token generation ────────────────────────────────────────────────

def _generate_token(room_name: str, participant_name: str) -> str:
    try:
        from livekit.api import AccessToken, VideoGrants
        token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        token.with_identity(participant_name)
        token.with_name("Oasis Cognition")
        token.with_grants(VideoGrants(
            room_join=True,
            room=room_name,
            can_subscribe=True,
            can_publish=True,
            can_publish_data=True,
        ))
        return token.to_jwt()
    except ImportError:
        logger.error("livekit-api package not installed")
        return ""


# ─── FastAPI HTTP server ─────────────────────────────────────────────────────

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(name)s | %(levelname)s | %(message)s")
    logger.info("Voice agent started (livekit=%s, oasis=%s)", LIVEKIT_URL, OASIS_API_URL)
    yield
    for task in _active_agents.values():
        task.cancel()

http_app = FastAPI(title="Oasis Voice Agent", lifespan=lifespan)
http_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@http_app.get("/health")
async def health():
    return {"status": "ok", "service": "voice-agent", "active_rooms": list(_active_agents.keys())}


@http_app.post("/join")
async def join_room(room_name: str = "oasis-voice", session_id: str | None = None):
    if room_name in _active_agents and not _active_agents[room_name].done():
        # Agent already running — update its session_id so new UI connections align
        if session_id and room_name in _active_sessions:
            _active_sessions[room_name][0] = session_id
            logger.info("Updated running agent session_id to %s (room=%s)", session_id, room_name)
        return {"status": "already_joined", "room": room_name, "session_id_updated": bool(session_id)}
    task = asyncio.create_task(run_livekit_agent(room_name, "oasis-agent", initial_session_id=session_id))
    _active_agents[room_name] = task
    logger.info("/join room=%s session_id=%s", room_name, session_id)
    return {"status": "joining", "room": room_name}


@http_app.post("/token")
async def create_token(room_name: str = "oasis-voice", participant_name: str = "user"):
    token = _generate_token(room_name, participant_name)
    return {"token": token, "url": LIVEKIT_EXTERNAL_URL}


# ─── Voice ID endpoints ──────────────────────────────────────────────────────


@http_app.get("/voice-id/status")
async def voice_id_status():
    """Check if a voice profile is enrolled."""
    return {
        "enrolled": _global_verifier.is_enrolled,
        "enabled": _global_verifier.is_enabled,
        "profile_path": VOICE_PROFILE_PATH,
    }


@http_app.post("/voice-id/enroll")
async def voice_id_enroll():
    """Start voice enrollment — captures the next 5 seconds of audio from the active session.

    The user should speak naturally during enrollment (e.g., read a sentence aloud).
    """
    global _auto_enroll_pending

    if not _active_agents:
        return {"success": False, "error": "No active voice session. Connect to voice first, then enroll."}

    _auto_enroll_pending = True
    return {
        "success": True,
        "message": "Voice enrollment started! Please speak for about 5 seconds — read a sentence aloud.",
        "hint": "Your voice profile will be saved and used to filter out other voices.",
    }


@http_app.delete("/voice-id/clear")
async def voice_id_clear():
    """Clear the enrolled voice profile."""
    _global_verifier.clear_enrollment()
    return {"success": True, "message": "Voice profile cleared. All voices will be accepted."}


@http_app.get("/", response_class=HTMLResponse)
async def client_page():
    client_path = os.path.join(os.path.dirname(__file__), "client", "index.html")
    if os.path.exists(client_path):
        return FileResponse(client_path, media_type="text/html")
    return HTMLResponse("<html><body><p>Use the React UI at port 3000</p></body></html>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(http_app, host="0.0.0.0", port=8090)
