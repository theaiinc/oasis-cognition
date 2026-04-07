# Getting started

## Prerequisites

- **Docker** and **Docker Compose**
- **Node.js 18+** and **Python 3.10+** (for local package installs and running **dev-agent** on the host)
- **Ollama** on the host (default stack), listening so containers can reach it — typically:

  ```bash
  OLLAMA_HOST=0.0.0.0:11434 ollama serve
  ```

  Pull the models referenced in [`.env.example`](../../.env.example) (e.g. `ollama pull qwen3:8b`).

- **macOS only (optional voice path)**: `make install` installs the MLX transcription LaunchAgent so voice-agent can reach `http://localhost:8099`.

## First-time setup

1. Copy environment template and adjust keys if you use Anthropic or OpenAI-compatible APIs:

   ```bash
   cp .env.example .env
   ```

2. Install monorepo dependencies (if you develop locally):

   ```bash
   make install
   ```

## Start the stack

From the repository root:

```bash
make up
```

This ensures transcription is available when configured, then runs `docker compose up -d`.

### URLs after `make up`

| URL | Purpose |
|-----|---------|
| http://localhost:3000 | Oasis UI |
| http://localhost:8000/api/v1/health | API gateway health |
| http://localhost:3100 | Langfuse (default seeded keys in compose) |
| http://localhost:7474 | Neo4j Browser |

### Useful Make targets

| Target | Description |
|--------|-------------|
| `make up` | Start Docker stack (+ transcription check) |
| `make down` | Stop Docker services |
| `make restart` | Down then up |
| `make logs` | Tail recent logs |
| `make status` | `docker compose ps` + transcription health |
| `make install` / `make uninstall` | Transcription LaunchAgent (macOS) |

## Dev agent (required for worktree / file tools)

The API gateway expects **dev-agent** at `http://host.docker.internal:8008` (see `docker-compose.yml`). It is **not** started by default compose — run it on the host:

```bash
./scripts/start-dev-agent.sh
```

This gives the reasoning loop real git worktrees and file operations on your checkout.

## Chrome Bridge extension (recommended for computer-use)

The **computer-use** feature needs to read page content from Chrome. Without the extension, it falls back to macOS OCR which produces garbled text and unreliable results.

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select `extensions/oasis-chrome-bridge`
4. Verify the extension icon shows a green **ON** badge

The extension connects to dev-agent via WebSocket (`ws://localhost:8008/ws/chrome-bridge`). The Computer Use panel in the UI shows connection status.

See [extensions/oasis-chrome-bridge/README.md](../../extensions/oasis-chrome-bridge/README.md) for details.

## Code indexer (optional)

The **code-indexer** service (port **8010**) indexes TypeScript/JavaScript into Neo4j. Enable a full pass on startup and/or live watching via `.env` or shell:

```bash
export OASIS_CODE_INDEXER_INDEX_ON_START=true
export OASIS_CODE_INDEXER_WATCH=true
docker compose up -d code-indexer
```

The gateway can inject symbol summaries into tool-plan context (`OASIS_CODE_KNOWLEDGE_IN_TOOL_PLAN`, default on). See [code-indexing-service-design.md](../code-indexing-service-design.md).

## LLM providers

Defaults use **Ollama** with `OASIS_OLLAMA_HOST` pointing at the host.

To use **Anthropic** or an **OpenAI-compatible** endpoint, set the provider and API variables in `.env` as documented in `.env.example` (`OASIS_LLM_PROVIDER`, `OASIS_RESPONSE_LLM_PROVIDER`, `OASIS_TOOL_PLAN_LLM_PROVIDER`, keys, and optional `OASIS_OPENAI_BASE_URL`).

## Verify end-to-end

1. `curl -s http://localhost:8000/api/v1/health`
2. Open the UI at http://localhost:3000 and send a message.
3. For coding tasks, confirm dev-agent is up: `curl -s http://localhost:8008/health`

## Next steps

- [Architecture overview](../architecture/overview.md)
- [What makes Oasis different](what-makes-oasis-different.md)
- [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md)
