#!/bin/bash
# Start the Dev Agent service (runs natively on host for full git access)
# This is NOT a Docker service — it runs on your Mac directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OASIS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load active project config ──────────────────────────────────────────
# If no PROJECT_ROOT is set in the environment, try to read it from the
# active project's per-project settings stored at:
#   ~/.oasis/active-project.json  → {"project_id": "<id>"}
#   ~/.oasis/projects/<id>/settings.json → {"project_path": "/path/to/project", ...}
ACTIVE_PROJECT_FILE="$HOME/.oasis/active-project.json"

if [ -z "${PROJECT_ROOT:-}" ] && [ -f "$ACTIVE_PROJECT_FILE" ]; then
  ACTIVE_PID=$(python3 -c "import json,sys; d=json.load(open('$ACTIVE_PROJECT_FILE')); print(d.get('project_id',''))" 2>/dev/null || true)
  if [ -n "$ACTIVE_PID" ]; then
    SETTINGS_FILE="$HOME/.oasis/projects/$ACTIVE_PID/settings.json"
    if [ -f "$SETTINGS_FILE" ]; then
      ACTIVE_PATH=$(python3 -c "import json; d=json.load(open('$SETTINGS_FILE')); print(d.get('project_path',''))" 2>/dev/null || true)
      if [ -n "$ACTIVE_PATH" ] && [ -d "$ACTIVE_PATH" ]; then
        echo "📂 Loading active project ($ACTIVE_PID) → $ACTIVE_PATH"
        export PROJECT_ROOT="$ACTIVE_PATH"
      fi
    fi
  fi
fi

# PROJECT_ROOT = the repo/folder the dev-agent operates on.
# Falls back to oasis-cognition root if no active project is configured.
export PROJECT_ROOT="${PROJECT_ROOT:-$OASIS_ROOT}"
export PYTHONPATH="$OASIS_ROOT"

DEV_AGENT_RELOAD_LC=$(printf '%s' "${DEV_AGENT_RELOAD:-}" | tr '[:upper:]' '[:lower:]')

echo "🔧 Starting Dev Agent (native)..."
echo "   Project root: $PROJECT_ROOT"
echo "   Port: 8008"
if [[ "${DEV_AGENT_RELOAD:-}" == "1" || "$DEV_AGENT_RELOAD_LC" == "true" ]]; then
  echo "   Reload: on (services/dev_agent only — unset DEV_AGENT_RELOAD to disable)"
else
  echo "   Reload: off (default — avoids restarts on unrelated repo edits / worktree writes)"
  echo "   Tip: DEV_AGENT_RELOAD=1 to watch services/dev_agent while developing it"
fi
echo ""

cd "$OASIS_ROOT"

# Use oasis venv if available (code lives in oasis-cognition, not the target project)
PYTHON="${OASIS_ROOT}/.venv/bin/python"
PIP="${OASIS_ROOT}/.venv/bin/pip"

if [ ! -f "$PYTHON" ]; then
    PYTHON="python3"
    PIP="pip3"
fi

# Install deps if needed
if ! "$PYTHON" -c "import fastapi" 2>/dev/null; then
    echo "Installing dependencies..."
    "$PIP" install -q fastapi uvicorn pydantic
fi

if [[ "${DEV_AGENT_RELOAD:-}" == "1" || "$DEV_AGENT_RELOAD_LC" == "true" ]]; then
  exec "$PYTHON" -m uvicorn services.dev_agent.main:app --host 0.0.0.0 --port 8008 \
    --reload --reload-dir "$OASIS_ROOT/services/dev_agent"
else
  exec "$PYTHON" -m uvicorn services.dev_agent.main:app --host 0.0.0.0 --port 8008
fi
