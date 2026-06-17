## AGENT_GUIDELINES (devlog + conventions)

This file is a running devlog/compass for Oasis Cognition agent work. Keep it updated with "aha" moments, interface contracts, and any conventions that are easy to forget.

### 2026-06-10 — Yggdrasil Agent Pool (combined controller + built-in runner)
- **Yggdrasil** is a 2-in-1 service: an HTTP controller (runner registration, job dispatch) + a built-in local runner. External runners register via `POST /runners/register`; the built-in runner registers itself on startup.
- **Types** shared between `agent-runner` and `oasis-agent` via `packages/oasis-agent-sdk/`.
- **Contracts**:
  - `POST /runners/register` accepts `RunnerInfo` (name, endpoint, capabilities, realmTemplates). Returns `{ ok: true, runner_id }`.
  - `POST /runners/:runnerId/reject` accepts `{ job_id, reason }`.

### 2026-06-15 — Project-scoped memory + rules (fix stale data across project switches)
- **Problem**: Switching projects in the UI didn't clear `graphsBySessionId`, so the old project's reasoning graph stayed visible. Memory queries, rules, and foundational nodes were NOT scoped by `project_id`, so stale data from previous projects leaked into the new project's context.
- **Fixes**:
  - **Frontend (App.tsx)**: `_setActiveProjectId` now clears `setGraphsBySessionId({})` and `setTimelineByClientMessageId({})` when the project changes, so no stale graphs or timelines visible.
  - **Memory service endpoints**:
    - `/internal/memory/query` now accepts `project_id` parameter — filters to memories tagged with `project:{project_id}` via tags CONTAINS.
    - `/internal/memory/store` and `/internal/memory/store-not-achievable` now accept `project_id` — stored memories are tagged with `project:{project_id}` for future scoped retrieval.
  - **Gateway (interaction.service.ts)**:
    - All three routes (casual, complex, tool_use) now pass `project_id` to `/internal/memory/query`.
    - Rules loading uses `/internal/memory/projects/{project_id}/rules` when a project is active, falling back to global `/internal/memory/rules`.
    - Store calls pass `project_id` so future graphs are tagged.
  - **Thing NOT changed**: `retrieve_nodes_by_tier` (ReasoningNode has no tags property, and foundational nodes are always built fresh per session — low risk).

### 2026-06-16 — session_id persistence + cross-project data leak fix
- **Critical Bug**: `_get_sessions_for_project()` queried `m.session_id` on `Memory` nodes, but session_id was NEVER stored as a top-level Neo4j property — only embedded inside the `content` JSON blob and the `tags` array. This meant project-scoped `retrieve_nodes_by_tier()` queries returned **zero results** for existing memories, breaking cross-project foundational node isolation.
- **Fix (MemoryService)**:
  - `store()` now persists `m.session_id` as a top-level Neo4j property (extracted from `content.session_id` or `tags` prefix).
  - Added `CREATE INDEX IF NOT EXISTS FOR (m:Memory) ON (m.session_id)` for fast lookups.
  - `_get_sessions_for_project()` now queries `m.session_id` first, and falls back to parsing `m.content` JSON for pre-migration entries.

### 2026-06-16 — Router model timeout fix + dev-agent launchd persistence
- **Problem 1: Router model timeout**. The `response-generator`'s `/internal/route` endpoint was called by the gateway with a 15-second timeout, but the e2b router model could take longer due to processing in the single-request queue behind larger models. When the gateway received a timeout, it fell back to keyword matching (which worked, but the router model's classification was never used).
- **Fix**: Increased both router timeout calls in `interaction.service.ts` from 15s to **30s** (lines ~1757 and ~1816). The `/internal/route` endpoint bypasses the LLM request queue (it creates its own `LLMClient` directly), so the only bottleneck was the gateway's HTTP timeout.
- **Problem 2: Dev-agent service not persistent**. The dev-agent (port 8008) was started via `nohup` in a shell script that died when the shell session ended. The Docker gateway connected to `host.docker.internal:8008` and got `ECONNREFUSED`.
- **Fix**: Created a macOS LaunchAgent at `~/Library/LaunchAgents/com.oasis.dev-agent.plist` that keeps the dev-agent alive via `KeepAlive=true` and auto-starts on login. Updated `Makefile` dev-agent-start/dev-agent-stop to use `launchctl load`/`launchctl bootout` instead of fragile PID-file-based nohup management.
  - `retrieve()` session filter changed from `m.content CONTAINS $session_id` to `m.session_id = $session_id OR m.tags CONTAINS $session_tag`.
- **Fix (Gateway - interaction.service.ts)**:
  - `handleComplex()` memory store call **missing `session_id`** — was only passing `project_id`. Added `session_id: sessionId` so reasoning graphs get tagged with the session for later project-scoped queries.
  - All other store calls (tool_use loop, store-not-achievable) already passed both session_id and project_id correctly.
- **Data flow contract**: Every `POST /internal/memory/store` call MUST include BOTH `session_id` and `project_id`. The session_id is what links ReasoningNodes back to Memories for project-scoped `retrieve_nodes_by_tier` queries.

### 2026-06-17 — Asgard implemented + LLM pipeline unblocked
- **Asgard** (`apps/asgard/asgard`) is the unified launcher for theaiinc daily apps (Cognition, Echo, Missive).
  - `asgard up|down|status|logs|app <name>` — CLI commands
  - `make asgard|asgard-status|asgard-stop|asgard-logs` — Makefile integration
  - Health checks via port probes; no external dependencies
- **Root cause of pipeline stall**: `.env` file set `OASIS_RESPONSE_LLM_PROVIDER=openai` and `OASIS_RESPONSE_LLM_MODEL=gemma-4-12b-coder-fable5-composer2.5-v1`, but that model was loaded on a **remote PC (Uyen-PC)** that was unreachable. Every LM Studio request hung for 2+ minutes.
- **Fix**: Changed `.env` and `docker-compose.yml` defaults to use **Ollama + qwen3:4b** (pulled locally, ~11s response time). Also pulled `qwen3:4b` via `ollama pull`.
- **Bug fix**: `LLMClient` referenced `self._settings.ollama_base_url` but `Settings` only had `ollama_host`. Added ollama_base_url as a `@property` alias on Settings.
- **Changed docker-compose defaults**: `qwen3:4b` everywhere (was `qwen3:8b`/`google/gemma-4-12b-qat`); router model disabled (was `arch-router-1.5b.gguf` which required remote LM Studio); `OASIS_LLM_PROVIDER` default changed from `openai` to `ollama`.
- **Flat-text tool-plan non-streaming issue**: The Ollama backend's streaming path may still have issues with the gateway's flat-text parser. The pipeline now processes requests correctly (interpreter → router → response-generator) at ~40s per LLM call.
- **Teaching mechanism**: Rules are stored via `POST /internal/memory/teach` with fields `assertion`, `category`, `domain`. The `underlying_concept` field becomes the **IF condition** — it must describe *when* the rule applies. The `assertion` becomes the **conclusion** — what the model should do. Both condition and conclusion are stored separately and shown as `IF <condition> → <conclusion>` to the model.
- **Rule classification**: The `_summarize_knowledge()` function auto-classifies rules by keywords in their conclusion text: `"approach"/"pattern for"` → `workflow/approach`, `"must"/"required"/"prefer"` → `requirement`, etc. Rules without these keywords fall to `general`. Classification is visible to the model as a theme summary.
- **Bug fixed**: `_summarize_knowledge()` was reading `r.get("assertion")` but the rules endpoint returns `conclusion` as the key — keyword classification never activated. Fixed to read `r.get("conclusion")` with fallback.
- **Feature added**: Rules are now displayed as `IF <condition> → <conclusion>` in both the knowledge TOC (tool-plan) and casual prompt so the model knows the trigger condition. Added shared `_format_rule()` / `_format_rules_list()` helpers.
- **Generalized rules with triggers (stored)**:
  1. IF asked to create a unified launcher or dashboard for a multi-service project → explore project structure first (workflow/approach)
  2. IF required to build a launcher script for multiple services → implement status/up/down/table commands (requirement)
  3. IF you need to check if a service is running → health probe via HTTP GET with short timeouts, green/red color-code (workflow/approach)
  4. IF you need to integrate with existing project infrastructure → build on top of existing Makefile targets and docker compose commands (workflow/approach)
- **Key wall — FC mode with 12B coder**: The `gemma-4-12b-coder-fable5-composer2.5-v1` on remote LM Studio works for simple prompts (~7s) but **hangs indefinitely** on structured streaming with tool definitions (FC mode). The `stream_chat_structured_async` call sends `tools` in the body and the model stalls. The same model works for flat-text streaming. **Workaround**: Force `use_fc=False` in tool-plan path, or use a model that supports native function calling (Ollama qwen3, OpenAI models).
- **Key wall — No model can complete tool-plan pipeline (2026-06-17)**:
  - **LM Studio 12B coder (remote)**: Hangs on FC mode. Flat-text route model call takes 90s+ but the tool-plan stage hangs indefinitely — the system prompt is too large (~3-4K tokens) for this model on remote.
  - **LM Studio e2b (remote)**: Returns empty content for any prompt.
  - **Ollama qwen3:4b (local)**: Initially seemed fast but returns **empty content** from Docker containers and hangs locally for streaming calls. The 4B model doesn't reliably respond.
  - **LM Studio arch-router-1.5b.gguf (local)**: Works reliably in 0.4-2s but is a 1.5B router — too small to produce tool plans or code.
  - **Conclusion**: No available model can run the full interpreter → routing → tool-plan → tool-execution pipeline end-to-end. The teacher loop is blocked until a working model is available.
- **Teaching a naive model**: Rules must be extremely detailed — step-by-step recipes with exact commands, functions to implement, and field names. The local model cannot infer intent or fill in gaps. Every rule should include concrete bash/python snippets, function signatures, and ordering constraints (step 1 do X, step 2 do Y). Rules still reference only patterns (not project-specific names). Example structure: "IF trigger → step 1: command. step 2: function. step 3: output format."
- **Rule detail level for naive models (7 rules stored)**:
  1. IF you need to discover what apps exist → exact `ls apps/`, `docker compose config --services`, grep commands
  2. IF you need to create a bash launcher → exact 4 functions (cmd_status, cmd_up, cmd_down, cmd_help) with tput colors and curl probes
  3. IF the user asks for a unified launcher → 7-step implementation order (read compose → read Makefile → create script → status → up/down → Makefile heading → Makefile target)
  4. IF you need to check service health → exact curl command with status code check and tput setaf color
  5. IF you need to add a Makefile target → exact pattern (variable, .PHONY, heading, target)
  6. IF you need to edit files → exact create_worktree → PARAM_WORKTREE_ID → edit_file → get_diff → final_answer flow
  7. IF you need to print a status table → exact printf column format with service name, status, port and summary counts

### 2026-06-17 — @theaiinc/headroom-ai fork created for Leyline compression
- **headroom-ai fork**: Forked `chopratejas/headroom` (Apache-2.0, credit retained) to `github.com/theaiinc/headroom-ai` as a library-only Python package.
- **What was stripped**: Proxy server, CLI, integrations (LangChain, Agno, MCP), evals, image compression, learning system, telemetry, install utilities, pricing, providers, storage, subscription, capture, audit, dashboard, RTK. Rust crates and TS SDK also removed.
- **What was kept**: transforms, tokenizers, proxy/interceptors, memory, ccr, cache, relevance, shared_context — these are needed for compression + retrieval of masked data.
- **JSON bridge**: `headroom.json_cli` reads JSON from stdin (`{"messages": [...], "model": "..."}`), writes compressed result as JSON to stdout. Registered as `headroom-compress` CLI entry point in pyproject.toml. Bumped version to 0.26.0.
- **Build system**: Changed from maturin (Rust extension) to pure setuptools — the Rust crate (`crates/headroom-py`) and maturin config were stripped.
- **Leyline integration**: `src/core/compress.ts` spawns `headroom-compress` (falls back to `python3 -m headroom.json_cli`). `isCompressionAvailable()` is now async (Promise-based). Removed `HEADROOM_BASE_URL` env var (no HTTP proxy needed). Removed headroom-ai optional peerDependency from package.json.
- **Upstream merge process**: `git fetch upstream && git merge upstream/main && bash scripts/strip-to-library.sh && git add -A && git commit -m "chore: strip to library-only after upstream merge" && git push origin main`
- **Credit**: README and LICENSE retain Apache-2.0 from upstream. All references credit `chopratejas/headroom`.

### 2026-06-18 — Leyline integration with Cognition (LLM proxy layer)
- **Leyline** (`@theaiinc/leyline`) is now Cognition's LLM proxy — when `OASIS_LEYLINE_BASE_URL` is set, ALL `LLMClient` calls route through Leyline's OpenAI-compatible endpoint (`POST /v1/chat/completions`).
- **How it works**: `LLMClient.provider` overrides to `"openai"` when `leyline_base_url` is set. All OpenAI/Anthropic/Ollama call methods redirect to `{leyline_base_url}/v1/chat/completions`. Cognition sends the model name; Leyline picks the provider, handles failover, load balancing, and compression.
- **Key changes**:
  - `config.py`: Added `leyline_base_url: str = ""` field, `PROJECT_OVERRIDABLE_FIELDS`, `extra="ignore"` in model_config for TS-only env vars
  - `llm_client.py`: `_effective_openai_base_url()`, `_is_routed_via_leyline()`, updated `provider` property, updated `_get_openai()` and all async HTTP URL constructions
  - `response_generator/main.py`: Passes `leyline_base_url` to sub-Settings constructor
  - `docker-compose.yml`: `OASIS_LEYLINE_BASE_URL` added to interpreter, response-generator, and teaching-service
  - `tests/test_llm_client.py`: 7 new tests for Leyline routing (provider override, URL resolution, sync/async/streaming)
- **Zero-downtime upgrade**: `OASIS_LEYLINE_BASE_URL` defaults to empty — existing direct-to-provider behavior unchanged. Set to `http://leyline:3000` to enable proxy.
- **`.env`**: Added commented-out `OASIS_LEYLINE_BASE_URL` entry with docs.



