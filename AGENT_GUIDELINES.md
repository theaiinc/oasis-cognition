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
  - **Self-teaching tools**: Added teach_rule, update_rule, delete_rule to TOOL_PLAN_PROMPT with full JSON format.
  - **Action handlers**: Added teach_rule/update_rule/delete_rule handlers in `interaction.service.ts` tool loop (before call_tool). Each creates/updates/deletes rules via memory-service, refreshes rules for next iteration.
  - **IF/THEN prefix dedup**: Agent sends `"condition": "IF searching..."` and display adds "IF" again. Fix: strip leading "IF "/"THEN " from condition/conclusion before storing.
  - **Bad example removed**: Changed `CodeView.tsx` reference to `ChatMessage.tsx` which actually exists.
  - **Anti-hallucination rule**: Added "Do NOT assume component names from user's description. 'code view' does NOT mean CodeView.tsx. User describes FEATURES, not filenames."
  - **Mandatory teaching triggers**: Self-teaching rules now list 4 mandatory situations: after file not found, after discovering useful facts, after 2+ consecutive failures, after successful implementation.
  - **Forced teaching injection**: After 2 consecutive failures in autonomous mode, system injects a `_system` tool result: "⚠️ TEACHING REQUIRED: You MUST output a teach_rule action NOW." Code-level enforcement, not just a prompt hint. Resets after success.
  - **npm/pip/make unblocked**: Removed `npm install` and `pip install` from tool-executor blocklist. `make` was never blocked.
  - **Package install guidance**: TOOL_PLAN_PROMPT notes that if npm install IS blocked, edit package.json in worktree instead.

- **Contract**: In autonomous mode, the agent MUST create rules as it learns. The system enforces this by injecting teaching demands after consecutive failures.

### 2026-03-19 — Planning agent: concrete plans with per-step verification

- **Problem**: Plans were generic ("Investigate the codebase") with vague success criteria ("User receives a helpful response"). Checkboxes were cosmetic.
- **Fix**: PLAN_TOOL_USE_PROMPT now requires each step to have:
  - `action`: what to do (specific: "grep for 'CodeBlock' in /workspace/apps")
  - `tool`: which tool to use
  - `verify`: acceptance criterion for that step ("Found file path containing CodeBlock component")
- **Per-step validation**: Logic engine's `validate_goal` now receives `plan_steps`, matches tool results against each step's tool + verify criteria, and tracks done/pending status.
- **Observer enrichment**: Feedback now includes step progress: "Step progress: 2/6 completed. NEXT: Create worktree for changes"
- **Step statuses in graph**: CompletionNode attributes include `step_statuses` array so UI can update checkboxes for real.
- **Contract**: Plan steps flow: response-generator → observer-service → logic-engine. Steps with `verify` criteria are validated against actual tool outputs.

### 2026-03-19 — Autonomous mode: persists across chats, UI indicator, toggle restyled

- **Problem**: Autonomous mode reset to false on new chat (stored per session_id in backend Map). No indicator in chat UI. Toggle button looked bad.
- **Fix**:
  - **Persistence**: Autonomous mode stored in `localStorage` (`oasis_autonomous_mode`). Synced to backend via `POST /api/v1/session/config` whenever session ID changes (including new chats).
  - **Chat header indicator**: Purple pulsing badge with ⚡ icon shows "Autonomous" next to connection status when active.
  - **Toggle restyled**: Larger (48x28px), proper border, purple glow when active, smooth transitions. When active, shows info banner: "Autonomous mode is active — persists across new chats."
  - **Max hours**: Also persisted in localStorage (`oasis_autonomous_max_hours`).
- **Contract**: Autonomous mode is a global user preference, not session-scoped. UI reads from localStorage on mount; syncs to backend on every session change.

### 2026-03-19 — Rules UI: full content display, graph tooltips, delete rules

- **Problem**: Rules in Logic Engine tab were truncated to 20 chars. No way to delete rules from UI.
- **Fix**:
  - **SVG graph**: Nodes bigger (200×72px), show 35 chars with `…`. Full text on hover via `<title>` tooltip.
  - **Flat list**: Shows full rule content (no truncation), scrollable up to 400px. Removed `.slice(0, 10)` limit.
  - **Delete button**: Trash icon appears on hover over each rule. Calls `DELETE /api/v1/memory/rules` → memory-service.
  - **Gateway endpoint**: Added `DELETE /api/v1/memory/rules` to `memory.controller.ts`, proxies to `DELETE /internal/memory/rules`.
- **Contract**: Rules API supports full CRUD: GET (list), POST (create via teach), DELETE (by rule_id). Graph visualization updates reactively on delete.

### 2026-03-19 — Duplicate tool call detection + dedup enforcement

- **Already existed**: Dedup logic in interaction.service.ts compares JSON-stringified tool signatures against prior results.
- **Behavior**: When duplicate detected, injects synthetic result: "DUPLICATE CALL BLOCKED — DRILL DEEPER or try DIFFERENT keywords."
- **Note**: Agent sometimes ignores this. The forced teaching mechanism (after 2 consecutive failures) is the stronger enforcement.

### 2026-03-19 — Logic engine: implementation detection + code change enforcement

- **Problem**: Agent would explore the codebase for an implementation request, then give final_answer telling the user what to do.
- **Fix**: Logic engine's `validate_goal` detects implementation requests (keywords: implement, add, create, fix, etc.) and checks if only read-only tools were used. If so: goal_met = false, feedback = "You only explored — you MUST create a worktree, edit files, show diff. Do NOT tell the user to do it."
- **Contract**: For implementation requests, goal is only met when code editing tools (create_worktree, edit_file, get_diff) are used.

### 2026-03-19 — Services folder dedup (hyphen/underscore)

- Materialized the underscore service symlinks (`graph_builder`, `logic_engine`, `memory_service`, `response_generator`) into real directories, then removed the redundant hyphenated folders (`graph-builder`, `logic-engine`, `memory-service`, `response-generator`).
- Removed duplicated `services/dev-agent` (kept `services/dev_agent`).
- Option A: removed `services/teaching_service` (kept `services/teaching-service`).

### 2026-03-20 — "Stopped after plan" / RulesSnapshot: abort false positives

- **Symptom**: Pipeline died at the **first tool-loop iteration** right after **ToolPlanReady** or **RulesSnapshotCreated** while the user did not stop.
- **Causes tried**:
  1. `req.on('close')` — fires when the **request body stream** finishes after a full read, not TCP teardown.
  2. `res.on('close')` / `socket.on('close')` during **chunked NDJSON** — can still fire on some Node/Docker stacks without a real client disconnect.
- **Fix (default)**: `isAborted()` = **`req.socket != null && req.socket.destroyed`** only (real connection teardown when the user aborts fetch / closes tab). Optional **`OASIS_STRICT_STREAM_CLOSE_ABORT=1`** restores stream-close + `req.destroyed` for stricter (but riskier) detection.

### 2026-03-20 — Long POST keepalive (NDJSON stream)

- **Problem**: Single JSON response meant **no bytes on the wire** during long LLM/tool gaps → proxies or stacks closed the TCP leg; gateway logged "connection closed before response".
- **Fix**: `POST /api/v1/interaction` returns **`Content-Type: application/x-ndjson`**: immediate line + `OASIS_INTERACTION_KEEPALIVE_MS` (default 12s) lines `{"_oasis_keepalive":true}`, then final line is the usual `InteractionResponse` JSON. Errors: `{"_oasis_error":true,"status", "body"}`.
- **Clients updated**: `oasis-ui-react` (`postInteractionNdjson`), `openai-adapter`, `voice_agent`, `web-client` + `voice_agent/client` HTML, `scripts/test-interaction.sh`. Abort detection (default): `socket.destroyed` only; see **"Stopped after plan"** note for `OASIS_STRICT_STREAM_CLOSE_ABORT`.

### 2026-03-20 — False "Client aborted" on long tool_use POSTs

- **Symptom**: Pipeline logs `Client aborted request` / `Pipeline stopped by client` even though the user did not click Stop.
- **Causes**: (1) **Bug**: `isAborted` treated `!req.socket` as abort — can false-positive; removed. (2) **Real closes**: `req.socket.destroyed` after **proxy/load balancer idle timeout** while the server is busy between tool iterations (no bytes on the client↔proxy TCP leg during long LLM gaps).
- **Fix**: `interaction.controller.ts` — subscribe to `req.on('close')` only when `!res.headersSent`, and abort only on that + `req.destroyed` + `socket.destroyed` when `socket` is present. Clearer WARN in `interaction.service.ts` listing causes.
- **If idle timeout persists**: Raise proxy `read_timeout` / `send_timeout` (or equivalent), or move long runs to chunked/streaming responses / SSE so the connection isn't silent for minutes.

### 2026-03-20 — Compass: self-teaching for better tool use (beyond prompt text)

- **Reality check**: In-loop "the model teaches itself" only sticks if **something durable** changes: injected context (rules, playbooks, walls), structured tool feedback, or offline weight updates (SFT/LoRA). Prompts alone plateau.
- **Already in repo**: `teach_rule` / rules in Neo4j (`memory_service.store_rule`, fingerprint dedupe), `walls_hit`, multi-agent tool_use (Planner / Executor / Observer), logic-engine pressure for implementation tasks.
- **High-ROI next steps** (when prioritizing):
  1. **Structured tool outcomes** — Stable `error_class` + machine-generated recovery hints in every tool result (clearer gradient than free-form stderr).
  2. **Post-hoc writers** — Derive rules or short playbooks from successful/failed traces without relying on the executor to voluntarily `teach_rule`; merge via existing fingerprint dedupe.
  3. **Task-conditioned retrieval** — Inject top-k rules/playbooks by similarity to current `problem`, not unbounded rule dumps; tie rule `confidence` to Observer `goal_met` and user corrections (decay stale rules).
  4. **Optional**: Log trajectories for periodic fine-tuning if product needs weight-level improvement.

### 2026-03-20 — Tool plan: canonical names + no IDE hallucinations

- **Problem**: Execution agent emitted tools like `edit`, or imagined VS Code / Sublime; after edit failures it jumped to unrelated `list_dir`.
- **Fix**: `services/response_generator/service.py` — `_canonicalize_tool_name()` maps aliases (`edit` → `edit_file`, `read_dir` → `list_dir`, etc.), rejects IDE-like names, unknown tools return `_retry_hint` validation. TOOL_PLAN_PROMPT adds **exact allowed `tool` list**, **mid-edit discipline** (read_worktree_file → edit_file; no random list_dir). `interaction.service.ts` — reject unknown `tool` before HTTP to executor with explicit allowed list.

### 2026-03-20 — UI: suppress horizontal swipe → browser back/forward

- **Change**: `apps/oasis-ui-react/src/index.css` — `overscroll-behavior-x: none` on `html` and `body` so macOS trackpad (and similar) horizontal overscroll doesn't trigger history navigation.

### 2026-03-20 — Tool_use loop: fix validate-goal crash + narrow plan context

- **Problem**: Tool_use "overthinking loop" for simple tasks.
- **Root cause #1**: `services/logic_engine/service.py` `validate_goal()` referenced an undefined `user_goal` variable, causing logic-engine `/internal/validate-goal` to 500; observer defaulted to `goal_met=false`, so the loop never stopped.
- **Root cause #2**: Tool-plan prompt/context was too broad, so the planner often retried parsing invalid tool-plan JSON and kept exploring.
- **Fix**:
  - `services/logic_engine/service.py`: implement detection now derives from `goal_title + success_criteria` (no undefined variables).
  - `services/response_generator/service.py`: tool-plan output format allows ```json``` code fences; also the prompt shows only the *current* plan step.
  - `apps/api-gateway/src/interaction/interaction.service.ts`: tool-plan calls now send `active_step_index/description`, filter memory/rules by overlap with that step, and send only the last 5 tool results.

### 2026-03-20 — Current struggles: tool-plan JSON + tool-use stalls

- **Symptoms seen in logs**:
  - `response-generator` tool planning retries with `Tool plan attempt ... failed (bad JSON)` and messages like `Could not extract valid JSON from text: plaintext` or the model producing non-tool-plan text (e.g. "request incomplete..." / apology text).
  - Sometimes the parsed object is missing required fields (observed: `Invalid action: None`), which forces retries and can make the overall interaction feel stuck/slow.
  - End-to-end smoke tests for tool_use can take a long time when the model keeps emitting non-JSON/tool-incompatible outputs.
- **Root causes (suspected / observed)**:
  - The tool-plan model is not consistently producing a JSON object that our extractor can parse, even with prompt constraints.
  - JSON extraction needs to be tolerant of common "near JSON" mistakes (code fences, trailing commas, unquoted keys/values, etc.).
  - Even when parsing improves, the model can still output plain text refusals or meta-responses instead of a tool-plan JSON object.
- **Mitigations implemented in code**:
  - **Near-JSON repair**: `packages/shared-utils/json_utils.py` now repairs common tool-plan JSON issues (unquoted keys, single-quoted strings, bareword string values, trailing commas).
  - **Prompt enforcement**: `services/response_generator/service.py` now instructs that the reply MUST contain a valid JSON object (surrounding text is allowed; extractor extracts the first JSON).
  - **Deterministic fallback**: if the tool-plan model fails to emit parsable JSON after retries, the planner falls back to a deterministic first step: `grep` on `/workspace` using a keyword extracted from the user message.
  - **Two-model routing**: `response-generator` uses a separate `tool_plan_llm_*` model for tool-plan/JSON generation (so edit-quality + prompt-following can be tuned independently).
  - **Context curation**: `interaction.service.ts` narrows injected memory/rules to the active plan step and sends only the last 5 tool results.
- **Current knob**:
  - **Defaults (2026-03)**: interpreter + teaching + response + tool-plan all use **`qwen3:8b`** in `packages/shared-utils/config.py`, compose fallbacks, and `.env.example`. A root **`.env`** overrides compose substitution — after changing models, **`docker compose up -d --force-recreate`** (or rebuild) the affected services and **`ollama pull <tag>`** on the host.
- **Open risk**:
  - Even with fallback, slow interactions can still happen when the tool-plan model repeatedly outputs tool-incompatible content before failing over (model latency + retries).

### 2026-03-20 — UI: stream thoughts before plan ready + plan progress fixes

- **Symptom**: On tool_use, the chat overlay showed `ToolPlanReady` first, while the "Agent Thoughts" card rendered the full content only after completion (no incremental streaming).
- **Root cause**: `ThinkingOverlay` decided whether to render `ActivityStream` based only on `ThoughtsValidated`; it ignored `ThoughtChunkGenerated` / `ThoughtLayerGenerated`, so the streaming thought UI was gated until a later event.
- **Fix**: `ThinkingOverlay` now treats `ThoughtChunkGenerated` / `ThoughtLayerGenerated` as "thought present" so the overlay renders early and streams incrementally.

- **Symptom**: `PlanCard` highlighting/progress appeared stuck across iterations.
- **Root cause**: `interaction.service.ts` published `step_index` with an off-by-one error (`Math.min(iteration, planSteps) - 1`), so UI step highlighting didn't advance correctly.
- **Fix**: `step_index` is now `max(0, min(iteration, planSteps - 1))`, and `PlanCard` uses the latest `ToolPlanReady` event.

### 2026-03-20 — Self Teaching: UI + 2-agent flow

- Implemented a dedicated "Self Teaching" sidebar panel (`apps/oasis-ui-react/src/components/self-teaching/SelfTeachingPanel.tsx`) that runs:
  - LLM candidate thoughts (`POST /internal/thought/generate` + logic validation)
  - Logic-engine solution (`POST /internal/reason` via graph-builder)
  - Teaching plan proposal (`POST /internal/self-teaching/plan`)
  - User approval gate, then rule application + rollback (`teach/update/delete` via memory-service).
- New API endpoints in api-gateway:
  - `POST /api/v1/self-teaching/start`
  - `POST /api/v1/self-teaching/approve`
  - `POST /api/v1/self-teaching/reject`
- New pending workflow storage in memory-service:
  - `GET|POST|DELETE /internal/memory/self-teaching/pending`

- Added "almost agree" adjustment loop:
  - UI now lets you enter a user comment during `awaiting_approval` and click `Update plan`.
  - api-gateway exposes `POST /api/v1/self-teaching/adjust`, overwriting the pending `teaching_plan` with an LLM-regenerated one.
  - response-generator `/internal/self-teaching/plan` now accepts `user_comment` and instructs the model to incorporate it into both `teaching_material` and `rule_actions` with minimal changes.

### 2026-03-20 — Memory `/internal/memory/teach`: IF and THEN identical

- **Symptom**: Stored rules showed the same text for condition (IF) and conclusion (THEN).
- **Root cause**: `store_teaching` used `condition=underlying_concept or assertion`, so an empty `underlying_concept` duplicated the assertion as the rule condition.
- **Fix** (`services/memory_service/main.py`): if concept is empty **or** equals the assertion (case-insensitive), store condition as **`General applicability`** instead of copying the assertion.

### 2026-03-20 — Self Teaching: empty `rule_actions` from LLM

- **Symptom**: Plan text / flow looked fine but UI showed **0 rules** (nothing to approve/teach).
- **Causes**: Models often (a) omit `"action":"teach_rule"`, (b) nest under `teaching_plan`, (c) use `rules` instead of `rule_actions`, (d) use wrong JSON so `extract_json` grabs the wrong object.
- **Mitigations** (`services/response_generator/service.py`): infer `teach_rule` when `conclusion`/`assertion` exists; case-insensitive action; unwrap `teaching_plan` / `plan`; accept `rules`/`actions` on paths; merge path rules if default empty; **repair_json** fallback on parse failure; **retry hint** when normalized plan has zero rules; prompt mandates ≥1 rule even if `logic_solution` is weak.

### 2026-03-20 — Self Teaching: multi-subtopic problems + teaching paths

- **Goal**: One self-teach session can describe a *compound* task; the LLM decomposes subtopics, outlines an **achievement flow**, proposes **many** `teach_rule` actions, and offers **2–4 alternative `teaching_paths`** (different rule bundles for the logic engine).
- **response-generator**: `SELF_TEACHING_PLAN_PROMPT` + `_normalize_self_teaching_plan_dict`; `/internal/self-teaching/plan` accepts optional `prior_plan` (used on adjust).
- **api-gateway** `POST /api/v1/self-teaching/approve` optional body: `selected_teaching_path_id`, `apply_all_teaching_paths`.
- **UI**: taller topic textarea; flow + subtopics + strategy radios + scrollable rule preview; approve sends selected strategy.

### 2026-03-21 — Chat history missing on LLM / tool-plan requests

- **Symptom**: Multi-turn chats didn't get `chat_history` on response-generator (tool-plan, chat, etc.).
- **Root cause**: `RedisEventService.pushMessage` / `getRecentMessages` returned immediately when `this.connected` was false. `connected` flips true only in the `.then()` of `redis.connect()`, so the first requests (and any request before connect finished) **skipped** storing the user message and **returned []** for history.
- **Fix**: `ensureRedisReady()` awaits `redis.connect()` before chat list ops (and reuse for `publish` / `getBacklog`). `InteractionService` logs prior-turn count when non-zero.

### 2026-03-21 — Logic rules panel: 0 rules + fixes

- **Symptom**: Reasoning → Logic engine showed `Rules graph (0 rules, 0 connections)` even when Neo4j had rules.
- **Causes**:
  - **`onRefreshRules` was never passed** from `App.tsx` into `GraphPanel`, so switching to the Logic tab did not refetch.
  - **Silent axios failures** in a single `try/catch` cleared both list and graph; graph used `.catch(() => null)` so failures were invisible.
  - **Memory-service on Neo4j fallback** at startup: rules live in Neo4j but API reads empty in-process `_fallback_rules` — looks like "no rules".
  - **Neo4j `Rule` nodes**: `dict(record["r"])` can yield non–JSON-safe values; list endpoint may error or return unusable payloads — now normalized via `_rule_node_to_dict`.
- **Fixes**:
  - `services/memory_service/service.py`: `_rule_node_to_dict` + `storage_backend`; `GET /internal/memory/rules` returns `"storage": "neo4j"|"fallback"`.
  - `App.tsx`: separate fetch/parse for rules vs graph; normalize rule rows; toasts on error; `onRefreshRules={loadGraphPanelData}`; `rulesStorageBackend` → banner in `LogicEngineViz` when `fallback`.
  - `LogicEngineViz`: merge **rules list + graph nodes** (dedupe by `rule_id`).

### 2026-03-21 — UI: streaming reply overwrote user bubble

- **Symptom**: While the assistant streamed, the **user's** message text was replaced by the assistant output.
- **Cause**: `ResponseChunkGenerated` keyed updates by `client_message_id`, which is the **same** as the user row's `id`. `prev.map(m => m.id === clientId ? { ...m, text: fullText } : m)` updated the user message. User and assistant rows also reused that id.
- **Fix** (`apps/oasis-ui-react`): assistant rows use `assistantMessageId(clientId)` = `` `${clientId}-assistant` ``; streaming and final `upsertAssistantMessage` only touch that id. Timeline/SSE stay keyed by raw `client_message_id` via `timelineClientKeyForMessage()`. Voice `oasis-response` uses the same upsert.

### 2026-03-20 — Tool-plan: flat line output + `parse-raw` (streaming 2A, contract 1A)

- **1A (contract)**: The execution loop still receives the same normalized plan dict (`action`, `tool`, params, `teach_rule`, etc.); only the **LLM surface format** changed.
- **Flat format**: `TOOL_PLAN_PROMPT` asks for lines like `DECISION:`, `ACTION:`, `PARAM_*:`, `REASONING:` (no JSON). `parse_flat_tool_plan_lines` → `flat_dict_to_plan` → `_normalize_tool_plan_output`.
- **Non-stream**: `plan_tool_calls` builds context via `_build_tool_plan_combined_message`, then `parse_tool_plan_raw` (flat first, then JSON + `repair_json` if the buffer looks like `{...}`).
- **2A (streaming UX)**: `stream_tool_plan` uses the **same** combined message (including `knowledge_summary` on `ToolPlanRequest`). Gateway publishes incremental **ToolReasoningChunk** from the last `REASONING:` line (with legacy fallback to partial `"reasoning"` JSON). On stream end it calls **`POST /internal/response/tool-plan/parse-raw`** first, then falls back to `/internal/json/repair` + `extractAndParseJson`.

### 2026-03-20 — UI "Connecting…" forever (voice / whole gateway wedged)

- **Symptom**: Header stuck on **Connecting…** (LiveKit auto-connect in `App.tsx`); other API calls can hang.
- **Root cause**: Timeline SSE (`TimelineController`) loop calls `readNextBatch` → when `this.reader` was missing or `this.connected` false, it returned `[]` **immediately**. The handler did `if (batch.length === 0) continue` with **no await** → **tight busy-loop on the Node event loop**, starving I/O (including `voice-proxy` join/token).
- **Fix** (`apps/api-gateway/src/events/redis-event.service.ts`): lazy **`ensureStreamReaderReady()`** (duplicate client with `maxRetriesPerRequest: null` for `XREAD BLOCK`), and when Redis/reader still unavailable return `[]` only after a short **`setTimeout`** so SSE never spins. Removed eager reader creation from constructor (it raced `ensureRedisReady()`).
- **Hardening** (`useVoiceConnection.ts`): axios **timeouts** on join/token; **`Promise.race`** timeout on `room.connect`; clear `isConnecting` when `room.state === 'connected'`; **disconnect** + clear `roomRef` on failure.

### 2026-03-21 — Default Ollama model: `qwen3:8b` (was `qwen2.5-coder:7b`)

- **Stack default**: `OASIS_LLM_MODEL`, `OASIS_RESPONSE_LLM_MODEL`, and `OASIS_TOOL_PLAN_LLM_MODEL` all **`qwen3:8b`** (`packages/shared-utils/config.py`, `docker-compose.yml` fallbacks, `.env` / `.env.example`, `scripts/setup.sh`). Official library tag [qwen3:8b](https://ollama.com/library/qwen3:8b) (~5.2GB Q4_K_M). Host: `ollama pull qwen3:8b`. Recreate **interpreter**, **response-generator**, **teaching-service** after model changes.

### 2026-03-21 — Observer `httpx.ReadTimeout`

- **Symptom**: `httpx.ReadTimeout` in **observer-service** calling graph-builder or logic-engine.
- **Causes**: Default **30s** per outbound hop is tight for large `task_graph` / slow Docker CPU; **api-gateway** also used **30s** for `POST /internal/observer/validate` while observer does **two sequential** HTTP calls (up to 30s each) → gateway could abort before observer finishes.
- **Fix**: Observer `httpx.Timeout` from env — **`OBSERVER_HTTP_TIMEOUT_SECONDS`** (default **120**), **`OBSERVER_HTTP_CONNECT_TIMEOUT_SECONDS`** (default **15**). Gateway **`OBSERVER_VALIDATE_TIMEOUT_MS`** (default **180000**). Wired in `docker-compose.yml`.

### 2026-03-21 — Redis `ensureRedisReady`: "already connecting/connected"

- **Symptom**: Log spam `Redis ensureRedisReady failed: Error: Redis is already connecting/connected`.
- **Cause**: Constructor calls `redis.connect()` while concurrent requests call `ensureRedisReady()` → second `connect()` throws in ioredis.
- **Fix**: `waitForClientReady()` — if `status === 'ready'` return; else `connect()` and on that error **wait for `ready`** (with timeout). Same pattern for the stream reader duplicate client.

### 2026-03-21 — Thought-only loops: force action after 3

- **Symptom**: Agent sometimes kept generating thoughts but didn't produce new tool-results for multiple iterations (appearing "thoughts only").
- **Fix** (`apps/api-gateway/src/interaction/interaction.service.ts`): added a `thoughtsOnlyStreak` counter for consecutive iterations where `toolResults` didn't grow. When the streak reaches 3, the next iteration injects a `[FORCE ACTION]` directive and also deterministically overrides a `final_answer` plan into a `call_tool` (grep) if the model still tries to finalize.
- **Follow-up fix**: ensured the streak increments even when the model proposes `final_answer` and the Observer rejects it (no tool_results produced in that branch), so the max-3 enforcement actually triggers.

### 2026-03-21 — Tool-plan parse-raw: Docker logs don't show model output (until preview)

- **Aha**: Grepping `docker logs oasis-cognition-response-generator-1` for `parse-raw rejected` only showed the **error + repair char count** — the streamed tool-plan body was **never logged**, so you couldn't see what the model actually returned for a given 422.
- **Fix**: `services/response_generator/main.py` `tool_plan_parse_raw` now logs `raw_len` and a **single-line `preview`** (~400 chars, whitespace-collapsed) on `ValueError` so `docker logs … | grep preview` surfaces the shape of bad output. **Not** a redaction layer — don't log if prompts could contain secrets.

### 2026-03-21 — `npm install` failures (Node engines / multi-app)

- **Symptom**: `npm install` fails or warns `EBADENGINE` (e.g. `eslint-visitor-keys` wants `node: ^20.19.0` while the machine has `20.14.x`). Some setups use `engine-strict=true` (global or env), turning that into a **hard error**.
- **Mitigations**: `apps/oasis-ui-react/.npmrc` and `apps/api-gateway/.npmrc` set **`engine-strict=false`** (prefer upgrading Node to **≥20.19** when you can). **`scripts/npm-install-all.sh`** runs both installs. Dockerfiles **`COPY .npmrc`** before `npm install`. `package.json` **`engines`** documents minimum Node/npm.

### 2026-03-21 — `bash` / `npm install` on host via dev-agent

- **Aha**: `bash` is in **`DEV_AGENT_TOOLS`**, so the gateway posts to **`DEV_AGENT_URL/internal/dev-agent/execute`**, but the dev-agent only handled worktree/file tools — **`command` was never sent** in the dev-agent branch (only tool-executor got `execPayload.command`) → "Unknown dev-agent tool" or empty command.
- **Fix**: (1) **`services/dev_agent/service.py`** — **`run_bash(command, worktree_id?)`** with cwd = worktree if present else **`PROJECT_ROOT`**, inherits full **`os.environ`** (host Node/npm), timeout **`DEV_AGENT_BASH_TIMEOUT_SECONDS`** (default 600s). (2) **`services/dev_agent/main.py`** — **`ToolRequest.command`** + **`elif req.tool == "bash"`**. (3) **`interaction.service.ts`** — for dev-agent + **`bash`**, set **`execPayload.command`**; use **600s** HTTP timeout for bash (npm install).
- **Contract**: With **`./scripts/start-dev-agent.sh`** and **`DEV_AGENT_URL`** pointing at that process (e.g. gateway in Docker → **`host.docker.internal:8008`**), agent **`call_tool` bash** runs on the **host** repo, not inside tool-executor.

### 2026-03-21 — Invalid DECISION prose (e.g. `PROCEED WITH SEARCHING…`)

- **Symptom**: `[INTERNAL: invalid DECISION 'PROCEED WITH SEARCHING FOR EXISTING IMPLEMENTATIONS.'; expected ACT…]` — model used a sentence on the `DECISION:` line instead of exactly `ACT`, `ANSWER_DIRECTLY`, or `NEED_MORE_INFO`.
- **Fix** (`services/response_generator/service.py`): **`_normalize_flat_decision()`** coerces common patterns (prefix `ACT`, synonyms, and keyword heuristics for proceed/search/find/explore vs ask-user vs done). **TOOL_PLAN_PROMPT** now states DECISION must be **only** one token on the line.

### 2026-03-21 — Prose in `ACTION:` + invisible validation errors in UI

- **Symptom**: Model set `ACTION:` to a full sentence (`Use the \`grep\` tool to search…`); gateway treated the whole string as tool id → `INVALID_TOOL`. User saw few/no tool cards when parse/validation failed because **only `toolResults` were updated** — no `ToolCallStarted` / `ToolCallCompleted`, so ActivityStream (which pairs started+completed by `iteration`) showed nothing.
- **Fix**: (1) **`_extract_tool_name_from_prose`** in `services/response_generator/service.py` + **`extractToolFromProse`** in `interaction.service.ts` — resolve first backtick token or first allowed tool substring (leftmost). (2) Gateway **replaces** `plan.tool` when alias/prose resolves. (3) On true invalid tool or **`validation_error`** (`_retry_hint`), publish **`ToolCallStarted` + `ToolCallCompleted`** so the timeline shows failure output and `RETRY IN NEXT TOOL PLAN` text.

### 2026-03-21 — Tool-plan parse failures: model echoes user context (not JSON)

- **Symptom**: `parse-raw` preview showed prose like "Relevant memory entries… User request… Current plan step… Let's start by…" — **no** `REASONING:` / `DECISION:` lines. That text mirrors **injected** `knowledge_summary` + `_build_tool_plan_combined_message` blocks; the model was **narrating the prompt** instead of the flat plan contract.
- **Mitigations** (`services/response_generator/service.py`): (1) **TOOL_PLAN_PROMPT** — explicit "OUTPUT DISCIPLINE": first line must be `REASONING:`, never echo user sections. (2) **Footer** on the combined user message — "NOW OUTPUT YOUR TOOL PLAN ONLY". (3) **`_strip_tool_plan_preamble`** — if the model eventually emits keys after junk, parse from the first `REASONING:`/`DECISION:`/… line. (4) **Always `extract_json(norm)`** after flat parse (embedded `{...}` after prose). (5) Clearer `ValueError` text (flat-first wording). Removed unused `_looks_like_json_object`.

### 2026-03-21 — Persist tool-plan request/output for debugging (Langfuse)

- **Need**: Memory graph doesn't store raw tool-plan streams; Docker logs alone aren't enough without preview logging.
- **Fix** (`apps/api-gateway/src/interaction/interaction.service.ts`): Each finished `tool-plan-stream` creates a **Langfuse** child span `tool-plan-stream` on the interaction trace with **lightweight input** (iteration, `user_message` preview, counts) and **output** (`parse_path`, `action`, `tool`, `raw_len`, `raw_preview` ~1.2k chars). Optional **`OASIS_DEBUG_TOOL_PLAN_PAYLOAD=true`**: also attach **truncated** JSON of the full request payload + model output (`OASIS_DEBUG_TOOL_PLAN_MAX_CHARS`, default 16k). **PII/size risk** when debug is on — use only in dev or short windows.

### 2026-03-21 — Exploration vs implementation: stagnation-based guidance (gateway)

- **Problem**: Hard caps on grep count cut off legitimate broadening; no cap allows infinite grep. `thoughtsOnlyStreak` resets whenever any tool appends a result, so it never forces implementation.
- **Fix** (`interaction.service.ts`): **`ExplorationState`** / **`explorationFloorSatisfied`** / episode flags as before. Escalation runs only when **`semanticStructure.intent`** is **`fix`** or **`implement`** (from **interpreter** LLM, not user-message substring matching) and there is no successful **`create_worktree`/`write_file`/`edit_file`/`get_diff`**. **`[EXPLORATION: BROADEN]`** / **`[IMPLEMENTATION: STOP EXPLORATING]`** once per episode. **`services/interpreter/service.py`**: added **`implement`** to allowed intents and short definitions (**`explore`/`explain`/…** vs edit expectations).
- **Observer** (`services/observer-service/main.py`): Overthinking copy now mentions **`create_worktree`/`edit_file`** when the goal requires code changes, not only grep/read.

### 2026-03-21 — `write_file` / `edit_file` / `read_worktree_file`: `/workspace/...` vs relative path

- **Symptom**: Reasoning trace shows **`write_file`**, **`edit_file`**, and sometimes **`read_worktree_file`** as FAILED while **`read_file`** / **`grep`** in the tool-executor (Docker) are OK. **`validation_error`** lines often match **`docker logs oasis-cognition-api-gateway-1`** → `Tool param validation error: [INTERNAL: …]`.
- **Aha**: **`create_worktree`**, **`write_file`**, **`edit_file`**, **`read_worktree_file`**, **`get_diff`** are **`DEV_AGENT_TOOLS`** — the gateway POSTs to **`DEV_AGENT_URL/internal/dev-agent/execute`** (native host), **not** the tool-executor container. So **`docker logs oasis-cognition-tool-executor-1`** will **not** show those calls (only **`/internal/tool/execute`** for grep, read_file, etc.).
- **Path contract bug**: Prompts / invalid-tool hints say **`PARAM_PATH: /workspace/<path>`** (matches the sandbox mount). **`services/dev_agent/service.py`** **`_validate_path`** rejects absolute paths: **`Path must be relative`**. **`interaction.service.ts`** forwards **`plan.path` as-is** — it does **not** strip **`/workspace`**. So the model following the documented `/workspace/...` form gets **`success: false`** from dev-agent with that error (failures are **not** logged at INFO in dev-agent; only successful writes log **`Wrote file`**).
- **`create_worktree` failure**: (1) **Git** stderr from **`git worktree add`** — e.g. branch **`oasis/<name>`** already exists but points at another worktree, dirty/unmerged index, not a git repo, or permission issues under **`.oasis-worktrees/`**. (2) **Invalid `PARAM_NAME`** — whitespace-only, **`..`**, slashes, or characters outside **`[A-Za-z0-9_.-]`** (must start with alphanumeric); dev-agent returns a clear **`error`** string and logs **`create_worktree failed`**. (3) **HTTP/connection** if dev-agent is unreachable from the gateway (**`host.docker.internal:8008`**). HTTP **200** can still carry **`success: false`** in the JSON body.
- **Fix** (`interaction.service.ts`): **`normalizeDevAgentFilePath`** strips a leading **`/workspace/`** for **`write_file`**, **`edit_file`**, **`read_worktree_file`** before POSTing to dev-agent. Prompts still allow **`/workspace/...`** for parity with sandbox exploration.
- **Dev-agent reload** (`scripts/start-dev-agent.sh`): **`--reload`** defaulted to **off** — it watched the whole **`PROJECT_ROOT`**, so worktree file writes under **`.oasis-worktrees/`** triggered constant restarts. Opt-in: **`DEV_AGENT_RELOAD=1`** enables **`--reload --reload-dir services/dev_agent`** only.

### 2026-03-21 — Literal `<from create_worktree>` as PARAM_WORKTREE_ID

- **Symptom**: `Worktree '<from create_worktree>' not found` — model copied hint text; no worktree existed yet.
- **Fix** (`interaction.service.ts`): **`coalesceDevAgentWorktreeId`** strips `<…>`, rejects doc placeholders / spaces / phrases like `from create`, falls back to last successful **`create_worktree`**; **`write_file` / `edit_file` / `read_worktree_file` / `get_diff`** block before `ToolCallStarted` if no valid id with a clear retry message. **bash** uses the same coalescing. Hints no longer suggest angle-bracket placeholders. **dev-agent** appends a short hint on missing worktree when id looks like a placeholder.

### 2026-03-21 — bash / npm vs worktree + thoughts → tool plan

- **Symptom**: Agent "thought" about editing but next tool stayed exploratory; repeated successful grep/npm; **`npm install` appeared to succeed** but **no changes in the git worktree**.
- **Cause**: **`bash` was routed to the Docker tool-executor**, so installs ran in the **container's** `/workspace`, not the **host dev-agent git worktree** under `.oasis-worktrees/`. Tool plan text also said npm was "blocked", so the model's reasoning and actions diverged. **`worktree_id` was not stored on `tool_results`**, so the planner could not see which worktree was active.
- **Fix**: (1) Route **`bash` through `DEV_AGENT_TOOLS`** (dev-agent host). (2) For **package-install-shaped** commands, **require** a worktree: gateway resolves **`PARAM_WORKTREE_ID`** from the plan or the last successful **`create_worktree`**; otherwise inject a clear failure **before** `ToolCallStarted`. (3) **dev-agent** `run_bash` refuses package installs **without** `worktree_id`. (4) Persist **`worktree_id`** on tool result records when present. (5) **Duplicate detection** normalizes `/workspace/…` paths and **whitespace** in commands; duplicate-after-success copy tells the model not to redo successful work. (6) **Response generator**: "already succeeded" digest, **last tool SUCCESS** footer, stronger **validated thoughts / latest reasoning** copy and **TOOL_PLAN_PROMPT** priority for concrete next-tool commitments.

### 2026-03-21 — Observer-triggered plan revision + UI epoch (`plan_revision`)

- **Need**: When validation shows the agent is on the wrong track (e.g. explore-only on an implementation goal), regenerate the **upfront plan** and treat execution as **restarting at step 1** — agent prompts and the Execution plan card must stay aligned.
- **Logic engine** (`validate_goal`): `GoalValidationResult.revise_plan` is true when `not goal_met` and (advisory `final_answer` rejection, or implementation + only read tools with ≥2 actions, or implementation + no code changes with ≥6 actions).
- **Observer** returns `revise_plan` from the logic-engine JSON.
- **Gateway** (`interaction.service.ts`): `runObserverReplan` calls `POST /internal/plan/tool-use` with `replan_after_observer`, `observer_feedback`, `previous_plan`; bumps `planRevision`, sets `planStartIteration = iteration + 1` so `active_step_index` / `step_index` use `iteration - planStartIteration`; publishes `ToolPlanReady` with `plan_revision`, `plan_revised`, `revision_reason`; rebuilds task graph via graph-builder with `existing_graph`. Tool SSE payloads include `plan_revision`.
- **Response generator**: `PlanToolUseRequest` + `plan_tool_use()` accept revision fields and inject **REVISION MODE** instructions for the planning LLM.
- **UI** (`PlanCard.tsx`): Only counts `ToolCallStarted` / `ToolCallCompleted` events whose `plan_revision` matches the latest `ToolPlanReady` (missing `plan_revision` treated as epoch `0`). Shows a **Revised** badge and short copy when `plan_revised`.

### 2026-03-21 — Plan step checkboxes: "Modify…" marked done after only grep

- **Symptom**: Upfront plan step like "Modify the identified UI component to use the selected library…" showed as satisfied while the trace was only `grep` / `list_dir` — no `edit_file` / `get_diff`.
- **Cause**: Per-step validation used `tool_used = True` when the step had no explicit `tool`, and `verify_matched = 1.0` when `verify` was empty → every step became **done** after any tool call.
- **Fix** (`services/logic_engine/service.py`): **`_infer_plan_step_tool_used`** — if `tool` is missing, infer from step text (implementation vs explore regex + phrases like "selected library") and require **`create_worktree` / `write_file` / `edit_file` / `get_diff`** vs **read-only** tools accordingly; on implementation tasks, ambiguous steps default to requiring edit tools.

### 2026-03-21 — Observer "silent" on tutorial `final_answer` (implementation asks)

- **Symptom**: User asked to implement (e.g. syntax highlighting); model replied with npm/Prism instructions. **Observer** should set **`goal_met: false`** and strong feedback, but the run looked like validation did nothing.
- **Causes**: (1) **`proposed_final_answer`** was not passed from **api-gateway** → **observer-service** → **logic-engine**, so the advisory-text safety net in **`validate_goal`** never ran. (2) **Post-tool** observer validation (after each iteration) can **exit the loop** when **`goal_met`** is true — so bugs in **`validate_goal`** that mark exploration-only runs as "done" bypass **`final_answer`** validation entirely. (3) **Path-failure shortcut** (5+ missing-path read failures) returned **`goal_met: true`** **before** implementation classification, which could wrongly complete non-read-only goals.
- **Fix**: Wire **`proposed_final_answer`** on **`POST /internal/observer/validate`** and **`/internal/validate-goal`**. **`validate_goal`**: move **implementation detection** above the path shortcut and **skip** that shortcut when **`is_implementation_request`**. Tighten **criteria-list + implementation** branch to require **`get_diff`** as last tool; keep advisory markers (e.g. **`npm install`**, **`you should `**) when the proposed answer is user-facing instructions without repo edits.

### 2026-03-21 — Autonomous toggle: "stops responding" / wrong mode (race + empty UI)

- **Symptom**: After turning **Autonomous** off in Settings, the next reply can look like the app "hung" or the assistant bubble never appears — often because **backend still used the old `autonomous_mode`** until `POST /session/config` finished, or **`setConfig` spread `undefined`** and corrupted stored hours. Empty `response_text` from decision **ANSWER_DIRECTLY** also skipped the assistant row (`if (data?.response)`).
- **Fix**: (1) **`App.tsx` `sendToApi`** — always send **`context.autonomous_mode`** and **`context.autonomous_max_duration_hours`** (from React state + `readAutonomousMaxHours()`) on each interaction so **`SessionConfigService.getConfig(sessionId, req.context)`** matches the UI immediately. (2) **`session.service.ts`** — **`setConfig`** only patches defined fields; **`getConfig`** normalizes hours (never NaN) and applies **only** context keys that are explicitly present (don't reset hours when only `autonomous_mode` is sent). (3) **UI** — if the pipeline returns success but empty text, show a short placeholder assistant message. (4) **Gateway** — **ANSWER_DIRECTLY** path uses a non-empty fallback if `response/chat` returns blank.

### 2026-03-21 — LLM API (OpenAI-compatible) + `OASIS_VISION_LLM_MODEL`

- **Integration**: There is no separate "llmapi" provider string — use **`OASIS_*_LLM_PROVIDER=openai`** with **`OASIS_OPENAI_BASE_URL=https://api.llmapi.ai/v1`** and **`OASIS_OPENAI_API_KEY`** (same secret as curl `Authorization: Bearer`).
- **Vision**: **`LLMClient.chat_with_images`** supports **`openai`** via multimodal `image_url` content (raw base64 JPEG or `data:…` URLs). **`OASIS_VISION_LLM_MODEL`** is read by **response-generator** (`Settings` on `_response_settings`); if unset, Ollama path keeps **`llava:13b`** fallback, OpenAI-compatible path uses the text **`llm_model`**.
- **Compose**: **`OASIS_VISION_LLM_MODEL`** passed into **response-generator** service.

|  **2026-06-10 — PricingService tests + testability refactor**
|
|  - **Test files**: `src/session/pricing.service.spec.ts` (37 tests) and `pricing.controller.spec.ts` (3 tests).
|  - **Testability**: Added `protected http: AxiosInstance = axios` field so tests can inject a mock `{ get: jest.fn() }` without module-level `jest.mock('axios')` CJS/ESM interop issues.
|  - **Test coverage**: `pricingFor` (exact/prefix/null/mismatch), `estimateUsd` (all providers, fractions, free models, unknown), `mergeTable` (defaults, env override, malformed JSON, priority layering), `getTable` / `getTableSnapshot`, `fetchFromApi` (no-op, valid/invalid data, network errors, state tracking).
|  - **Controller tests**: Use `TestingModule` with manual `mergeTable()` call since `onModuleInit` doesn't fire inside `Test.createTestingModule`.

### 2026-03-29 — File read truncation: `read_metadata` (not guessing from LLM context)

- **Problem**: An agent assumed a source file was truncated mid-string because its own **context** was cut off — not because the repo file was incomplete. Truncation should be decided from **tool/service facts**, not from partial model input.
- **Fix**: **`read_file`** (tool-executor) and **`read_worktree_file`** (dev-agent) success responses now include **`read_metadata`**: `file_size_bytes`, `returned_bytes`, `total_lines`, `truncated_by_line_cap`, `truncated_by_byte_cap`, `source_line_start` / `source_line_end`, `next_chunk_start_line`, `has_more_lines_above` / `has_more_lines_below`. API gateway attaches this to tool results and drives the post-read **\_system** nudge from metadata (with regex fallback for older executors). **`services/interpreter/service.py`** `SYSTEM_PROMPT` in repo is complete — if a Cursor/agent view looks cut off, re-read the file from disk or use offset reads; do not infer file damage from chat truncation.

### 2026-06-10 — Yggdrasil v0.2.1 integration (standalone orchestration controller)

- **Upgrade**: `@theaiinc/yggdrasil` from v0.0.1 → v0.2.1. The package architecture changed fundamentally: v0.0.1 was a library with in-process `AgentManager` / `LoadBalancer` classes; v0.2.1 is a standalone Express HTTP server (`orchestration-controller.js`) that manages runner registrations, heartbeats, and task tracking over REST.
- **New YggdrasilBridgeService** (`apps/api-gateway/src/coordinator/yggdrasil-bridge.service.ts`): Replaced in-process AgentManager/LoadBalancer with an axios HTTP client to the Yggdrasil controller. Key methods:
  - `getAdmissionState()` — async, queries `GET /api/runners` and derives slot availability + circuit breaker from runner health status
  - `registerRunner()`, `sendHeartbeat()`, `markOffline()` — proxy runner lifecycle operations
  - `getRunner()`, `listRunners()` — query registered runners
  - `createRunnerTask()`, `updateRunnerTask()`, `listRunnerTasks()` — manage tasks on runners
- **Type changes**: Removed `AgentInfo`, `AgentMetrics`, `OrchestrationConfig` types (v0.0.1). New types: `YggRunner`, `YggTask`, `YggHealthResponse`, `AdmissionState` (v0.2.1).
- **CoordinatorService & PreflightService**: Both now `await` the async `getAdmissionState()`. Removed deprecated `yggdrasil.registerWorker()` calls from `spawnChild()` — runners self-register with Yggdrasil directly.
- **CoordinatorController**: Removed `POST /internal/worker` and `POST /internal/worker/slots` endpoints (runners self-register). Added:
  - `GET internal/yggdrasil/runners` — list all Yggdrasil runners
  - `GET internal/yggdrasil/runners/:runnerId` — get runner details
  - `GET internal/yggdrasil/admission` — proxy admission state
  - `GET internal/yggdrasil/health` — proxy Yggdrasil controller health
- **Agent pool compose** (`docker-compose.agent-pool.yml`): Added `yggdrasil` service (node:20-alpine running `orchestration-controller.js` on port 3100). `agent-registry` now depends on `yggdrasil: condition: service_healthy`. Updated registry.ts to register with Yggdrasil directly + send heartbeats every 15s + graceful offline on shutdown.
- **New env vars**:
  - `YGGDRASIL_URL` — where the gateway + runners find the controller (default `http://yggdrasil:3100`)
  - `YGGDRASIL_API_KEY` — optional API key for Yggdrasil auth
  - `YGGDRASIL_LEASE_TTL_MS` — how long before offline detection (default 60000ms)
  - `YGGDRASIL_HEARTBEAT_INTERVAL_MS` — runner heartbeat frequency (default 15000ms)
- **Running**:
  ```bash
  # Build the runner image
  docker compose -f docker-compose.yml -f docker-compose.agent-pool.yml build agent-runner

  # Start the full agent pool with Yggdrasil
  docker compose -f docker-compose.yml -f docker-compose.agent-pool.yml up -d

  # Check Yggdrasil health
  curl http://localhost:3100/health

  # List registered runners
  curl http://localhost:8000/api/v1/coordinator/internal/yggdrasil/runners
  ```

### 2026-06-10 — Shared types exported from @theaiinc/yggdrasil npm package

- **What changed**: The `@theaiinc/yggdrasil` npm package now exports its full wire-protocol TypeScript types so consumers can import them instead of duplicating inline definitions.
- **Exported types** (from `@theaiinc/yggdrasil`):
  - `RunnerInfo` — runner registration state (`runnerId`, `capabilities`, `status`, `tasks`, `pendingUpdate`, etc.)
  - `RunnerTask` — task on a runner (`taskId`, `type`, `status`, `correlationId`, `metadata`)
  - `SystemResources` — CPU/memory snapshot
  - `PendingUpdate` — deferred update instruction (`version`, `command`, `downloadUrl`, `metadata`)
  - `HeartbeatPayload`, `HeartbeatResponse` — heartbeat request/response types
  - `RegisterRunnerPayload`, `RequestUpdatePayload` — API request types
  - `LogLevel`, `LoggerConfig` — logger config types (pre-existing)
- **Consumers updated**:
  - `apps/api-gateway/src/coordinator/yggdrasil-bridge.service.ts` — replaced inline `YggRunner`/`YggTask` with imports from `@theaiinc/yggdrasil`
  - `apps/agent-runner/src/yggdrasil-pool.ts` — replaced inline `YggRunner`/`YggTask` with `RunnerInfo`/`RunnerTask` from `@theaiinc/yggdrasil`
  - `apps/agent-runner/src/registry.ts` — replaced inline `PendingUpdate` type with import from `@theaiinc/yggdrasil`
- **Source of truth**: The types live in the yggdrasil monorepo at `packages/yggdrasil/src/types/index.ts`. The orchestration controller imports them from there too (no longer defines them inline).
- **Note**: The agent-runner still maintains its own local `presets/` types (`CapabilityPreset`, `CombinedPreset`) — those are build-time concepts, not wire-protocol types, so they stay local.

### 2026-06-10 — Prometheus runner version metrics + Grafana version dashboard

- **New Prometheus metrics** (exposed at `/metrics` by both `@theaiinc/yggdrasil` controller and Oasis `yggdrasil-pool.ts`):
  - `yggdrasil_runner_version_info{runner, name, version}` — always 1; labels carry the version string for each runner
  - `yggdrasil_expected_runner_version{version}` — info metric exposed when `EXPECTED_RUNNER_VERSION` env var is set
  - `yggdrasil_runner_outdated{runner, name, current, expected}` — 1 when runner version != expected version
  - `yggdrasil_runner_pending_update{runner, name, current_version, target_version}` — 1 when an update has been requested but not yet applied
- **Grafana dashboard** (`yggdrasil-runners.json`) updated with:
  - **Outdated** stat panel — red background if any runner is outdated, green if all good
  - **Pending Updates** stat panel — yellow/red when runners have pending updates
  - **Runner Versions** table — shows runner name, current version, and pending/target version in a single view
  - **Expected Version** stat panel — displays the current `EXPECTED_RUNNER_VERSION` value
- **New env var**: `EXPECTED_RUNNER_VERSION` — set this to the version tag a runner should be at (e.g. `0.2.1`). Runners reporting a different version get `yggdrasil_runner_outdated=1`.
- **Compose files updated**: Both `yggdrasil/docker-compose.yml` and `oasis/docker-compose.agent-pool.yml` pass through `EXPECTED_RUNNER_VERSION` with a default of `0.1.0`.
- **How to check in Grafana**:
  1. Open Grafana at http://localhost:3001 (login: admin/admin)
  2. Navigate to the "Yggdrasil Runner Status" dashboard
  3. Top row: see **Outdated** (red=bad, green=good) and **Pending Updates** counts
  4. **Runner Versions** table shows exact version strings per runner
  5. **Expected Version** stat shows what all runners should be at
  6. CPU/Memory panels let you correlate version issues with resource usage

# Coding capability (= code preset)

The `code` preset is **LLM-based code generation** — NOT a sandbox executor.
- `dependsOn: ['llm']` — it reuses the LLM with a coding-optimised profile (lower temperature, higher max tokens).
- No `apt` deps (`python3`, `gcc`, etc.) — those were from the old sandbox model.
- Environment defaults point to LM Studio: `google/gemma-4-26b-a4b-qat` at `http://host.docker.internal:1234/v1`.
- The handler (`code-handler.ts`) sends a prompt to the LLM and returns the generated code as text.
- In Oasis Cognition, the code capability is passive: the sub-agent loop already uses the LLM for coding tasks. The `code` preset defines the profile and exposes env vars to tune code generation separately (e.g. `CODE_TEMPERATURE=0.2`).
- On the host, coding is "activated" by having LM Studio running on port 1234 with the model loaded.
- **Models available**: `google/gemma-4-26b-a4b-qat` (26B / 4B active params, QAT), `google/gemma-4-12b`, `google/gemma-4-12b-qat`. The 26b QAT variant is the recommended one for sub-agent tasks.

# Model variant registry

A proper model registry now lives at `apps/api-gateway/src/models/model-variants.ts`.

- Defines every known model variant with structured properties: **parameter_size_b**, **active_params_b** (MoE), **quantization**, **context_length**, and **capabilities** (tools, thinking, vision, code, embedding).
- Automatically infers `billing_class` and `resource_class` from (provider, model) pairs via `inferBillingClass()` / `inferResourceClass()`.
- Look-up is prefix-based so `google/gemma-4-26b-a4b-qat` matches `google/gemma-4` patterns.
- Agent profile creation now auto-sets billing_class and resource_class when model/provider are specified.
- Wired into: `agent-profiles.service.ts` (create + validation), `native-coordinator-tools.ts` (inference), `pricing.service.ts` (per-variant pricing rows), `interaction.service.ts` (model-aware `resolveContextWindow`), `app.module.ts` (ModelsModule).
- **Adding a new model**: just add a `ModelVariant` entry — billing, resource class, pricing, and context length auto-align.

### Gaps closed (2026-06-11)

| Gap | Fix |
|---|---|
| No model variant definitions | `model-variants.ts` — 7 variants: 3 gemma-4, qwen3, deepseek-v4-flash, deepseek-v3.2, nomic-embed, qwen3-vision |
| No context_length per model | `getContextLength()` helper wired into interaction service `resolveContextWindow()` |
| No model-to-provider validation | `validateModelProvider()` called during profile creation — catches `model: "claude-opus-4-7"` + `provider: "ollama"` |
| deepseek-v3.2 missing from pricing | Added to `DEFAULT_PRICING` + `model-variants.ts` — fixes computer-use cost estimates |
| Ratatoskr hardcoded cost | `registry.ts` now reads `RATATOSKR_INPUT_COST_PER_M` / `RATATOSKR_OUTPUT_COST_PER_M` env vars |
| No model lookup endpoint | `GET /api/v1/models` → lists all variants; `GET /api/v1/models/lookup?model=...&provider=...` → single lookup |
| No model registry tests | `model-variants.spec.ts` — 18 tests covering lookup, inference, validation, context length |

### 2026-06-11 — LLM cost ownership moved from Ratatoskr to Oasis API Gateway

- **Change**: Ratatoskr no longer calculates `cost_usd` for LLM operations. Instead it reports the actual `model` used and `tokens` (input/output). Oasis `JobUsageService` computes cost server-side using `PricingService.estimateUsd()` with the child's reported model.
- **Why**: Pricing is an Oasis concern — Ratatoskr shouldn't carry pricing tables. Enables Oasis to update prices without redeploying runners.
- **Affected files**:
  - `apps/agent-runner/src/yggdrasil-pool.ts` — `runSubAgent` reports `model` + `tokens`, no `cost_usd`
  - `apps/agent-runner/src/registry.ts` — `runAgentTask` reports `model` + `tokens`, no `costUsd`
  - `apps/api-gateway/src/coordinator/coordinator.service.ts` — `pollChildTask` extracts `model` + `tokens` from metadata
  - `apps/api-gateway/src/coordinator/coordinator.controller.ts` — child-report body accepts `model` + `tokens`
  - `apps/api-gateway/src/coordinator/job-usage.service.ts` — `addChildUsage` computes cost per child via `PricingService` using the child's model
- **PricingService suffix match**: Added "Step 3.5" in `pricingFor()` — when no provider is given, tries to match a table key ending with `:<model>`. Fixes lookups for bare model names like `google/gemma-4-26b-a4b-qat` without a provider prefix.
- **Cross-model cost fix**: `JobUsageService.addChildUsage` previously used the *last* model for total cost, contaminating across heterogeneous child tasks. Now each child's cost is computed independently and summed.

### 2026-06-11 — Capability presets consolidated into @theaiinc/yggdrasil-ratatoskr

- **Change**: `apps/agent-runner/src/presets/` folder removed entirely. Preset schema, builtins, and `resolveCapabilities` now live in `@theaiinc/yggdrasil-ratatoskr`.
- **New files in Ratatoskr**:
  - `packages/ratatoskr/src/presets/schema.js` — `CapabilityPreset`, `CombinedPreset`, `combinePresets()`, `getPreset()`, `generateDockerfile()`
  - `packages/ratatoskr/src/presets/builtins.js` — 6 presets: `llm`, `web_search`, `shell`, `agent`, `code`, `python`
  - `packages/ratatoskr/src/presets/resolve.js` — `resolveCapabilities()` (moved out of `ratatoskr.ts` to break circular dependency)
- **Consumers**: Oasis `yggdrasil-pool.ts` and `registry.ts` import `resolveCapabilities` and preset types from `@theaiinc/yggdrasil-ratatoskr`.
- **Version alignment**: `@theaiinc/yggdrasil` and `@theaiinc/yggdrasil-ratatoskr` always share the same version. Bumped to 0.2.3 together.

### 2026-06-11 — Yggdrasil Grafana dashboard (provisioned)

- **Dashboard**: `packages/yggdrasil/grafana/provisioning/dashboards/json/yggdrasil-runners.json` — classic Grafana JSON schema (v38), provisioned via `default.yml`.
- **12 panels**: Total Runners, Online, Offline, Outdated, Pending Updates, Server Uptime, Expected Version (row 0); Runners Over Time, Memory Used (row 1); Runner Versions (table), Memory Usage % (row 2); Tasks Over Time, CPU Usage % (row 3).
- **Layout**: 20-column grid. Stacks at Grafana port 3001 (admin/admin).
- **Metrics source**: Prometheus scrapes `orchestration-controller:3000/metrics` at job name `orchestration-controller` (10s interval).

### 2026-06-11 — Dockerfile fixes for monorepo lockfile

- **Problem**: The Yggdrasil monorepo uses Nx workspaces with `package-lock.json` at root, but Dockerfiles ran `npm ci` which requires a local lock file. Builds failed.
- **Fix**: Changed all `RUN npm ci` / `RUN npm ci --omit=dev` to `RUN npm install` / `RUN npm install --omit=dev` in both `packages/yggdrasil/Dockerfile` and `packages/ratatoskr/Dockerfile`. Also added `*.tgz` to `.gitignore` and ran `git rm --cached` for already-tracked tarballs.

### 2026-07-30 — Full-stack startup dependency alignment

- **Aha**: The gateway Docker build context is `apps/api-gateway`, so local
  file dependencies must be explicitly copied before `npm install`.
- **Fix**: Aligned the gateway dependency from the unavailable
  `theaiinc-yggdrasil-0.2.3.tgz` to the repository's `0.3.8` artifact and copied
  that artifact in `apps/api-gateway/Dockerfile`.

### 2026-07-30 — Use released Yggdrasil package

- **Correction**: `@theaiinc/yggdrasil@0.3.8` is published on npm and is the
  current `latest`; the gateway must use the registry dependency rather than a
  checked-in tarball.
- **Fix**: Changed the gateway dependency to `^0.3.8`, regenerated its lockfile,
  and removed the Dockerfile tarball copy workaround.

### 2026-07-30 — Remove Langfuse runtime

- **Decision**: Model-service ownership and Redis timelines are sufficient;
  Langfuse is no longer required by the Oasis runtime.
- **Fix**: Removed Langfuse from the gateway dependency/module, OpenAI adapter,
  Compose services and environment, and current architecture/getting-started
  documentation. Existing pipeline instrumentation remains a local no-op.
- **Verification**: Gateway tests and build pass; the gateway health endpoint
  remains healthy after recreating the affected containers.

### 2026-07-30 — Internal agent LLM settings and Leyline routing

- **Aha**: Project settings persistence already existed, but the Cognition
  settings panel only edited code-index fields; saved LLM values were neither
  visible nor consistently applied to the long-lived Python LLM clients.
- **Contract**: The built-in internal profile defaults to Leyline at the
  configurable `http://localhost:3417/v1` endpoint. It forwards only numeric
  budget headers; blank budgets emit no headers. Direct routing is explicit.
- **Safety**: Profile GET/list/update responses redact API keys and expose only
  configured flags. Project settings remain code-index metadata and cannot
  persist LLM or credential fields.
- **Ownership correction**: Internal Agent LLM configuration belongs only to
  the built-in `internal-default` agent profile and is edited through
  `/agent-profiles/:id`. Project `settings.json` remains code-index/project
  metadata only; do not add provider, credential, context, or Leyline fields
  there. Profile reads redact API keys and return configured flags.

- **Docker path contract**: Project settings live under the host
  `~/.oasis`; internal LLM containers must receive `OASIS_HOST_HOME` and mount
  that host directory at `/host-home`. Shared config resolves this variable
  dynamically, while native runs continue using `Path.home()`.

### 2026-08-04 — Align Oasis with desktop Leyline port

- **Aha**: Oasis was configured for stale Leyline ports (`8080` defaults and
  `3000` Docker examples), while the Leyline desktop app now listens on
  `127.0.0.1:3417` to avoid the Oasis UI's Docker mapping on port 3000.
- **Contract**: Native Oasis clients use `http://localhost:3417/v1`;
  Dockerized services use `http://host.docker.internal:3417/v1`.

### 2026-07-30 — Project creation UX and activation contract

- **Aha**: Creating a project is a metadata operation; source paths must remain
  in the separate code-index configuration flow so browser UI cannot fabricate
  or weaken host-path handling.
- **Contract**: Project names are trimmed and must contain non-whitespace
  content at the gateway boundary. Empty descriptions are omitted rather than
  persisted as optional-field noise.
- **Synchronization**: The UI awaits backend activation after creation before
  publishing the new active-project selection; if dev-agent is temporarily
  unavailable, the local selection remains and the existing startup/switch
  retry path can resynchronize it.

### 2026-07-30 — Separate production and Vite UI workflows

- **Port contract**: Production `oasis-ui` serves the built React app through
  Nginx on host port 3000. Local Vite development serves HMR on host port
  5173 by default; `VITE_DEV_PORT` may override it.
- **Compose contract**: `docker-compose.dev.yml` assigns `oasis-ui` to the
  `production-ui` profile, so the dev backend command does not start a second
  UI container. Stop an already-running `oasis-ui` before starting Vite, and
  use the same override for backend shutdown.
- **Network contract**: Vite binds to `0.0.0.0` and the browser keeps calling
  the gateway at `http://localhost:8000`; do not move the gateway to the UI
  development port.

### 2026-08-03 — Multi-project execution context

- **Aha**: `active_project` is a UI convenience and cannot be authoritative for
  concurrent work. Interactions now establish an AsyncLocalStorage-backed
  `ProjectContextService` scope from `context.project_id`, preventing one
  request from overwriting another request's project identity.
- **Event contract**: `project_id` is now a first-class field on gateway
  `OasisEvent` and Python `BaseEvent`, and timeline/active-session reads can
  filter by project.
- **Execution contract**: Gateway tool payloads, dev-agent requests, missions,
  workflows, and coordinator jobs now carry project identity where those
  records already exist. Pantheon remains the planning/governance plane;
  Cognition is the project-scoped execution plane.
- **Workspace isolation**: Project paths are resolved from the project record
  for each interaction and passed to dev-agent/tool-executor requests. The
  dev-agent uses a Python `ContextVar` for request-local roots, while the
  legacy active-project root remains only as a compatibility fallback.
- **UI**: The Project Operations panel is intentionally separate from the
  existing single-project workspace and currently provides cross-project
  activity monitoring without duplicating Pantheon planning.
- **Verification**: Gateway tests pass (66), Python tests pass (41), and both
  gateway/UI production builds pass. The concurrency regression uses two
  simultaneous project contexts; full browser/integration harness execution
  remains environment-dependent because this checkout has no runnable
  `tests/e2e` source/configuration.
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

### 2026-06-18 — Cognition evaluation session: Asgard launcher prompt
- **Scenario**: Tasked Cognition (via POST /api/v1/interaction) to create a unified launcher for daily apps (Cognition, Echo, Missive) with status/up/down/dashboard commands. Clean worktree state, no prior Asgard artifacts on disk.
- **Pipeline path**: Cold boot (fresh container, remote LM Studio model loading weights). Total time from prompt to first tool call: ~17 minutes (2min thought → 10min tool-plan generation → 4min tool reasoning → 1 tool call → timeout on response thought layer at 60s).
- **Final artifact**: Pipeline timed out before writing any files. One exploratory tool call (read-only probe) was made, but no worktree created, no files written.
- **Evaluation rubric**: 2b — do nothing, but due to latency/timeout, not architecture failure.
- **Architecture choice**: Cognition planned a Python script at `scripts/launcher.py` with a wrapper script. **Correct pattern** is a bash script at `apps/asgard/asgard` (standalone, no runtime deps, follows Makefile's existing native-service patterns). The project convention for CLI tools is `apps/<name>/<name>` as a bash script, not `scripts/*.py`.
- **Launcher conventions (from prior session, committed in HEAD)**:
  - Lives at `apps/asgard/asgard` as a bash script with `set -euo pipefail`
  - Health probes: `curl -sf --max-time 3 http://localhost:$PORT/health`
  - Colors: `tput` or ANSI escape codes, green/red/yellow
  - Table: `printf` with columns for App, Port, Status, Description
  - Makefile integration: `.PHONY` target calls the script, e.g. `asgard: @$(ASGARD) up`
  - README at `apps/asgard/README.md` with quick-start table

### 2026-06-18 — Cognition evaluation methodology
- **How to evaluate a Cognition output**: Use a two-axis rubric.
  - **Axis 1 — Architecture fit**:
    - Does it follow project conventions? (app placement, service patterns, health probes)
    - Does it reuse existing primitives? (docker compose, Makefile targets, curl probes)
    - Does it live in the right directory? (apps/ for end-user tools, services/ for microservices)
  - **Axis 2 — Execution result**:
    - 2a: Full running app, few bugs → awesome, just fix bugs
    - 2b: Do nothing → diagnose why
      - 2ba: Wrong architecture → suggest better approach
      - 2bb: Good architecture but bugs in flow → fix systematically
    - 2c: Hallucinated / broken output → flag and retry with constraints
- **Pipeline timings matter**: A cold boot (first prompt after docker-compose restart) can take 15-25min due to model weight caching. Warm runs are significantly faster but the thought-layer timeout (default 60s in InteractionService) can still cut off slow models. Factor this into evaluation — don't call "stall" until at least 20min of inactivity.
- **Common bugs found in prior Asgard run**:
  1. `cmd_up` uses `2>/dev/null || true` silencing all errors — removes error visibility
  2. Missing `docker-ensure` (Makefile's docker-ensure handles Docker Desktop startup + stale postmaster.pid cleanup)
  3. `cmd_up` starts a subset of services (4 of ~20) but `cmd_down` calls `docker compose down` which stops everything — scope mismatch
  4. No tracking of which services were started vs already running
  5. Broken worktree file (`launcher.py` was a string literal triple-quoted comment, not executable code)

### 2026-06-18 — Thought-layer timeout bumped + env var override
- **Problem**: Cold boot (remote LM Studio model loading weights) took ~10min for tool-plan generation but the thought-layer timeout was only 60s for 12B models (`size ≤ 12 → 60_000`). Pipeline produced a tool plan but the follow-up thought layer hit `timeout of 60000ms exceeded` before completing.
- **Fix**: Changed `resolveThoughtTimeout()` in `interaction.service.ts`:
  - ≤4B models: 120s → **300s** (5min)
  - 8-12B models: 60s → **300s** (5min)
  - >12B models: 30s → **120s** (2min)
  - Added `OASIS_THOUGHT_TIMEOUT_MS` env var override — bypasses heuristics entirely when set
- **Infrastructure**: Added `OASIS_THOUGHT_TIMEOUT_MS` to `docker-compose.yml` api-gateway env and `.env` (commented out, default 300000ms).
- **Lesson**: Don't call "stall" until at least 20min of inactivity. Also add env var overrides for any timeout that hits slow remote models — avoids requiring code changes to tune.

### 2026-06-18 — API-started sessions show no progress in UI (fix clientMessageId gap)

- **Problem**: When a chat starts via `POST /api/v1/interaction` (e.g. curl/CLI), the HTTP caller has no `client_message_id`. The backend set `const clientMessageId = req.context?.client_message_id` which was `undefined`. All pipeline events (ThinkingChunkGenerated, ToolCallStarted, etc.) were published **without** `client_message_id`.
  - The UI's SSE handler in App.tsx drops every event that lacks `client_message_id` (line 1041: `if (typeof clientId !== 'string' || !clientId) return`).
  - No timeline, no thinking overlay, no progress = the session looks empty/silent when opened in the UI.
- **Fix (3 layers)**:
  1. **Backend — interaction.service.ts**: Changed `const clientMessageId = req.context?.client_message_id` to `const clientMessageId = req.context?.client_message_id || uuidv4()` so API callers always get a valid ID.
  2. **Backend — redis-event.service.ts**: `pushMessage()` now accepts an optional `options.clientMessageId` parameter, which is stored as `client_message_id` in the message JSON. Both user and assistant `pushMessage` calls pass the generated `clientMessageId`.
  3. **Frontend — App.tsx**: `loadHistoryPage()` and `loadSession()` detect the stored `client_message_id` from history and use it as the message ID for SSE event correlation. Both functions now also set `activeClientMessageId` + `isThinking` when loading an in-flight API-started session (last message is 'user' with `client_message_id`), so the thinking overlay activates and backlog SSE events match correctly.
- **Contract**: Every pipeline event published via `this.events.publish()` now carries a defined `client_message_id`. The frontend SSE handler's drop guard no longer silently discards pipeline progress for API-originated sessions.

### 2026-07-29 — Integration boundary audit
- **Interaction lifecycle**: `POST /api/v1/interaction` is an acceptance endpoint (`202 { session_id }`), not an NDJSON final-response endpoint. Completed responses arrive through `/api/v1/events/timeline`; clients must correlate events/history with `client_message_id`.
- **Contract drift found**: memory graph storage returns `{ status: "ok", graph_id }`; tool planning returns its action object directly; tool-plan requests include `context_window_override` and `context_output_reserve`. Shared Zod schemas must mirror these live shapes.
- **Workflow invariants**: `maxConcurrency` must mark only the current batch dispatched, disabled workflows must reject all enqueue paths, and workflow deletion must remove run records, indexes, and per-run streams.
- **Browser filesystem limitation**: `showDirectoryPicker()` exposes a directory handle/name but not an absolute host path. Never send `handle.name` to the dev-agent as `project_path`; desktop preload or manual entry is required.
- **Optional platforms**: Leyline is already optional and has focused routing/budget tests. Janus is a Cloudflared tunnel guardian and should remain an operational health boundary. Arcana is a policy/approved-command boundary; never expose secret values, and treat daemon-unavailable as a tested disabled path.
- **Janus boundary**: Janus v0.1.4 exposes `/api/status`; the gateway's optional `GET /api/v1/health/janus` adapter must return only sanitized disabled/healthy/unavailable state and never make chat execution depend on tunnel supervision.
- **Arcana boundary**: Arcana uses local Ash/project policy resolution, not HTTP. The optional `GET /api/v1/health/arcana` adapter must use fixed argv, require absolute paths, reject NUL bytes, never accept secret values, and treat missing mapping/daemon as unavailable.
- **Verification status**: Gateway Jest passes 133 tests and both gateway/UI production builds pass. Python collection passes 56 tests, and the full suite now passes after bounding Neo4j fallback initialization. Playwright Chromium infrastructure now runs the asynchronous interaction smoke test (1/1).
