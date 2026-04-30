# Oasis MCP Server

Exposes Oasis Cognition capabilities as [Model Context Protocol](https://modelcontextprotocol.io) tools so external voice assistants (and any MCP-capable client) can drive computer-use, search memory and artifacts, and ask Oasis itself.

## Tools

| Group | Tools |
|---|---|
| Computer-use | `cu_create_session`, `cu_list_sessions`, `cu_get_active_session`, `cu_get_session`, `cu_approve_plan`, `cu_step_approve`, `cu_pause_session`, `cu_resume_session`, `cu_send_feedback`, `cu_add_user_note`, `cu_follow_up`, `cu_cancel_session`, `cu_update_policy`, `cu_get_default_policy`, `cu_get_session_memory` |
| Memory | `memory_query`, `memory_list_rules`, `memory_rules_graph`, `memory_delete_rule` |
| Artifacts | `artifact_search`, `artifact_list`, `artifact_get`, `artifact_summarize`, `artifact_reprocess`, `artifact_from_youtube`, `artifact_delete`, `artifact_queue_status` |
| Interaction | `oasis_ask` |
| Code graph | `code_graph_status`, `code_search_symbols`, `code_graph_snapshot`, `code_reindex` |
| Project | `project_get_active`, `project_get_context`, `project_get_config`, `project_activate`, `project_configure`, `project_reindex`, `project_get_settings`, `project_save_settings` |
| History | `history_list_sessions`, `history_get_messages`, `history_delete_session` |
| External agents | `agent_spawn`, `agent_list_sessions`, `agent_get_session`, `agent_get_transcript`, `agent_get_diff`, `agent_send_message`, `agent_merge`, `agent_discard`, `agent_cancel`, `agent_remove` |
| Workflows | `node_catalog`, `workflow_create`, `workflow_list`, `workflow_get`, `workflow_update`, `workflow_delete`, `workflow_run`, `workflow_runs_list`, `workflow_get_run`, `workflow_cancel_run` |
| Triggers | `trigger_create`, `trigger_list`, `trigger_update`, `trigger_delete` (cron + event + manual) |
| Web | `web_search` (DuckDuckGo-backed, proxied via `/api/v1/web-search`) |
| Agent profiles | `profile_list`, `profile_get`, `profile_create`, `profile_update`, `profile_delete` (reusable agent configs: type + model + permission + preamble) |
| Project roles | `role_list`, `role_get`, `role_create`, `role_update`, `role_delete`, `role_seed_presets` (per-project researcher / developer / data_analyst / designer / custom roles, optionally bound to a profile) |

## Transports

The server speaks both transports — pick whichever your client supports:

- **stdio** — for locally-spawned subprocesses (Claude Desktop, Claude Code)
- **Streamable HTTP** — `POST/GET/DELETE /mcp` with `Mcp-Session-Id` header (modern remote)
- **SSE (legacy)** — `GET /sse` + `POST /messages?sessionId=...` (older Realtime-style clients)

Default: HTTP on port `8020`.

## Run

Inside docker-compose (default, on port 8020):

```bash
docker compose up -d mcp-server
curl http://localhost:8020/health
```

Locally for dev:

```bash
cd apps/mcp-server
npm install
npm run build
OASIS_GATEWAY_URL=http://localhost:8000 node dist/index.js          # http on :8020
OASIS_GATEWAY_URL=http://localhost:8000 node dist/index.js --stdio  # stdio
```

### Environment variables

| Var | Default | Description |
|---|---|---|
| `OASIS_GATEWAY_URL` | `http://localhost:8000` | Oasis api-gateway base URL |
| `MCP_PORT` | `8020` | HTTP port |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `OASIS_MCP_CORS_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` |
| `OASIS_MCP_TIMEOUT_MS` | `30000` | Per-request timeout to the gateway |

## Client recipes

### Claude Desktop (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oasis": {
      "command": "node",
      "args": ["/Users/YOU/oasis-cognition/apps/mcp-server/dist/index.js", "--stdio"],
      "env": {
        "OASIS_GATEWAY_URL": "http://localhost:8000"
      }
    }
  }
}
```

Build once with `npm run build`, then restart Claude Desktop.

### Local voice agent (Streamable HTTP)

Point your MCP client at `http://localhost:8020/mcp`. The client should:

1. Send an `initialize` request as `POST /mcp` (no `Mcp-Session-Id` yet); read `Mcp-Session-Id` from the response headers.
2. Send all subsequent JSON-RPC to `POST /mcp` with that `Mcp-Session-Id` header.
3. Optionally open a long-lived `GET /mcp` with the same header to receive server-initiated notifications via SSE.

### Remote voice agent (phone, cloud)

Expose port 8020 via your preferred tunnel (ngrok, Cloudflare Tunnel — the project already uses Cloudflare for mobile-relay; the same approach works here). Then use the same `/mcp` endpoint from the remote client.

**Security note:** The server does not currently authenticate callers — anything with network access to port 8020 can drive your computer. In production, front it with a reverse proxy that requires an auth token, or restrict the tunnel to trusted IPs.

### OpenAI Realtime / legacy SSE clients

Point the client at `http://localhost:8020/sse` (GET) and use the `/messages?sessionId=...` endpoint it's told about in the `endpoint` event.

## Testing it manually

List tools via curl (Streamable HTTP):

```bash
curl -i -X POST http://localhost:8020/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Capture the `Mcp-Session-Id` response header, then:

```bash
curl -X POST http://localhost:8020/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: <id-from-above>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```
