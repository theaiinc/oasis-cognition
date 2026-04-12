#!/bin/bash
# Start the UI Parser service (runs natively for GPU access)
# This is NOT a Docker service — it runs on your Mac directly.
# Uses OmniParser V2 (YOLOv8 + Florence-2) + Tesseract OCR for UI element detection.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OASIS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_PARSER_DIR="$OASIS_ROOT/services/ui_parser"

echo "🔍 Starting UI Parser (native)..."
echo "   Port: 8011"
echo "   Models: OmniParser V2 (YOLOv8 + Florence-2) + Tesseract OCR"
echo ""

cd "$UI_PARSER_DIR"

# Ensure Tesseract is available
if ! command -v tesseract >/dev/null 2>&1; then
    # Try homebrew paths
    if [ -x /opt/homebrew/bin/tesseract ]; then
        export PATH="/opt/homebrew/bin:$PATH"
    elif [ -x /usr/local/bin/tesseract ]; then
        export PATH="/usr/local/bin:$PATH"
    else
        echo "⚠️  Tesseract not found — OCR text matching will be unavailable"
        echo "   Install with: brew install tesseract"
    fi
fi

# Use ui_parser's own venv
PYTHON="$UI_PARSER_DIR/.venv/bin/python"
PIP="$UI_PARSER_DIR/.venv/bin/pip"

if [ ! -f "$PYTHON" ]; then
    echo "Creating UI Parser venv..."
    python3 -m venv "$UI_PARSER_DIR/.venv"
    PYTHON="$UI_PARSER_DIR/.venv/bin/python"
    PIP="$UI_PARSER_DIR/.venv/bin/pip"
    "$PIP" install --upgrade pip -q
fi

# Install deps if needed
if ! "$PYTHON" -c "import transformers" 2>/dev/null; then
    echo "Installing UI Parser dependencies (OmniParser V2)..."
    "$PIP" install -q torch transformers ultralytics timm einops scipy pillow pytesseract \
        fastapi uvicorn pydantic pydantic-settings
fi

export PYTHONPATH="$OASIS_ROOT"
exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port 8011
