#!/bin/bash
# Start the GIPFormer Vietnamese transcription service (native, port 8098)
# Uses a separate Python 3.12 venv for sherpa-onnx compatibility.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OASIS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$OASIS_ROOT/.venv-gipformer"

echo "🇻🇳 Starting GIPFormer Vietnamese ASR service..."
echo "   Port: 8098"

# Find Python 3.12 (sherpa-onnx doesn't work reliably on 3.14)
PYTHON312=""
for p in /opt/homebrew/bin/python3.12 /opt/homebrew/Cellar/python@3.12/*/bin/python3.12 /usr/local/bin/python3.12; do
    if [ -x "$p" ]; then PYTHON312="$p"; break; fi
done

if [ -z "$PYTHON312" ]; then
    echo "Error: Python 3.12 not found. Install with: brew install python@3.12"
    exit 1
fi

echo "   Python: $PYTHON312"

# Create dedicated venv if needed
if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "   Creating venv at $VENV_DIR..."
    "$PYTHON312" -m venv "$VENV_DIR"
fi

PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

# Install deps if needed
if ! "$PYTHON" -c "import sherpa_onnx" 2>/dev/null; then
    echo "   Installing dependencies..."
    "$PIP" install -q -r "$OASIS_ROOT/services/transcription_gipformer/requirements.txt"
fi

echo ""

cd "$OASIS_ROOT"
export PYTHONPATH="$OASIS_ROOT"

# Auto-restart loop with exponential backoff (max 30s)
DELAY=1
MAX_DELAY=30

while true; do
    echo "[$(date)] Starting GIPFormer service..."
    "$PYTHON" -m uvicorn services.transcription_gipformer.main:app --host 0.0.0.0 --port 8098 || true
    echo "[$(date)] GIPFormer service exited. Restarting in ${DELAY}s..."
    sleep "$DELAY"
    DELAY=$((DELAY * 2))
    if [ "$DELAY" -gt "$MAX_DELAY" ]; then
        DELAY=$MAX_DELAY
    fi
done
