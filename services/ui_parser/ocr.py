"""
OCR extraction from screenshots via Tesseract.

Takes a base64 JPEG image and returns OCR text regions with bounding boxes.
Fast path for the UI parser pipeline — no LLM involved.
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Any

logger = logging.getLogger(__name__)

_tesseract = None
_import_error: str | None = None


def _ensure_tesseract():
    global _tesseract, _import_error
    if _tesseract is not None:
        return _tesseract
    if _import_error is not None:
        raise RuntimeError(_import_error)
    try:
        import pytesseract
        # Quick check that the binary is accessible
        pytesseract.get_tesseract_version()
        _tesseract = pytesseract
        logger.info("pytesseract loaded — tesseract version: %s", pytesseract.get_tesseract_version())
        return pytesseract
    except Exception as e:
        _import_error = f"pytesseract not available: {e}"
        raise RuntimeError(_import_error) from e


def extract_ocr(image_b64: str) -> list[dict[str, Any]]:
    """
    Extract text regions from a base64-encoded JPEG image using Tesseract.

    Returns:
        list of {"text": str, "bbox": [x1, y1, x2, y2], "confidence": float}
    """
    from PIL import Image

    pyt = _ensure_tesseract()

    # Decode base64 image
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    img_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(img_bytes))

    logger.info("Running OCR on %dx%d image", img.width, img.height)

    # Use Tesseract's data output (word-level bboxes + confidence)
    data = pyt.image_to_data(img, output_type=pyt.Output.DICT)

    results: list[dict[str, Any]] = []
    n = len(data["text"])

    for i in range(n):
        text = (data["text"][i] or "").strip()
        conf = int(data["conf"][i]) if data["conf"][i] != -1 else 0

        # Skip empty text and very low confidence
        if not text or conf < 30:
            continue

        x = data["left"][i]
        y = data["top"][i]
        w = data["width"][i]
        h = data["height"][i]

        results.append({
            "text": text,
            "bbox": [x, y, x + w, y + h],
            "confidence": conf / 100.0,
        })

    # Merge words on the same line into phrases
    merged = _merge_line_words(results)

    logger.info("OCR extracted %d words → %d text regions", len(results), len(merged))
    return merged


def _merge_line_words(
    words: list[dict[str, Any]],
    y_threshold: float = 10,
    x_gap_threshold: float = 30,
) -> list[dict[str, Any]]:
    """
    Merge individual words into text lines/phrases.

    Words on the same horizontal line (similar y) with small gaps are merged.
    This produces more useful text regions for the UI parser.
    """
    if not words:
        return []

    # Sort by y then x
    sorted_words = sorted(words, key=lambda w: (w["bbox"][1], w["bbox"][0]))

    merged: list[dict[str, Any]] = []
    current_group: list[dict[str, Any]] = [sorted_words[0]]

    for i in range(1, len(sorted_words)):
        prev = current_group[-1]
        curr = sorted_words[i]

        # Same line? (similar y center)
        prev_cy = (prev["bbox"][1] + prev["bbox"][3]) / 2
        curr_cy = (curr["bbox"][1] + curr["bbox"][3]) / 2
        y_diff = abs(prev_cy - curr_cy)

        # Horizontal gap
        x_gap = curr["bbox"][0] - prev["bbox"][2]

        if y_diff < y_threshold and x_gap < x_gap_threshold:
            current_group.append(curr)
        else:
            merged.append(_merge_group(current_group))
            current_group = [curr]

    if current_group:
        merged.append(_merge_group(current_group))

    return merged


def _merge_group(group: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge a group of words into a single text region."""
    text = " ".join(w["text"] for w in group)
    x1 = min(w["bbox"][0] for w in group)
    y1 = min(w["bbox"][1] for w in group)
    x2 = max(w["bbox"][2] for w in group)
    y2 = max(w["bbox"][3] for w in group)
    avg_conf = sum(w["confidence"] for w in group) / len(group)

    return {
        "text": text,
        "bbox": [x1, y1, x2, y2],
        "confidence": round(avg_conf, 3),
    }


def is_available() -> bool:
    """Check if Tesseract OCR is available."""
    try:
        _ensure_tesseract()
        return True
    except RuntimeError:
        return False
