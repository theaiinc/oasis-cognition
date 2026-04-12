"""
UI Grounding Module — Hybrid element detection.

Strategy (fast → slow):
  1. OCR text matching — exact/fuzzy match of query against Tesseract text regions.
     Fast, reliable, pixel-accurate for any text-labeled UI element.
  2. OmniParser V2 — YOLOv8 icon detection + Florence-2 captioning for non-text
     elements (icons, buttons, visual UI components).

OmniParser V2 replaces GroundingDINO for better accuracy on UI elements.
Models: fine-tuned YOLOv8 (icon_detect) + Florence-2-base (icon_caption_florence)
Weights: download via `huggingface-cli download microsoft/OmniParser-v2.0 --local-dir weights`
"""

from __future__ import annotations

import io
import os
import base64
import logging
import time
from difflib import SequenceMatcher
from typing import Optional

import torch
from PIL import Image

logger = logging.getLogger(__name__)

# ── OmniParser V2 models (loaded once at startup) ─────────────────────────────

_yolo_model = None
_caption_model = None
_caption_processor = None
_device = None

# Model paths — configurable via env vars
OMNIPARSER_ICON_DETECT = os.getenv(
    "OMNIPARSER_ICON_DETECT",
    os.path.join(os.path.dirname(__file__), "weights", "icon_detect", "model.pt"),
)
OMNIPARSER_ICON_CAPTION = os.getenv(
    "OMNIPARSER_ICON_CAPTION",
    os.path.join(os.path.dirname(__file__), "weights", "icon_caption_florence"),
)


def _get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"  # Apple Silicon GPU
    return "cpu"


# ── Screenshot cache — avoid re-parsing identical screenshots ──────────────

_screenshot_cache: dict[str, tuple[float, list[dict]]] = {}  # hash → (timestamp, detections)
_cache_max_size = 20
_cache_ttl = 10.0  # seconds


def _cache_key(image_b64: str) -> str:
    """Content-aware hash. The overlay is hidden before screenshots,
    so we can hash the full image without worrying about overlay state."""
    import hashlib
    try:
        img = _decode_image(image_b64)
        thumb = img.resize((40, 30), Image.NEAREST)
        return hashlib.md5(thumb.tobytes()).hexdigest()[:16]
    except Exception:
        return hashlib.md5(image_b64[:1000].encode()).hexdigest()[:16]


def load_model():
    """Load OmniParser V2 models (YOLOv8 + Florence-2). Called once at startup."""
    global _yolo_model, _caption_model, _caption_processor, _device

    if _yolo_model is not None:
        return

    _device = _get_device()
    t0 = time.time()

    # 1. Load YOLOv8 icon detection model
    if os.path.isfile(OMNIPARSER_ICON_DETECT):
        try:
            from ultralytics import YOLO
            _yolo_model = YOLO(OMNIPARSER_ICON_DETECT)
            logger.info("OmniParser YOLO loaded from %s (%.1fs)",
                        OMNIPARSER_ICON_DETECT, time.time() - t0)
        except Exception as e:
            logger.warning("Failed to load OmniParser YOLO: %s", e)
    else:
        logger.warning("OmniParser YOLO weights not found at %s — visual detection disabled. "
                        "Download with: huggingface-cli download microsoft/OmniParser-v2.0 --local-dir weights",
                        OMNIPARSER_ICON_DETECT)

    # 2. Load Florence-2 caption model
    # The OmniParser v2.0 repo only has weights (model.safetensors + config.json).
    # Processor (tokenizer, image processor) must come from the base Florence-2 model.
    if os.path.isdir(OMNIPARSER_ICON_CAPTION):
        try:
            from transformers import AutoProcessor, AutoModelForCausalLM

            t1 = time.time()
            dtype = torch.float16 if _device == "cuda" else torch.float32
            # Load processor from base Florence-2 (has tokenizer + image processor)
            _caption_processor = AutoProcessor.from_pretrained(
                "microsoft/Florence-2-base-ft", trust_remote_code=True,
            )
            # Load fine-tuned weights from OmniParser
            _caption_model = AutoModelForCausalLM.from_pretrained(
                OMNIPARSER_ICON_CAPTION, torch_dtype=dtype, trust_remote_code=True,
                attn_implementation="eager",  # Avoid SDPA compatibility issues
            ).to(_device).eval()
            logger.info("OmniParser Florence-2 loaded from %s (%.1fs)",
                        OMNIPARSER_ICON_CAPTION, time.time() - t1)
        except Exception as e:
            logger.warning("Failed to load OmniParser Florence-2: %s", e)
    else:
        logger.warning("OmniParser Florence-2 weights not found at %s — captioning disabled",
                        OMNIPARSER_ICON_CAPTION)

    elapsed = time.time() - t0
    logger.info("OmniParser V2 init complete in %.1fs (yolo=%s, florence=%s, device=%s)",
                elapsed,
                "loaded" if _yolo_model else "missing",
                "loaded" if _caption_model else "missing",
                _device)


def is_loaded() -> bool:
    return _yolo_model is not None


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
            continue
        text_lower = text.lower()

        shorter_len = min(len(query_lower), len(text_lower))
        if shorter_len >= 3 and (query_lower in text_lower or text_lower in query_lower):
            similarity = 1.0 if query_lower == text_lower else 0.9
        elif query_lower == text_lower:
            similarity = 1.0
        else:
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


# ── OmniParser V2 visual detection ────────────────────────────────────────────

@torch.inference_mode()
def _caption_single(crop: Image.Image) -> str:
    """Caption a single icon crop using Florence-2."""
    if not _caption_model or not _caption_processor:
        return ""
    try:
        resized = crop.resize((64, 64), Image.LANCZOS)
        inputs = _caption_processor(
            text="<CAPTION>",
            images=resized,
            return_tensors="pt",
        ).to(_device)
        # Pass all inputs (including attention_mask) — Florence-2 custom
        # generate method needs them for proper past_key_values handling
        generated = _caption_model.generate(
            **inputs,
            max_new_tokens=20,
            do_sample=False,
            num_beams=1,
        )
        decoded = _caption_processor.batch_decode(generated, skip_special_tokens=True)
        return decoded[0].strip() if decoded else ""
    except Exception as e:
        logger.warning("Florence-2 caption failed: %s — YOLO detection still works, captions disabled", e)
        return ""


def _caption_batch(crops: list[Image.Image]) -> list[str]:
    """Caption a list of icon crops using Florence-2 (one at a time for compatibility)."""
    if not _caption_model or not _caption_processor:
        return ["" for _ in crops]
    return [_caption_single(c) for c in crops]


@torch.inference_mode()
def _omniparser_locate(
    image_b64: str,
    query: str,
    image_width: Optional[int] = None,
    image_height: Optional[int] = None,
    conf_threshold: float = 0.15,
    iou_threshold: float = 0.45,
) -> list[dict]:
    """
    Detect UI elements using OmniParser V2 (YOLOv8 + Florence-2).

    1. Check cache — if same screenshot was parsed recently, reuse YOLO detections
    2. YOLO detects all interactable UI elements (buttons, icons, inputs, etc.)
    3. Florence-2 captions each detected element
    4. Captions are fuzzy-matched against the query to rank results

    Returns matches sorted by relevance score (highest first).
    """
    if _yolo_model is None:
        return []

    # Cache check — reuse YOLO detections for identical screenshots
    # Cache check — overlay is hidden during screenshots, so hash is reliable
    ck = _cache_key(image_b64)
    cached_entry = _screenshot_cache.get(ck)
    if cached_entry and (time.time() - cached_entry[0]) < _cache_ttl:
        cached = cached_entry[1]
        query_lower = query.lower().strip()
        results = [dict(d) for d in cached]
        for d in results:
            caption_clean = (d.get("caption") or d.get("label") or "").lower()
            if caption_clean and (query_lower in caption_clean or caption_clean in query_lower):
                d["score"] = 0.9
            elif caption_clean:
                d["score"] = round(SequenceMatcher(None, query_lower, caption_clean).ratio() * 0.8, 4)
        results.sort(key=lambda d: d["score"], reverse=True)
        logger.info("OmniParser cache HIT for '%s': %d elements", query, len(results))
        return results

    image = _decode_image(image_b64)
    orig_w, orig_h = image.size

    t0 = time.time()

    # 1. YOLO detection — find all interactable elements
    results = _yolo_model.predict(
        source=image,
        conf=conf_threshold,
        iou=iou_threshold,
        device=_device,  # Use GPU (MPS/CUDA) if available
        verbose=False,
    )

    if not results or len(results[0].boxes) == 0:
        logger.info("OmniParser YOLO: no detections (conf=%.2f)", conf_threshold)
        return []

    boxes = results[0].boxes
    xyxy = boxes.xyxy.cpu().tolist()       # [[x1, y1, x2, y2], ...]
    confs = boxes.conf.cpu().tolist()       # [conf, ...]

    # 2. Crop detected regions for captioning
    crops = []
    for box in xyxy:
        x1, y1, x2, y2 = int(box[0]), int(box[1]), int(box[2]), int(box[3])
        crop = image.crop((max(0, x1), max(0, y1), min(orig_w, x2), min(orig_h, y2)))
        crops.append(crop)

    # 3. Caption each detection with Florence-2
    captions = _caption_batch(crops) if _caption_model else ["" for _ in crops]

    elapsed_detect = time.time() - t0

    # 4. Score each detection based on caption-query similarity
    query_lower = query.lower().strip()
    scale_x = (image_width or orig_w) / orig_w
    scale_y = (image_height or orig_h) / orig_h

    detections = []
    for i, (box, conf, caption) in enumerate(zip(xyxy, confs, captions)):
        # Filter out detections covering >40% of image (false positives)
        box_area = (box[2] - box[0]) * (box[3] - box[1])
        if box_area > orig_w * orig_h * 0.4:
            continue

        caption_clean = caption.strip().lower()

        # Score: combine YOLO confidence with caption-query relevance
        if caption_clean:
            # Check if query matches caption
            if query_lower in caption_clean or caption_clean in query_lower:
                relevance = 0.9
            else:
                relevance = SequenceMatcher(None, query_lower, caption_clean).ratio()
            # Weighted score: 40% YOLO confidence + 60% caption relevance
            score = 0.4 * conf + 0.6 * relevance
        else:
            score = conf * 0.5  # No caption — lower confidence

        x1 = box[0] * scale_x
        y1 = box[1] * scale_y
        x2 = box[2] * scale_x
        y2 = box[3] * scale_y
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2

        detections.append({
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "label": caption.strip() if caption.strip() else query,
            "score": round(score, 4),
            "center": [round(cx, 1), round(cy, 1)],
            "method": "omniparser",
            "caption": caption.strip(),  # New field — Florence-2 description
            "yolo_conf": round(conf, 4),  # New field — raw YOLO confidence
        })

    detections.sort(key=lambda d: d["score"], reverse=True)

    # Cache detections
    if len(_screenshot_cache) >= _cache_max_size:
        # Evict oldest by timestamp
        oldest = min(_screenshot_cache, key=lambda k: _screenshot_cache[k][0])
        del _screenshot_cache[oldest]
    _screenshot_cache[ck] = (time.time(), [dict(d) for d in detections])

    logger.info("OmniParser: '%s' → %d detections in %.2fs (%d YOLO boxes, %d captioned, cached=%s)",
                query, len(detections), elapsed_detect, len(xyxy), sum(1 for c in captions if c), ck)
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
      2. If no OCR matches, fall back to OmniParser V2 (visual detection + captioning)
      3. Combine and return all results sorted by score

    Returns list of:
      {"bbox": [x1, y1, x2, y2], "label": str, "score": float,
       "center": [cx, cy], "method": "ocr"|"omniparser",
       "caption": str (optional), "yolo_conf": float (optional)}
    """
    # Strategy 1: OCR text matching
    ocr_matches = _ocr_locate(image_b64, query)

    # If we have high-confidence OCR matches, return them directly
    if ocr_matches and ocr_matches[0]["score"] >= 0.7:
        logger.info("Ground '%s': returning %d OCR matches (top score=%.3f)",
                     query, len(ocr_matches), ocr_matches[0]["score"])
        return ocr_matches

    # Strategy 2: OmniParser V2 visual detection
    omni_matches = _omniparser_locate(
        image_b64, query,
        image_width=image_width,
        image_height=image_height,
        conf_threshold=box_threshold,
    )

    # Combine: prefer OCR matches (more reliable for text UI elements)
    if ocr_matches:
        for m in ocr_matches:
            m["score"] = min(1.0, m["score"] * 1.15)  # slight boost for OCR

    combined = ocr_matches + omni_matches
    combined.sort(key=lambda d: d["score"], reverse=True)

    logger.info("Ground '%s': %d OCR + %d OmniParser = %d total (top=%s %.3f)",
                query, len(ocr_matches), len(omni_matches), len(combined),
                combined[0]["method"] if combined else "none",
                combined[0]["score"] if combined else 0)
    return combined
