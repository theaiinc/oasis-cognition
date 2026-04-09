"""
UI Parser Service — FastAPI entry point.

Converts detection + OCR results into structured UI components.
No LLM calls — pure deterministic logic.

Port: 8011
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── Path setup for shared-utils ──
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from packages.shared_utils.logging import setup_logging  # noqa: E402

from service import parse_ui, parse_ui_flat  # noqa: E402
from ocr import extract_ocr, is_available as ocr_available  # noqa: E402
import grounding  # noqa: E402

logger = logging.getLogger(__name__)


# ─── Lifespan ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(os.getenv("OASIS_LOG_LEVEL", "INFO"))
    # Load Florence-2 model at startup (takes ~10-30s first time, cached after)
    try:
        grounding.load_model()
    except Exception as e:
        logger.warning("Florence-2 grounding model failed to load: %s — grounding endpoint will be unavailable", e)
    logger.info("UI Parser Service started on port %s", os.getenv("PORT", "8011"))
    yield
    logger.info("UI Parser Service shutting down")


app = FastAPI(title="UI Parser Service", lifespan=lifespan)


# ─── Request / Response models ───────────────────────────────────────────────

class DetectionItem(BaseModel):
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    label: str = "rectangle"
    confidence: float = 0.5

class OcrItem(BaseModel):
    text: str
    bbox: list[float] = Field(..., min_length=4, max_length=4)

class ParseRequest(BaseModel):
    detections: list[DetectionItem] = []
    ocr: list[OcrItem] = []
    image_width: float = 1280
    image_height: float = 800

class UIComponentResponse(BaseModel):
    type: str
    bbox: list[float]
    text: str = ""
    confidence: float = 0.0
    children: list[UIComponentResponse] = []

class ParseResponse(BaseModel):
    components: list[dict[str, Any]]
    count: int

class FlatComponentResponse(BaseModel):
    type: str
    bbox: list[float]
    bbox_px: list[float]
    text: str = ""
    confidence: float = 0.0

class FlatParseResponse(BaseModel):
    components: list[dict[str, Any]]
    count: int


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.post("/internal/ui-parser/parse", response_model=ParseResponse)
async def parse_endpoint(req: ParseRequest):
    """
    Parse detections + OCR into hierarchical UI components.

    Returns nested components with parent-child relationships.
    """
    result = parse_ui(
        detections=[d.model_dump() for d in req.detections],
        ocr=[o.model_dump() for o in req.ocr],
        image_width=req.image_width,
        image_height=req.image_height,
    )
    return {"components": result, "count": len(result)}


@app.post("/internal/ui-parser/parse-flat", response_model=FlatParseResponse)
async def parse_flat_endpoint(req: ParseRequest):
    """
    Parse detections + OCR into a FLAT list of UI components.

    No hierarchy — useful for coordinate lookup and automation.
    Each component includes both normalized and pixel-space bboxes.
    """
    result = parse_ui_flat(
        detections=[d.model_dump() for d in req.detections],
        ocr=[o.model_dump() for o in req.ocr],
        image_width=req.image_width,
        image_height=req.image_height,
    )
    return {"components": result, "count": len(result)}


# ─── Combined: screenshot → OCR → parse (all-in-one) ─────────────────────────

class ScreenParseRequest(BaseModel):
    """Send a raw screenshot and get back structured UI components."""
    image: str = Field(..., description="Base64-encoded JPEG screenshot")
    image_width: float = 1280
    image_height: float = 800
    detections: list[DetectionItem] = Field(
        default=[],
        description="Optional YOLO detections. If empty, only OCR text regions are used.",
    )

class ScreenParseResponse(BaseModel):
    components: list[dict[str, Any]]
    ocr_results: list[dict[str, Any]]
    count: int


@app.post("/internal/ui-parser/parse-screen", response_model=ScreenParseResponse)
async def parse_screen_endpoint(req: ScreenParseRequest):
    """
    All-in-one: run OCR on a raw screenshot, then parse into UI components.

    This is the primary endpoint for the computer-use pipeline:
      1. Receives a base64 JPEG screenshot
      2. Runs Tesseract OCR to extract text regions
      3. Combines with any provided YOLO detections
      4. Returns structured UI components (flat, with pixel bboxes)

    If Tesseract is not available, falls back to detections-only parsing.
    """
    # Run OCR on the screenshot
    ocr_results: list[dict[str, Any]] = []
    if ocr_available():
        try:
            ocr_results = extract_ocr(req.image)
        except Exception as e:
            logger.warning("OCR extraction failed: %s", e)
    else:
        logger.debug("Tesseract not available — skipping OCR")

    # Combine with provided detections and parse
    components = parse_ui_flat(
        detections=[d.model_dump() for d in req.detections],
        ocr=ocr_results,
        image_width=req.image_width,
        image_height=req.image_height,
    )

    return {
        "components": components,
        "ocr_results": ocr_results,
        "count": len(components),
    }


# ─── OCR-only endpoint ───────────────────────────────────────────────────────

class OcrRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded JPEG screenshot")

class OcrResponse(BaseModel):
    results: list[dict[str, Any]]
    count: int


@app.post("/internal/ui-parser/ocr", response_model=OcrResponse)
async def ocr_endpoint(req: OcrRequest):
    """Run OCR only — returns text regions without component classification."""
    if not ocr_available():
        return {"results": [], "count": 0}
    results = extract_ocr(req.image)
    return {"results": results, "count": len(results)}


# ─── Grounding: OCR + GroundingDINO element detection ───────────────────────

class GroundRequest(BaseModel):
    """Locate a UI element by text description in a screenshot."""
    image: str = Field(..., description="Base64-encoded JPEG screenshot")
    query: str = Field(..., description="Text description of the element to find (e.g. 'profile avatar', 'Search button')")
    image_width: Optional[int] = Field(None, description="Original image width if different from decoded size")
    image_height: Optional[int] = Field(None, description="Original image height if different from decoded size")

class GroundResult(BaseModel):
    bbox: list[float]
    label: str
    score: float = 0.0
    center: list[float]
    method: str = "ocr"

class GroundResponse(BaseModel):
    detections: list[GroundResult]
    count: int
    query: str


@app.post("/internal/ui-parser/ground", response_model=GroundResponse)
async def ground_endpoint(req: GroundRequest):
    """
    Locate UI element(s) matching a text query in a screenshot.

    Hybrid strategy:
      1. OCR text matching (fast, pixel-accurate for labeled elements)
      2. GroundingDINO visual detection (for icons, avatars, visual elements)

    Returns center coordinates suitable for direct click targeting.
    """
    detections = grounding.ground_element(
        req.image, req.query,
        image_width=req.image_width,
        image_height=req.image_height,
    )
    return {"detections": detections, "count": len(detections), "query": req.query}


# ─── CUA: find_ui_element — unified element finder ─────────────────────────

class FindElementRequest(BaseModel):
    """Find a UI element by query in a screenshot.

    Combines Chrome Bridge DOM data (if available) with OCR + GroundingDINO.
    Returns the best matching element with ID, type, text, bbox, and center coordinates.
    """
    image: str = Field(..., description="Base64-encoded JPEG screenshot")
    query: str = Field(..., description="Element description: 'login button', 'Settings link', etc.")
    image_width: Optional[int] = None
    image_height: Optional[int] = None
    # Optional DOM elements from Chrome Bridge (checked first for faster matching)
    dom_elements: list[dict[str, Any]] = Field(default=[], description="Interactive elements from Chrome Bridge content script")

class FindElementResponse(BaseModel):
    found: bool
    element: Optional[dict[str, Any]] = None
    method: str = ""  # "dom", "ocr", "grounding_dino"
    alternatives: list[dict[str, Any]] = []


@app.post("/internal/ui-parser/find-element", response_model=FindElementResponse)
async def find_element_endpoint(req: FindElementRequest):
    """
    CUA unified element finder.

    Priority:
      1. Chrome Bridge DOM elements (text/aria-label match — fastest, most accurate)
      2. OCR text matching (pixel-accurate for labeled elements)
      3. GroundingDINO visual detection (for icons, avatars, non-text elements)

    Returns the single best match with coordinates for clicking.
    """
    query_lower = req.query.lower().strip()

    # 1. Try DOM elements first (from Chrome Bridge)
    if req.dom_elements:
        from difflib import SequenceMatcher
        dom_matches = []
        for el in req.dom_elements:
            label = (el.get("label") or el.get("text") or "").strip()
            if not label:
                continue
            label_lower = label.lower()
            if query_lower == label_lower:
                score = 1.0
            elif query_lower in label_lower or label_lower in query_lower:
                score = 0.9
            else:
                score = SequenceMatcher(None, query_lower, label_lower).ratio()

            if score >= 0.5:
                dom_matches.append({
                    "id": el.get("id", f"dom_{len(dom_matches)}"),
                    "type": el.get("tag", el.get("role", "element")),
                    "text": label,
                    "bbox": el.get("bbox", [0, 0, 0, 0]),
                    "center": el.get("center", [0, 0]),
                    "center_px": el.get("center_px", el.get("center", [0, 0])),
                    "confidence": round(score, 3),
                    "href": el.get("href", ""),
                    "method": "dom",
                })

        dom_matches.sort(key=lambda d: d["confidence"], reverse=True)
        if dom_matches:
            return {
                "found": True,
                "element": dom_matches[0],
                "method": "dom",
                "alternatives": dom_matches[1:5],
            }

    # 2. Fall back to OCR + GroundingDINO via existing ground endpoint
    detections = grounding.ground_element(
        req.image, req.query,
        image_width=req.image_width,
        image_height=req.image_height,
    )

    if detections:
        best = detections[0]
        return {
            "found": True,
            "element": {
                "id": f"ground_{0}",
                "type": "detected",
                "text": best.get("label", req.query),
                "bbox": best["bbox"],
                "center": best["center"],
                "center_px": best["center"],
                "confidence": best.get("score", 0.5),
                "method": best.get("method", "ocr"),
            },
            "method": best.get("method", "ocr"),
            "alternatives": [
                {
                    "id": f"ground_{i+1}",
                    "type": "detected",
                    "text": d.get("label", ""),
                    "bbox": d["bbox"],
                    "center": d["center"],
                    "center_px": d["center"],
                    "confidence": d.get("score", 0),
                    "method": d.get("method", "ocr"),
                }
                for i, d in enumerate(detections[1:5])
            ],
        }

    return {"found": False, "element": None, "method": "none", "alternatives": []}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "ui-parser",
        "ocr_available": ocr_available(),
        "grounding_available": grounding.is_loaded(),
    }


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8011")))
