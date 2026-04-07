"""Tests for the UI Parser service — deterministic logic checks."""

from service import (
    parse_ui,
    parse_ui_flat,
    match_text_to_boxes,
    classify_component,
    build_hierarchy,
    deduplicate_detections,
    merge_overlapping_text,
    normalize_bbox,
    compute_confidence,
    Detection,
    OcrResult,
    UIComponent,
)


# ─── Text association ─────────────────────────────────────────────────────────

def test_match_text_inside_box():
    dets = [Detection(bbox=(100, 100, 300, 150), label="rect", confidence=0.9)]
    ocr = [OcrResult(text="Login", bbox=(120, 110, 200, 140))]
    matched = match_text_to_boxes(dets, ocr)
    assert len(matched[0]) == 1
    assert matched[0][0].text == "Login"
    assert len(matched[-1]) == 0


def test_match_text_unmatched():
    dets = [Detection(bbox=(100, 100, 200, 150), label="rect", confidence=0.9)]
    ocr = [OcrResult(text="Far away", bbox=(800, 800, 900, 830))]
    matched = match_text_to_boxes(dets, ocr)
    assert len(matched[0]) == 0
    assert len(matched[-1]) == 1


def test_match_text_to_smallest_container():
    """Text should associate with the smallest containing box."""
    dets = [
        Detection(bbox=(0, 0, 500, 500), label="container", confidence=0.8),
        Detection(bbox=(100, 100, 300, 150), label="button", confidence=0.9),
    ]
    ocr = [OcrResult(text="Submit", bbox=(120, 110, 200, 140))]
    matched = match_text_to_boxes(dets, ocr)
    # Should match the smaller button box, not the container
    assert len(matched[1]) == 1
    assert matched[1][0].text == "Submit"
    assert len(matched[0]) == 0


# ─── Component classification ─────────────────────────────────────────────────

def test_classify_button():
    det = Detection(bbox=(100, 100, 250, 140), label="rect", confidence=0.9)
    texts = [OcrResult(text="Login", bbox=(110, 105, 200, 135))]
    result = classify_component(det, texts, 1280, 800, 5)
    assert result == "button"


def test_classify_input():
    det = Detection(bbox=(100, 200, 500, 240), label="rect", confidence=0.85)
    texts = [OcrResult(text="Email", bbox=(110, 210, 160, 230))]
    result = classify_component(det, texts, 1280, 800, 5)
    assert result == "input"


def test_classify_input_empty():
    det = Detection(bbox=(100, 200, 500, 240), label="rect", confidence=0.85)
    texts = []  # no text = empty input field
    result = classify_component(det, texts, 1280, 800, 5)
    assert result == "input"


def test_classify_icon():
    det = Detection(bbox=(10, 10, 40, 40), label="rect", confidence=0.7)
    texts = []
    result = classify_component(det, texts, 1280, 800, 5)
    assert result == "icon"


def test_classify_container():
    det = Detection(bbox=(0, 0, 800, 500), label="rect", confidence=0.8)
    texts = []
    result = classify_component(det, texts, 1280, 800, 10)
    assert result == "container"


# ─── Hierarchy ───────────────────────────────────────────────────────────────

def test_hierarchy_nesting():
    parent = UIComponent(type="container", bbox=(0, 0, 1, 1), _bbox_px=(0, 0, 500, 500))
    child = UIComponent(type="button", bbox=(0.1, 0.1, 0.5, 0.3), text="OK", _bbox_px=(50, 50, 250, 150))
    roots = build_hierarchy([parent, child])
    assert len(roots) == 1
    assert roots[0].type == "container"
    assert len(roots[0].children) == 1
    assert roots[0].children[0].type == "button"


def test_hierarchy_siblings():
    a = UIComponent(type="button", bbox=(0, 0, 0.2, 0.1), _bbox_px=(0, 0, 200, 100))
    b = UIComponent(type="button", bbox=(0.3, 0, 0.5, 0.1), _bbox_px=(300, 0, 500, 100))
    roots = build_hierarchy([a, b])
    assert len(roots) == 2


# ─── Cleanup ─────────────────────────────────────────────────────────────────

def test_dedup_detections():
    dets = [
        Detection(bbox=(100, 100, 200, 150), label="rect", confidence=0.9),
        Detection(bbox=(102, 101, 201, 151), label="rect", confidence=0.7),  # near-duplicate
    ]
    result = deduplicate_detections(dets)
    assert len(result) == 1
    assert result[0].confidence == 0.9


def test_merge_text():
    ocr = [
        OcrResult(text="Hello", bbox=(100, 100, 200, 120)),
        OcrResult(text="World", bbox=(110, 105, 210, 125)),  # overlapping
    ]
    result = merge_overlapping_text(ocr)
    assert len(result) == 1
    assert "Hello" in result[0].text
    assert "World" in result[0].text


def test_normalize_bbox():
    assert normalize_bbox((100, 200, 300, 400), 1000, 1000) == (0.1, 0.2, 0.3, 0.4)


# ─── Confidence ──────────────────────────────────────────────────────────────

def test_confidence_with_text():
    c = compute_confidence(0.9, True)
    assert 0.9 * 0.6 + 1.0 * 0.4 - 0.001 < c < 0.9 * 0.6 + 1.0 * 0.4 + 0.001


def test_confidence_without_text():
    c = compute_confidence(0.9, False)
    expected = 0.9 * 0.6 + 0.2 * 0.4
    assert abs(c - expected) < 0.001


# ─── End-to-end ──────────────────────────────────────────────────────────────

def test_parse_ui_button():
    result = parse_ui(
        detections=[{"bbox": [100, 100, 250, 140], "label": "rectangle", "confidence": 0.9}],
        ocr=[{"text": "Login", "bbox": [110, 105, 200, 135]}],
        image_width=1280,
        image_height=800,
    )
    assert len(result) == 1
    assert result[0]["type"] == "button"
    assert result[0]["text"] == "Login"
    assert len(result[0]["bbox"]) == 4
    assert all(0 <= v <= 1 for v in result[0]["bbox"])


def test_parse_ui_standalone_text():
    result = parse_ui(
        detections=[],
        ocr=[{"text": "Welcome", "bbox": [50, 50, 200, 80]}],
        image_width=1280,
        image_height=800,
    )
    assert len(result) == 1
    assert result[0]["type"] == "text"
    assert result[0]["text"] == "Welcome"


def test_parse_ui_flat_includes_px():
    result = parse_ui_flat(
        detections=[{"bbox": [100, 100, 250, 140], "label": "rectangle", "confidence": 0.9}],
        ocr=[{"text": "Submit", "bbox": [110, 105, 200, 135]}],
        image_width=1280,
        image_height=800,
    )
    assert len(result) == 1
    assert "bbox_px" in result[0]
    assert result[0]["bbox_px"] == [100, 100, 250, 140]


def test_parse_ui_empty():
    result = parse_ui(detections=[], ocr=[])
    assert result == []


def test_parse_ui_complex():
    """A realistic page: container with button + input + icon + standalone text."""
    result = parse_ui(
        detections=[
            {"bbox": [0, 0, 800, 500], "label": "panel", "confidence": 0.85},
            {"bbox": [100, 100, 250, 140], "label": "rect", "confidence": 0.9},
            {"bbox": [100, 200, 500, 240], "label": "rect", "confidence": 0.88},
            {"bbox": [10, 10, 40, 40], "label": "rect", "confidence": 0.75},
        ],
        ocr=[
            {"text": "Login", "bbox": [120, 110, 200, 130]},
            {"text": "Email", "bbox": [110, 210, 160, 230]},
            {"text": "Welcome back", "bbox": [900, 50, 1100, 80]},
        ],
        image_width=1280,
        image_height=800,
    )
    # Container should be root with children
    container = next((c for c in result if c["type"] == "container"), None)
    assert container is not None
    assert len(container["children"]) >= 2
    # Standalone text should be at root level
    standalone = [c for c in result if c["type"] == "text"]
    assert any("Welcome" in c["text"] for c in standalone)
