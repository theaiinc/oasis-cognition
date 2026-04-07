#!/bin/bash
# Start the MLX Transcription service (runs natively on host for Apple Silicon GPU)
# This is NOT a Docker service — it runs on your Mac directly.
# Auto-restarts on crash with exponential backoff (max 30s).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PYTHONPATH="$PROJECT_ROOT"

PORT="${TRANSCRIPTION_PORT:-8099}"
HEALTH_URL="http://localhost:${PORT}/health"

echo "🎙️  Starting MLX Transcription Service (native Apple Silicon)..."
echo "   Model: mlx-community/whisper-large-v3-turbo"
echo "   Port: ${PORT}"
echo ""

cd "$PROJECT_ROOT"

# If something is already serving the health endpoint, don't crash-loop.
if curl -sS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✅  Transcription already running at ${HEALTH_URL}"
    exit 0
fi

# If the port is in use but health isn't responding, fail fast (optionally kill).
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    PID="$(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN | head -n 1 || true)"
    echo "❌  Port ${PORT} is already in use (pid: ${PID:-unknown})."
    if [ "${TRANSCRIPTION_KILL_EXISTING:-0}" = "1" ] && [ -n "${PID}" ]; then
        echo "   Killing pid ${PID} (TRANSCRIPTION_KILL_EXISTING=1)..."
        kill -9 "${PID}" 2>/dev/null || true
        sleep 1
    else
        echo "   If it's a stale transcription process, run:"
        echo "     lsof -ti:${PORT} | xargs kill -9"
        echo "   Or rerun with TRANSCRIPTION_KILL_EXISTING=1"
        exit 1
    fi
fi

# Use project venv if available
PYTHON="${PROJECT_ROOT}/.venv/bin/python"
PIP="${PROJECT_ROOT}/.venv/bin/pip"

if [ ! -f "$PYTHON" ]; then
    PYTHON="python3"
    PIP="pip3"
fi

# Install deps if needed
if ! "$PYTHON" -c "import mlx_whisper" 2>/dev/null; then
    echo "Installing MLX Whisper dependencies..."
    "$PIP" install -q -r "$PROJECT_ROOT/services/transcription/requirements.txt"
fi

# Auto-restart loop with exponential backoff
DELAY=1
MAX_DELAY=30

while true; do
    echo "[$(date)] Starting transcription service..."
    "$PYTHON" -m uvicorn services.transcription.main:app --host 0.0.0.0 --port "$PORT" || true
    echo "[$(date)] Transcription service exited. Restarting in ${DELAY}s..."
    sleep "$DELAY"
    # Exponential backoff, capped at MAX_DELAY
    DELAY=$((DELAY * 2))
    if [ "$DELAY" -gt "$MAX_DELAY" ]; then
        DELAY=$MAX_DELAY
    fi
done
