#!/usr/bin/env bash
# Start the lightweight diarization service (ONNX Runtime, CPU-only, ~400MB RAM)
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH="$(pwd)"
PYTHON="${PYTHON:-.venv/bin/python}"
PORT="${DIARIZATION_PORT:-8097}"

echo "🎙️  Starting Diarization Service (FoxNoseTech/diarize)"
echo "   Port: $PORT"
echo "   Engine: ONNX Runtime (CPU-only, ~400MB RAM)"

exec "$PYTHON" -m uvicorn services.diarization.main:app \
    --host 0.0.0.0 --port "$PORT"
