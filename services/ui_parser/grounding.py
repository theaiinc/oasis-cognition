"""
UI Grounding Module — Hybrid element detection.

Strategy (fast → slow):
  1. OCR text matching — exact/fuzzy match of query against Tesseract text regions.
     Fast, reliable, pixel-accurate for any text-labeled UI element.
  2. GroundingDINO — zero-shot visual object detection for non-text elements
     (icons, avatars, images, shapes).

Model: IDEA-Research/grounding-dino-tiny (~172M params, runs on CPU/MPS)
"""

from __future__ import annotations

import io
import base64
import logging
import time
from difflib import SequenceMatcher
from typing import Optional

import torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection

logger = logging.getLogger(__name__)

_model = None
_processor = None
_device = None


# ── GroundingDINO model ──────────────────────────────────────────────────────

def _get_device() -> str:
    # Use CPU for GroundingDINO — MPS has known issues with some transformers
    # operations and is often SLOWER than CPU for this model size
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model():
    """Load GroundingDINO model. Called once at startup."""
    global _model, _processor, _device

    if _model is not None:
        return

    _device = _get_device()
    model_id = "IDEA-Research/grounding-dino-tiny"

    logger.info("Loading %s on %s ...", model_id, _device)
    t0 = time.time()

    _processor = AutoProcessor.from_pretrained(model_id)
    _model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(_device)
    _model.eval()

    logger.info("GroundingDINO loaded in %.1fs on %s", time.time() - t0, _device)


def is_loaded() -> bool:
    return _model is not None


def _decode_image(image_b64: str) -> Image.Image:
    """Decode a base64 JPEG/PNG string into a PIL Image."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


# ── OCR-based text matching ─────────────────────────────────────────────────

def _ocr_locate(
    image_b64: str,
    query: str,
    min_similarity: float = 0.5,
) -> list[dict]:
    """
    Find UI elements by matching query against OCR text regions.

    Uses Tesseract OCR to extract text + bounding boxes, then
    fuzzy-matches the query against extracted text.

    Returns matches sorted by similarity score (highest first).
    """
    try:
        from ocr import extract_ocr, is_available
        if not is_available():
            return []
    except ImportError:
        return []

    t0 = time.time()
    ocr_results = extract_ocr(image_b64)
    elapsed_ocr = time.time() - t0

    if not ocr_results:
        logger.debug("OCR returned no results")
        return []

    query_lower = query.lower().strip()
    matches = []

    for region in ocr_results:
        text = region["text"].strip()
        if len(text) < 2:
            continue  # skip single-character OCR noise
        text_lower = text.lower()

        # Exact substring match (highest confidence)
        # Require the shorter string to be at least 3 chars to avoid spurious matches
        shorter_len = min(len(query_lower), len(text_lower))
        if shorter_len >= 3 and (query_lower in text_lower or text_lower in query_lower):
            similarity = 1.0 if query_lower == text_lower else 0.9
        elif query_lower == text_lower:
            similarity = 1.0
        else:
            # Fuzzy match
            similarity = SequenceMatcher(None, query_lower, text_lower).ratio()

        if similarity >= min_similarity:
            bbox = region["bbox"]
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            matches.append({
                "bbox": [round(bbox[0], 1), round(bbox[1], 1), round(bbox[2], 1), round(bbox[3], 1)],
                "label": text,
                "score": round(similarity * region.get("confidence", 0.8), 4),
                "center": [round(cx, 1), round(cy, 1)],
                "method": "ocr",
            })

    matches.sort(key=lambda d: d["score"], reverse=True)
    logger.info("OCR locate: '%s' → %d matches in %.2fs (%d OCR regions)",
                query, len(matches), time.time() - t0, len(ocr_results))
    return matches


# ── GroundingDINO visual detection ──────────────────────────────────────────

def _dino_locate(
    image_b64: str,
    query: str,
    image_width: Optional[int] = None,
    image_height: Optional[int] = None,
    box_threshold: float = 0.25,
    text_threshold: float = 0.25,
) -> list[dict]:
    """
    Locate elements using GroundingDINO zero-shot object detection.
    Best for visual/non-text elements (icons, avatars, images).
    """
    if _model is None or _processor is None:
        return []

    image = _decode_image(image_b64)
    orig_w, orig_h = image.size

    t0 = time.time()

    text = query if query.endswith('.') else query + '.'
    inputs = _processor(images=image, text=text, return_tensors="pt")
    inputs = {k: v.to(_device) if hasattr(v, 'to') else v for k, v in inputs.items()}

    with torch.no_grad():
        outputs = _model(**inputs)

    results = _processor.post_process_grounded_object_detection(
        outputs,
        inputs["input_ids"],
        threshold=box_threshold,
        text_threshold=text_threshold,
        target_sizes=[image.size[::-1]],
    )[0]

    elapsed = time.time() - t0

    scale_x = (image_width or orig_w) / orig_w
    scale_y = (image_height or orig_h) / orig_h

    boxes = results["boxes"].cpu().tolist()
    scores = results["scores"].cpu().tolist()
    labels = results.get("text_labels", results.get("labels", [query] * len(boxes)))

    # Filter out detections that span >50% of the image (usually false positives)
    img_area = orig_w * orig_h
    detections = []
    for box, score, label in zip(boxes, scores, labels):
        box_area = (box[2] - box[0]) * (box[3] - box[1])
        if box_area > img_area * 0.5:
            continue  # Skip whole-image false positives

        x1 = box[0] * scale_x
        y1 = box[1] * scale_y
        x2 = box[2] * scale_x
        y2 = box[3] * scale_y
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        detections.append({
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "label": label if isinstance(label, str) else query,
            "score": round(score, 4),
            "center": [round(cx, 1), round(cy, 1)],
            "method": "dino",
        })

    detections.sort(key=lambda d: d["score"], reverse=True)

    logger.info("GroundingDINO: '%s' → %d matches in %.2fs", query, len(detections), elapsed)
    return detections


# ── Combined grounding (public API) ─────────────────────────────────────────

def ground_element(
    image_b64: str,
    query: str,
    image_width: Optional[int] = None,
    image_height: Optional[int] = None,
    box_threshold: float = 0.25,
    text_threshold: float = 0.25,
) -> list[dict]:
    """
    Locate UI element(s) matching `query` in the screenshot.

    Strategy:
      1. Try OCR text matching first (fast, accurate for text elements)
      2. If no OCR matches, fall back to GroundingDINO (visual detection)
      3. Combine and return all results sorted by score

    Returns list of:
      {"bbox": [x1, y1, x2, y2], "label": str, "score": float,
       "center": [cx, cy], "method": "ocr"|"dino"}
    """
    # Strategy 1: OCR text matching
    ocr_matches = _ocr_locate(image_b64, query)

    # If we have high-confidence OCR matches, return them directly
    if ocr_matches and ocr_matches[0]["score"] >= 0.7:
        logger.info("Ground '%s': returning %d OCR matches (top score=%.3f)",
                     query, len(ocr_matches), ocr_matches[0]["score"])
        return ocr_matches

    # Strategy 2: GroundingDINO visual detection
    dino_matches = _dino_locate(
        image_b64, query,
        image_width=image_width,
        image_height=image_height,
        box_threshold=box_threshold,
        text_threshold=text_threshold,
    )

    # Penalize GroundingDINO detections that cover unreasonably large areas
    # (a bbox covering >25% of the image is not a specific UI element)
    for d in dino_matches:
        bbox = d["bbox"]
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        # Estimate image area from bbox coords (rough — works for typical screenshots)
        img_area_est = max(bbox[2], 1024) * max(bbox[3], 768)
        area_ratio = area / img_area_est if img_area_est > 0 else 0
        if area_ratio > 0.25:
            d["score"] = d["score"] * 0.3  # heavy penalty for huge bboxes
            logger.debug("Ground '%s': penalized DINO detection (area_ratio=%.2f, new_score=%.3f)",
                         query, area_ratio, d["score"])

    # Combine: prefer OCR matches (more reliable for text UI elements)
    # If we have ANY OCR matches, boost them slightly to prefer over low-quality DINO
    if ocr_matches:
        for m in ocr_matches:
            m["score"] = min(1.0, m["score"] * 1.15)  # slight boost for OCR

    combined = ocr_matches + dino_matches
    combined.sort(key=lambda d: d["score"], reverse=True)

    logger.info("Ground '%s': %d OCR + %d DINO = %d total (top=%s %.3f)",
                query, len(ocr_matches), len(dino_matches), len(combined),
                combined[0]["method"] if combined else "none",
                combined[0]["score"] if combined else 0)
    return combined
