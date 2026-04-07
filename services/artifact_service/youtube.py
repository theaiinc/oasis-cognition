"""YouTube video download helper using yt-dlp."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def download_youtube(url: str, output_dir: str) -> dict[str, Any]:
    """Download a YouTube video and return metadata.

    Returns dict with keys: filepath, title, ext, duration, filesize.
    """
    out_template = str(Path(output_dir) / "%(title)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--print-json",
        "--output", out_template,
        url,
    ]
    logger.info("Downloading YouTube video: %s", url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr[:500]}")

    import json
    info = json.loads(result.stdout.strip().split("\n")[-1])

    filepath = info.get("requested_downloads", [{}])[0].get("filepath") or info.get("_filename", "")
    if not filepath:
        # Fallback: find the mp4 in the output dir
        mp4s = list(Path(output_dir).glob("*.mp4"))
        filepath = str(mp4s[0]) if mp4s else ""

    return {
        "filepath": filepath,
        "title": info.get("title", "untitled"),
        "ext": "mp4",
        "duration": info.get("duration"),
        "filesize": Path(filepath).stat().st_size if filepath and Path(filepath).exists() else 0,
    }
