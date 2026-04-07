"""
UI Parser Service — converts detection + OCR results into structured UI components.

Sits AFTER:
  - Object detection (YOLO / any detector producing bboxes + labels)
  - OCR (text extraction with bounding boxes)

Pure logic — no LLM calls, deterministic, O(n log n).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ─── Data types ───────────────────────────────────────────────────────────────

@dataclass
class Detection:
    """A raw detection from YOLO or similar."""
    bbox: tuple[float, float, float, float]  # (x1, y1, x2, y2) in pixels
    label: str
    confidence: float

@dataclass
class OcrResult:
    """A raw OCR text region."""
    text: str
    bbox: tuple[float, float, float, float]  # (x1, y1, x2, y2) in pixels

@dataclass
class UIComponent:
    """A structured UI component — the output of the parser."""
    type: str                     # button | input | text | icon | container | unknown
    bbox: tuple[float, float, float, float]  # normalized 0–1
    text: str = ""
    confidence: float = 0.0
    children: list[UIComponent] = field(default_factory=list)
    # Internal — not serialised
    _bbox_px: tuple[float, float, float, float] = (0, 0, 0, 0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "bbox": list(self.bbox),
            "text": self.text,
            "confidence": round(self.confidence, 3),
            "children": [c.to_dict() for c in self.children],
        }


# ─── Geometry helpers ─────────────────────────────────────────────────────────

def _area(b: tuple[float, float, float, float]) -> float:
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])

def _center(b: tuple[float, float, float, float]) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = _area(a) + _area(b) - inter
    return inter / union if union > 0 else 0.0

def _contains(outer: tuple[float, float, float, float], inner: tuple[float, float, float, float], margin: float = 5.0) -> bool:
    """True if `outer` fully contains `inner` (with pixel margin tolerance)."""
    return (
        inner[0] >= outer[0] - margin and
        inner[1] >= outer[1] - margin and
        inner[2] <= outer[2] + margin and
        inner[3] <= outer[3] + margin
    )

def _center_distance(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ca, cb = _center(a), _center(b)
    return math.hypot(ca[0] - cb[0], ca[1] - cb[1])

def _aspect_ratio(b: tuple[float, float, float, float]) -> float:
    w = max(b[2] - b[0], 1)
    h = max(b[3] - b[1], 1)
    return w / h


# ─── 1. Text association ─────────────────────────────────────────────────────

def match_text_to_boxes(
    detections: list[Detection],
    ocr_results: list[OcrResult],
) -> dict[int, list[OcrResult]]:
    """
    Assign each OCR text to the nearest detection bbox.

    Strategy:
      1. If text center is inside a detection bbox → assign it (containment).
      2. Else assign to detection with highest IoU.
      3. Else assign to nearest detection by center distance (within threshold).
      4. Remaining texts become standalone "text" components (returned under key -1).

    Returns: {detection_index: [matched OCR results], -1: [unmatched texts]}
    """
    matched: dict[int, list[OcrResult]] = {i: [] for i in range(len(detections))}
    matched[-1] = []  # unmatched texts

    for ocr in ocr_results:
        tc = _center(ocr.bbox)
        best_idx = -1
        best_score = 0.0

        for i, det in enumerate(detections):
            # Containment check — text center inside detection bbox
            if det.bbox[0] <= tc[0] <= det.bbox[2] and det.bbox[1] <= tc[1] <= det.bbox[3]:
                # Pick the smallest containing box (most specific)
                area = _area(det.bbox)
                score = 1.0 / max(area, 1)  # smaller area = higher score
                if best_idx == -1 or score > best_score:
                    best_idx = i
                    best_score = score
                continue

            # IoU fallback
            iou = _iou(det.bbox, ocr.bbox)
            if iou > 0.1 and iou > best_score:
                best_idx = i
                best_score = iou

        # Center distance fallback (max 100px threshold)
        if best_idx == -1:
            min_dist = float("inf")
            for i, det in enumerate(detections):
                d = _center_distance(det.bbox, ocr.bbox)
                if d < min_dist and d < 100:
                    min_dist = d
                    best_idx = i

        matched[best_idx].append(ocr)

    return matched


# ─── 2. Component classification ─────────────────────────────────────────────

# Placeholder-like keywords that suggest an input field
_INPUT_HINTS = {
    "email", "password", "username", "search", "name", "address", "phone",
    "enter", "type", "write", "placeholder", "url", "http",
}

def classify_component(
    det: Detection,
    texts: list[OcrResult],
    image_w: float,
    image_h: float,
    all_components_count: int,
) -> str:
    """
    Classify a detection + its matched texts into a UI component type.

    Pure heuristic — no LLM.
    """
    bbox = det.bbox
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    ar = _aspect_ratio(bbox)
    area = _area(bbox)
    image_area = max(image_w * image_h, 1)
    area_ratio = area / image_area
    combined_text = " ".join(t.text.strip() for t in texts).strip()
    word_count = len(combined_text.split()) if combined_text else 0
    has_text = bool(combined_text)

    # ── CONTAINER: large box containing many elements ──
    if area_ratio > 0.15 and all_components_count > 3:
        return "container"

    # ── ICON: small square-ish, no text ──
    if not has_text and 0.6 < ar < 1.7 and max(w, h) < min(image_w, image_h) * 0.08:
        return "icon"

    # ── INPUT FIELD: wide horizontal rectangle, little/no text or placeholder hints ──
    if ar > 2.5 and h < image_h * 0.08:
        if not has_text:
            return "input"
        if word_count <= 3 and any(kw in combined_text.lower() for kw in _INPUT_HINTS):
            return "input"

    # ── BUTTON: has text, medium aspect ratio, short text ──
    if has_text and 1 <= word_count <= 4 and 0.8 < ar < 8 and area_ratio < 0.08:
        return "button"

    # ── TEXT (fallback for detections with text that don't fit above) ──
    if has_text:
        return "text"

    # ── Label from detection model may hint at type ──
    label = det.label.lower()
    if "button" in label or "btn" in label:
        return "button"
    if "input" in label or "field" in label or "textbox" in label:
        return "input"
    if "icon" in label or "image" in label or "img" in label:
        return "icon"

    return "unknown"


# ─── 3. Hierarchy building ───────────────────────────────────────────────────

def build_hierarchy(components: list[UIComponent]) -> list[UIComponent]:
    """
    Assign parent-child relationships.

    - Sort by area (largest → smallest).
    - For each component, find the smallest ancestor that fully contains it.
    - Returns only the root-level components (children are nested inside).

    O(n^2) in worst case but n is typically small (<100 UI elements).
    """
    # Sort by area descending
    components.sort(key=lambda c: _area(c._bbox_px), reverse=True)

    roots: list[UIComponent] = []
    assigned: set[int] = set()

    for i, child in enumerate(components):
        if i in assigned:
            continue
        parent_found = False
        # Walk backward through larger components to find the smallest containing one
        for j in range(i - 1, -1, -1):
            if j in assigned and components[j] not in _all_descendants(roots):
                continue
            parent = components[j]
            if _contains(parent._bbox_px, child._bbox_px):
                parent.children.append(child)
                parent_found = True
                break
        if not parent_found:
            roots.append(child)

    return roots


def _all_descendants(roots: list[UIComponent]) -> set[UIComponent]:
    """Collect all components in the tree (for containment checks)."""
    result: set[UIComponent] = set()
    stack = list(roots)
    while stack:
        node = stack.pop()
        result.add(node)
        stack.extend(node.children)
    return result


# ─── 4. Cleanup ──────────────────────────────────────────────────────────────

def deduplicate_detections(detections: list[Detection], iou_threshold: float = 0.7) -> list[Detection]:
    """
    Remove duplicate overlapping boxes via NMS-like approach.
    Keeps the detection with higher confidence.
    """
    if not detections:
        return []

    # Sort by confidence descending
    sorted_dets = sorted(detections, key=lambda d: d.confidence, reverse=True)
    keep: list[Detection] = []

    for det in sorted_dets:
        suppressed = False
        for kept in keep:
            if _iou(det.bbox, kept.bbox) > iou_threshold:
                suppressed = True
                break
        if not suppressed:
            keep.append(det)

    return keep


def merge_overlapping_text(ocr_results: list[OcrResult], iou_threshold: float = 0.5) -> list[OcrResult]:
    """
    Merge OCR results with high overlap into a single text.
    """
    if not ocr_results:
        return []

    merged: list[OcrResult] = []
    used: set[int] = set()

    for i, a in enumerate(ocr_results):
        if i in used:
            continue
        group_text = [a.text]
        group_bbox = list(a.bbox)
        for j in range(i + 1, len(ocr_results)):
            if j in used:
                continue
            b = ocr_results[j]
            if _iou(a.bbox, b.bbox) > iou_threshold:
                group_text.append(b.text)
                group_bbox[0] = min(group_bbox[0], b.bbox[0])
                group_bbox[1] = min(group_bbox[1], b.bbox[1])
                group_bbox[2] = max(group_bbox[2], b.bbox[2])
                group_bbox[3] = max(group_bbox[3], b.bbox[3])
                used.add(j)
        merged.append(OcrResult(
            text=" ".join(group_text),
            bbox=(group_bbox[0], group_bbox[1], group_bbox[2], group_bbox[3]),
        ))
        used.add(i)

    return merged


def normalize_bbox(
    bbox: tuple[float, float, float, float],
    image_w: float,
    image_h: float,
) -> tuple[float, float, float, float]:
    """Convert pixel bbox to 0–1 relative coordinates."""
    return (
        round(bbox[0] / max(image_w, 1), 4),
        round(bbox[1] / max(image_h, 1), 4),
        round(bbox[2] / max(image_w, 1), 4),
        round(bbox[3] / max(image_h, 1), 4),
    )


# ─── 5. Confidence scoring ──────────────────────────────────────────────────

def compute_confidence(detection_confidence: float, has_text: bool) -> float:
    """
    confidence = detection_confidence * 0.6 + text_presence_score * 0.4
    """
    text_score = 1.0 if has_text else 0.2
    return detection_confidence * 0.6 + text_score * 0.4


# ─── Main entry point ────────────────────────────────────────────────────────

def parse_ui(
    detections: list[dict[str, Any]],
    ocr: list[dict[str, Any]],
    image_width: float = 1280,
    image_height: float = 800,
) -> list[dict[str, Any]]:
    """
    Stateless function: transform raw detections + OCR into structured UI components.

    Parameters:
        detections: list of {"bbox": [x1,y1,x2,y2], "label": str, "confidence": float}
        ocr:        list of {"text": str, "bbox": [x1,y1,x2,y2]}
        image_width:  source image width in pixels (for normalization)
        image_height: source image height in pixels (for normalization)

    Returns:
        list of UIComponent dicts (hierarchical, normalized bboxes)
    """
    logger.info("parse_ui: %d detections, %d OCR results, image=%dx%d",
                len(detections), len(ocr), int(image_width), int(image_height))

    # ── Parse raw inputs ──
    dets = [
        Detection(
            bbox=tuple(d["bbox"][:4]),
            label=d.get("label", "rectangle"),
            confidence=d.get("confidence", 0.5),
        )
        for d in detections
        if "bbox" in d and len(d["bbox"]) >= 4
    ]
    ocr_results = [
        OcrResult(
            text=o.get("text", ""),
            bbox=tuple(o["bbox"][:4]),
        )
        for o in ocr
        if "bbox" in o and len(o["bbox"]) >= 4
    ]

    # ── 4a. Cleanup: deduplicate detections ──
    dets = deduplicate_detections(dets)

    # ── 4b. Cleanup: merge overlapping OCR ──
    ocr_results = merge_overlapping_text(ocr_results)

    # ── 1. Text association ──
    text_map = match_text_to_boxes(dets, ocr_results)

    # ── 2 + 5. Classify components + compute confidence ──
    components: list[UIComponent] = []

    for i, det in enumerate(dets):
        texts = text_map.get(i, [])
        combined_text = " ".join(t.text.strip() for t in texts).strip()

        comp_type = classify_component(det, texts, image_width, image_height, len(dets))
        confidence = compute_confidence(det.confidence, bool(combined_text))

        comp = UIComponent(
            type=comp_type,
            bbox=normalize_bbox(det.bbox, image_width, image_height),
            text=combined_text,
            confidence=confidence,
            _bbox_px=det.bbox,
        )
        components.append(comp)

    # ── Standalone text (OCR without enclosing detection) ──
    for ocr_item in text_map.get(-1, []):
        if ocr_item.text.strip():
            comp = UIComponent(
                type="text",
                bbox=normalize_bbox(ocr_item.bbox, image_width, image_height),
                text=ocr_item.text.strip(),
                confidence=0.4,  # lower confidence — no detection backing it
                _bbox_px=ocr_item.bbox,
            )
            components.append(comp)

    # ── 3. Hierarchy building ──
    roots = build_hierarchy(components)

    # ── Serialise ──
    result = [c.to_dict() for c in roots]
    logger.info("parse_ui: produced %d root components (%d total)",
                len(result), len(components))
    return result


# ─── Convenience: flat list (no hierarchy) ────────────────────────────────────

def parse_ui_flat(
    detections: list[dict[str, Any]],
    ocr: list[dict[str, Any]],
    image_width: float = 1280,
    image_height: float = 800,
) -> list[dict[str, Any]]:
    """
    Same as parse_ui but returns a FLAT list (no nesting).
    Useful for coordinate lookup / automation where hierarchy isn't needed.
    """
    # Reuse the full pipeline but flatten
    dets = [
        Detection(bbox=tuple(d["bbox"][:4]), label=d.get("label", "rectangle"), confidence=d.get("confidence", 0.5))
        for d in detections if "bbox" in d and len(d["bbox"]) >= 4
    ]
    ocr_results = [
        OcrResult(text=o.get("text", ""), bbox=tuple(o["bbox"][:4]))
        for o in ocr if "bbox" in o and len(o["bbox"]) >= 4
    ]

    dets = deduplicate_detections(dets)
    ocr_results = merge_overlapping_text(ocr_results)
    text_map = match_text_to_boxes(dets, ocr_results)

    flat: list[dict[str, Any]] = []

    for i, det in enumerate(dets):
        texts = text_map.get(i, [])
        combined_text = " ".join(t.text.strip() for t in texts).strip()
        comp_type = classify_component(det, texts, image_width, image_height, len(dets))
        confidence = compute_confidence(det.confidence, bool(combined_text))
        flat.append({
            "type": comp_type,
            "bbox": list(normalize_bbox(det.bbox, image_width, image_height)),
            "bbox_px": list(det.bbox),
            "text": combined_text,
            "confidence": round(confidence, 3),
        })

    for ocr_item in text_map.get(-1, []):
        if ocr_item.text.strip():
            flat.append({
                "type": "text",
                "bbox": list(normalize_bbox(ocr_item.bbox, image_width, image_height)),
                "bbox_px": list(ocr_item.bbox),
                "text": ocr_item.text.strip(),
                "confidence": 0.4,
            })

    return flat
