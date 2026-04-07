"""GIPFormer Vietnamese ASR — calls the native host service at port 8098.

The GIPFormer service runs natively on the host (not in Docker) using
sherpa-onnx for transcription. Speaker diarization is handled by the
standalone diarization service (port 8097).
"""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from packages.shared_utils.config import get_settings

logger = logging.getLogger(__name__)


async def transcribe_gipformer(audio_path: str | Path, diarize: bool = True) -> str:
    """Transcribe Vietnamese audio via the GIPFormer host service.

    Args:
        audio_path: Path to the audio file inside the container.
        diarize: If True, separate speakers before transcribing.

    Returns:
        Transcribed text (with speaker labels if diarized), or empty string on failure.
    """
    settings = get_settings()
    url = f"{settings.gipformer_service_url}/transcribe"
    audio_path = Path(audio_path)

    try:
        async with httpx.AsyncClient(timeout=1220.0) as client:
            with open(audio_path, "rb") as f:
                files = {"file": (audio_path.name, f, "audio/wav")}
                resp = await client.post(url, files=files, params={"diarize": diarize})
            resp.raise_for_status()
            data = resp.json()
            text = data.get("text", "")
            speakers = data.get("speakers", 0)
            logger.info(
                "GIPFormer: %d chars, %d speakers, %dms",
                len(text), speakers, data.get("duration_ms", 0),
            )
            return text
    except httpx.ConnectError:
        logger.error(
            "GIPFormer service not reachable at %s — start with: ./scripts/start-gipformer.sh",
            url,
        )
        return ""
    except Exception as e:
        logger.error("GIPFormer transcription failed: %s", e)
        return ""
