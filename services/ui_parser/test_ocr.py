"""Tests for the OCR extraction module."""

import base64
import io
import pytest
from PIL import Image, ImageDraw

from ocr import extract_ocr, is_available, _merge_line_words


def _make_test_image(texts: list[tuple[str, int, int]], size=(600, 300)) -> str:
    """Create a test image with text at given positions, return base64."""
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    for text, x, y in texts:
        draw.text((x, y), text, fill="black")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.mark.skipif(not is_available(), reason="Tesseract not installed")
class TestOCR:
    def test_available(self):
        assert is_available() is True

    def test_extract_simple_text(self):
        b64 = _make_test_image([("Hello World", 50, 50)])
        results = extract_ocr(b64)
        combined = " ".join(r["text"] for r in results)
        assert "Hello" in combined

    def test_extract_returns_bbox(self):
        b64 = _make_test_image([("Test", 100, 100)])
        results = extract_ocr(b64)
        assert len(results) > 0
        for r in results:
            assert "bbox" in r
            assert len(r["bbox"]) == 4
            assert all(isinstance(v, (int, float)) for v in r["bbox"])

    def test_extract_returns_confidence(self):
        b64 = _make_test_image([("Button", 50, 50)])
        results = extract_ocr(b64)
        assert len(results) > 0
        for r in results:
            assert "confidence" in r
            assert 0 <= r["confidence"] <= 1

    def test_empty_image(self):
        img = Image.new("RGB", (200, 200), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        results = extract_ocr(b64)
        # Empty white image should return empty or near-empty
        assert isinstance(results, list)

    def test_multiple_text_regions(self):
        b64 = _make_test_image([
            ("Login", 50, 30),
            ("Register", 50, 100),
        ])
        results = extract_ocr(b64)
        texts = [r["text"] for r in results]
        combined = " ".join(texts)
        # Should find at least one of the words
        assert "Login" in combined or "Register" in combined

    def test_data_url_prefix(self):
        """Test that data: URL prefix is handled."""
        b64 = _make_test_image([("Test", 50, 50)])
        data_url = f"data:image/jpeg;base64,{b64}"
        results = extract_ocr(data_url)
        assert isinstance(results, list)


class TestMergeLineWords:
    def test_merge_same_line(self):
        words = [
            {"text": "Hello", "bbox": [10, 50, 50, 65], "confidence": 0.9},
            {"text": "World", "bbox": [55, 50, 100, 65], "confidence": 0.85},
        ]
        merged = _merge_line_words(words)
        assert len(merged) == 1
        assert merged[0]["text"] == "Hello World"

    def test_keep_separate_lines(self):
        words = [
            {"text": "Line1", "bbox": [10, 10, 50, 25], "confidence": 0.9},
            {"text": "Line2", "bbox": [10, 50, 50, 65], "confidence": 0.9},
        ]
        merged = _merge_line_words(words)
        assert len(merged) == 2

    def test_empty_input(self):
        assert _merge_line_words([]) == []
