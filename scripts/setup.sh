#!/bin/bash
set -e

echo "=== Oasis Cognition — Full Stack Setup ==="
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is required. Install from https://docker.com"
    exit 1
fi

if ! command -v docker compose &> /dev/null; then
    echo "ERROR: Docker Compose v2 required."
    exit 1
fi

# Copy .env if not exists
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
fi

# Start infrastructure first
echo ""
echo "--- Starting infrastructure (Neo4j, Redis, Postgres, LiveKit) — Ollama runs on the host ---"
docker compose up -d neo4j redis langfuse-db livekit

# Wait for Ollama to be ready
echo ""
echo "--- Waiting for Ollama ---"
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
    echo "  Waiting for Ollama..."
    sleep 3
done
echo "  Ollama is ready!"

# Pull models (host Ollama — see docker-compose comment; not a compose service)
echo ""
echo "--- Pulling models (this may take a while on first run) ---"
if command -v ollama &> /dev/null; then
    ollama pull qwen3:8b
else
    echo "  ollama CLI not in PATH; start Ollama and run: ollama pull qwen3:8b"
fi

echo ""
echo "--- Models pull step done ---"

# Start Langfuse (needs Postgres to be ready)
echo ""
echo "--- Starting Langfuse ---"
docker compose up -d langfuse

echo "  Waiting for Langfuse..."
until curl -sf http://localhost:3100/api/public/health > /dev/null 2>&1; do
    sleep 3
done
echo "  Langfuse is ready!"

# Start all services
echo ""
echo "--- Starting all services ---"
docker compose up -d --build

echo ""
echo "--- Waiting for services ---"
until curl -sf http://localhost:8000/api/v1/health > /dev/null 2>&1; do
    echo "  Waiting for API gateway..."
    sleep 3
done

echo ""
echo "==========================================="
echo "  Oasis Cognition is running!"
echo "==========================================="
echo ""
echo "  Chat UI (Open WebUI):  http://localhost:3000"
echo "  API Gateway:           http://localhost:8000"
echo "  Langfuse Dashboard:    http://localhost:3100"
echo "  Neo4j Browser:         http://localhost:7474"
echo "  LiveKit:               ws://localhost:7880"
echo "  Voice Agent:           http://localhost:8090"
echo "  Ollama:                http://localhost:11434"
echo ""
echo "  Langfuse login: admin@oasis.local / oasis-admin"
echo ""
echo "  Quick test:"
echo "    curl -X POST http://localhost:8000/api/v1/interaction \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"user_message\": \"My API is slow at 2000 users\"}'"
echo ""
