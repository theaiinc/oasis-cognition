## AGENT_GUIDELINES (devlog + conventions)

This file is a running devlog/compass for Oasis Cognition agent work. Keep it updated with “aha” moments, interface contracts, and any conventions that are easy to forget.

### 2026-03-29 — Teaching-service Docker image goes stale (fixes “don’t apply”)

- **Symptom**: Repo `services/teaching-service/service.py` is updated but behavior in Compose is unchanged; `docker logs` still show old validation patterns.
- **Cause**: `docker-compose.yml` **does not mount** the service source into `teaching-service` — code is **baked at build time**. `docker compose ps` can show the container “Up 3 days” while `api-gateway` was recreated recently; only rebuilt images pick up Python changes.
- **Fix**: After editing teaching-service: `docker compose build teaching-service && docker compose up -d teaching-service` (or `docker compose up -d --build teaching-service`).

### 2026-03-29 — Teaching follow-ups ignored by validator (repeat clarifying questions)

- **Symptom**: After the user answered “I meant X not Y,” the teaching flow kept asking the same clarification (e.g. “never use mocks” read as universal testing advice vs scoped to product implementation).
- **Cause (1)**: `continue_from_clarification()` merged the reply into `TeachingAssertion.supporting_context`, but `validate()` originally omitted it from the LLM prompt.
- **Cause (2)**: Follow-up still re-ran **the same extracted assertion and search query**, so web hits stayed on “mocks in unit tests.” `/internal/teaching/continue` also returned the **stale** assertion object, not a refined one.
- **Cause (3)**: API gateway only wrote `teaching/pending` when `clarifying_questions.length > 0`. If the model cleared questions but left `contradictions` / low confidence, **pending was deleted** while the assistant still refused to store — the user’s next message no longer hit `handleTeachingFollowup`.
- **Fix**: `continue_from_clarification` re-**extracts** assertion + `search_query` from original + clarification; optional `_accept_after_scope_clarification` when the user clearly separates tests vs implementation; validator prompt heuristics for scoped claims and `preference`; gateway persists pending whenever **not** `readyToStore` (`validated`, `confidence ≥ 0.6`, **zero contradictions**).

### 2026-03-29 — Interpreter history + second-person replies

- **Problem**: Vague follow-ups (“pls fix”) were easy to mis-route or answer without thread context; `chat_history.slice(-6)` could drop the gateway’s `Conversation summary:` system row when the condensed window had more than six messages. Models also mirrored “User asked …” / “the user” in user-visible text.
- **Fix**: `buildInterpreterChatHistory()` in `interaction.service.ts` keeps the latest summary system message plus up to six other turns. Interpreter uses `_merge_interpreter_chat_history()` with the same rule and an explicit prompt line about summaries. Response-generator `SYSTEM_PROMPT`, `CASUAL_SYSTEM_PROMPT`, and complex `format_response` / stream labels use **Message:** + instructions to reply in **second person** (“you”) and to use the thread for vague messages.

### 2026-03-22 — README + docs hub (architecture / guides)

- **Root README** now summarizes architecture (Mermaid), ports, quick start (`make up`, Ollama, dev-agent, optional code-indexer), API entry `POST /api/v1/interaction`, and “what stands out.”
- **`docs/README.md`** indexes curated docs; **`docs/architecture/overview.md`** = operational architecture + port table; **`docs/guides/getting-started.md`** = setup; **`docs/guides/what-makes-oasis-different.md`** = product/technical differentiators. Cross-links to **SAD.md** and **code-indexing-service-design.md**. **Makefile** primary targets are `make up` / `make down` (not `dev-up`).

### 2026-03-22 — Code knowledge graph (Tree-sitter + Neo4j)

- **`services/code_indexer`**: Indexes TS/TSX/JS/JSX under `OASIS_WORKSPACE_PATH` (default `/workspace`) into Neo4j labels **`CodeFile`**, **`CodeSymbol`**, **`CodeModule`**. Uses **`tree-sitter` + `tree-sitter-typescript`** (TS vs TSX grammars). Port **`8010`** (not 8009 — that is observer-service).
- **Compose**: `code-indexer` service; enable background indexing with `OASIS_CODE_INDEXER_INDEX_ON_START=true`; optional **`OASIS_CODE_INDEXER_WATCH=true`** for debounced re-index on file changes.
- **Memory API** (same Neo4j): `GET /internal/memory/code/symbols?q=…`, `/code/references?symbol_id=…`, `/code/hierarchy?root=…`, `/code/imports?path=…` — for agents/UI to resolve symbols without grep-first spirals.
- **API Gateway → tool plan**: Before the tool loop, the gateway calls **`/internal/memory/code/symbols`** (up to 3 queries derived from the user message + `semantic_structure`) and appends a **`[CODE INDEX (Neo4j)]`** block to **`knowledge_summary`** for every tool-plan hop. Opt out with **`OASIS_CODE_KNOWLEDGE_IN_TOOL_PLAN=false`**. Timeout: **`OASIS_CODE_KNOWLEDGE_TIMEOUT_MS`** (default 2500).
- **Package imports**: run as `uvicorn services.code_indexer.main:app` with **`PYTHONPATH=/app`**; use **`services.code_indexer.*`** imports inside the package.

### 2026-03-22 — Heuristic tool-plan repair (LLM) before failed tool use

- **`parse_tool_plan_raw`**: If the streamed plan is **unparseable** (`ValueError`), one **`_tool_plan_llm`** pass (`TOOL_PLAN_HEURISTIC_REPAIR_PROMPT`) rewrites output into flat `REASONING:` / `DECISION:` / `ACTION:` / `PARAM_*:` lines, then parse runs again.
- If parse succeeds but **`_retry_hint`** + **`final_answer`** with **`[INTERNAL:`** (invalid tool, missing params, invalid DECISION, etc.), the same repair runs once using the internal error text as context.
- **Gateway** unchanged: still calls `tool-plan/parse-raw`; fewer 422s and fewer `validation_error` tool rows from bad primary output.

### 2026-03-22 — apply_patch (unified diff) + forgiving paths

- **apply_patch** dev-agent tool: applies a **unified diff** in the worktree via `git apply`, trying `--whitespace=nowarn` → `--ignore-space-change` → `--ignore-whitespace` for lenient matching. Strips optional \`\`\`diff fences; rejects `..` and absolute paths in `---`/`+++` lines. Gateway / response-generator / logic-engine treat it like other code mutations.
- **Forgiving paths**: dev-agent **write_file**, **edit_file**, **read_worktree_file** normalize repo-relative paths (strip `/workspace/`, `./`, leading `/`, trailing lone `.`).
- **Aliases**: `patch`, `unified_diff` → **apply_patch** (no longer folded into **edit_file**). Planner prompt prefers **apply_patch** over **edit_file** for non-trivial edits.

### 2026-03-21 — edit_file / write_file “fails on last iteration” (empty string dropped)

- **Symptom**: Final cleanup edits (e.g. removing a line) failed with missing params or dev-agent “Missing … new_string”.
- **Cause**: Gateway used `plan.new_string || undefined` (same for `content` / `old_string`). Falsy **`""`** was omitted from the JSON body → FastAPI saw `new_string=None`. Response-generator used `not plan.get("new_string")`, so **`""`** was treated as missing.
- **Fix**: Gateway `??` for `content` / `old_string` / `new_string`. Response-generator: require `new_string` with **`is None`** only; `write_file` content same. Dev-agent `edit_file`: normalize CRLF/LF on `old_string` / `new_string` before matching.

### 2026-03-21 — Plan + free-thought churn during exploration

- **Symptom**: Upfront plan and free-thought layer revised almost every tool hop even when exploration was healthy.
- **Causes**: (1) Logic engine set `revise_plan` after **2** read-only actions on implementation-shaped goals (`only_read_tools && total_actions >= 2`), and again at **6** without code changes — observer replan fired often. (2) Gateway treated **any** non-empty `observer_feedback` as a reason to rerun **thought/generate**, **generateStreamingThoughts**, and **decision**; routine feedback always includes long “goal not met” + step-progress text.
- **Fix**: Logic engine — single threshold **`total_actions >= 12`** with **`not has_code_changes`** (plus `advisory_blocked`). Gateway — `feedbackWarrantsReasoningRefresh()` gates mid-loop refresh; thought graph nodes only when `iteration === 0` or that gate is true.

### 2026-03-21 — “edit_file failed” from duplicate detection (path-only signature)

- **Symptom**: Logs showed `Duplicate tool call detected: edit_file …path… — injecting redirect` on the **second and later** edits to the **same file** in one session.
- **Cause**: Duplicate-call detection compared `tool + path + command + …` but **not** `old_string` / `new_string`, so every new patch to `CodeBlock.tsx` matched the first `edit_file` and was blocked with `success: false` before dev-agent ran.
- **Fix** (`interaction.service.ts`): **Skip** duplicate interception for `edit_file` and `write_file` (multiple distinct patches per file are normal).

### 2026-03-21 — edit_file / read_file ergonomics

- **edit_file validation**: Response-generator no longer requires `worktree_id` in the parsed plan for `edit_file` / `write_file` / `read_worktree_file` — gateway already coalesces from `create_worktree`. Paths sent to dev-agent strip a trailing lone `.`; dev-agent resolves missing extensions (e.g. `CodeBlock` → `CodeBlock.tsx`) for **read_worktree_file** and **edit_file**.
- **Duplicate read_file / read_worktree_file**: Gateway returns **success** with **full cached output** from the earlier identical call (plus a short `[Cached: …]` tag) instead of a failed duplicate block.
- **ActivityStream timeline**: Thought layer chunks render **in order** with other events (no deferred sticky block at the bottom).

### 2026-03-21 — Thought layer: height + scroll noise

- **Symptom**: Thought layer pinned at the bottom of the activity stream; duplicate `ThoughtLayerGenerated` events rescrolled even when text unchanged; tall prose hid tool cards above.
- **Fix** (`apps/oasis-ui-react`): `computeThoughtStreamRevision()` (`lib/thoughtStreamRevision.ts`) bumps only on chunk growth or **last** layer body length/hash — not raw layer event count. `ToolCallsScrollContainer` thought `useLayoutEffect` respects **`userScrolledUp`**. `ActivityStream` thought-layer + long validated quotes use **~3-line** `max-h-[3.4rem]` with **Show full / Show less** (`LayerExpandToggle`).

### 2026-03-21 — Plan checkboxes vs “Install library” steps

- **Symptom**: Step “Install the chosen syntax highlighting library” showed checked even though no `npm`/`pip`/`edit_file` on `package.json` ran.
- **UI cause**: `PlanCard` treated step *i* as done when `successfulCount > i` (any N successful tools), so three `grep`/`read_file` calls checked off the first three plan lines regardless of meaning.
- **Fix (UI)**: Prefer `step_statuses` from the latest `TaskGraphUpdated` → `task_graph` → last `CompletionNode.attributes.step_statuses`. Else match `ToolCallCompleted` rows by **`step_index === i`**. Legacy `successfulCount` fallback only if completions lack `step_index`.
- **Fix (logic engine)**: `_INSTALL_STEP_RE` + require **`bash` / `edit_file` / `write_file`** for install/dependency/package.json wording; if the plan wrongly assigns `read_file` to such a step, **do not** treat read-only tools as satisfying it.

### 2026-03-21 — Autonomous tool_use: read loops vs edit_file

- **Symptom**: In autonomous mode with fix/implement intent, the agent kept calling `read_file` / `grep` every iteration and rarely reached `create_worktree` / `edit_file` / `write_file`.
- **Cause**: `updateExplorationStateFromToolResult` treated every **expanding** `read_file` as success that **reset** `explorationState.stagnation` to 0, so `buildExplorationEscalationGuidance` almost never hit `[IMPLEMENTATION: STOP EXPLORING]`.
- **Fix** (`apps/api-gateway/src/interaction/interaction.service.ts`): For `toolUseNeedsImplementationEscalation` (intent `fix` / `implement`), expanding results from `read_file`, `grep`, `list_dir`, `find_files`, `browse_url` **increment** stagnation instead of resetting. **Autonomous** extras: observer line after **5+** successful explore-only tools; **override plan** to `create_worktree` after **12+** if the model still chose an exploration tool.

- **Follow-up (“same” behavior)**: (1) Interpreter often labels autonomous goals **`explore`**, not `fix`/`implement`, so escalation never ran. **Autonomous** now escalates unless intent is `greet` or `teach`. (2) `hasSuccessfulImplementationProgress` became true after **`create_worktree`**, so autonomous nudges and `buildExplorationEscalationGuidance` stopped — the model could read forever **after** a worktree. Escalation and stagnation now treat **success** as **`edit_file` / `write_file`**; separate nudge **`[AUTONOMOUS — EDIT NOW]`** after **2+** read-only tools following the last successful worktree. Thresholds: nudge from **3** explores, force worktree from **7**.

### 2026-03-21 — Thought layer UI: pin streaming card + collapsed validated thought

- **Symptom**: `ThoughtChunkGenerated` events interleaved with tool cards left the Thought Layer block in the middle of `ActivityStream`; inner scroll pinned to bottom but the growing card was off-screen. Collapsed **Agent Thoughts** (`ThoughtsValidated`) showed the **first** thought instead of the latest.
- **Fix** (`apps/oasis-ui-react`): **`ActivityStream`** aggregates chunk/layer text but **renders deferred `interaction_id` groups after** all inline tool / validated rows so the streaming card stays at the bottom of the scroll container. **`ThoughtsDisplay`** + **`ActivityStream`** use **`thoughts.slice(-1)`** when collapsed. **`App.tsx`** adds **`activeThoughtStreamRevision`** to the main viewport auto-scroll deps so chunk **character** growth still scrolls when near bottom.

### 2026-03-16 — Aha: screen context was dropped at interpreter boundary

- **Symptom**: LiveKit screen share frames were flowing, and the voice agent was already attaching `context.screen_content`, but routing/extraction did not change.
- **Root cause**: `apps/api-gateway/src/interaction/interaction.service.ts` called the interpreter with only `{ text }` and **did not forward** `req.context`.
- **Fix**: Interpreter requests now accept `context` and the interpreter prompt prepends `EXTERNAL_CONTEXT` so the LLM can use screen OCR / UI state during route classification + entity extraction.

### Screen context contract

- **Where it originates**: `services/voice-agent/main.py` OCRs screen-share frames and sends them as `context.screen_content` in the `/api/v1/interaction` request payload.
- **Where it must be forwarded**:
  - API Gateway → Interpreter: `POST /internal/interpret` must include `context`.
  - Interpreter → LLM: prompt must include external context to influence `route`, `entities`, and `context` output.

### 2026-03-16 — Teaching completion: multi-turn pending state

- **Problem**: Teaching often returns clarifying questions; without session state, the next user message starts a new teaching extraction instead of continuing the same validation.
- **Fix**: Store a **pending teaching** state keyed by `session_id` in `memory-service` and have the API gateway **auto-resume** teaching when a pending state exists.
- **New endpoints**:
  - `GET /internal/memory/teaching/pending?session_id=...`
  - `POST /internal/memory/teaching/pending`
  - `DELETE /internal/memory/teaching/pending?session_id=...`
  - `POST /internal/teaching/continue` (re-validates after user clarification)

### 2026-03-16 — UX: queue messages while reasoning

- **Problem**: UI blocked sending while `isThinking`, causing users to wait and disrupting flow; also a new `session_id` per text message breaks multi-turn flows.
- **Fix**: `apps/oasis-ui-react/src/App.tsx` now keeps a **stable** `textSessionId` and queues typed messages while reasoning; queued messages auto-send after the current response finishes.

### 2026-03-16 — Casual route 500 and voice timeline

- **Casual 500**: Response-generator `/internal/response/chat` was surfacing Ollama errors (e.g. "model runner has unexpectedly stopped") as 500. **Fix**: `services/response-generator/main.py` catches exceptions in `casual_chat` and returns 200 with a friendly fallback message so the gateway no longer returns 500.
- **Voice timeline stuck at VoiceRequestSent**: Timeline SSE is filtered by `session_id`; the voice agent used its own `session_id`, so backend events (Interpreter, Graph, etc.) never reached the UI. **Fix**: UI sends `{ type: 'set_session', session_id: textSessionId }` over LiveKit data on `RoomEvent.Connected`; voice agent listens for `data_received`, updates effective session id, and uses it in `call_oasis()` so all voice pipeline events are published under the same session the UI subscribes to.

### 2026-03-17 — Aha: hallucinated vision without screen_image

- **Symptom**: In some chats, the model confidently described “the image you provided” (e.g., a Discord screen) even though the user had not shared any image or enabled screen sharing.
- **Likely cause**: The casual system prompt advertised “you can see the user's screen when they enable screen sharing (Vision button)” but did not explicitly forbid visual descriptions when no `screen_image` was attached, so the model generalized and hallucinated screenshots based on text alone.
- **Fix**: Tightened `CASUAL_SYSTEM_PROMPT` in `services/response-generator/service.py` to:
  - Make visual access conditional on an explicit `screen_image` attachment.
  - Instruct the model to say clearly that it **cannot** see the screen when no image is present and only then suggest using the Vision button.
  - Explicitly forbid inventing or describing images / UIs unless an actual image is attached.
- **Contract**: Any future prompts that mention vision/screen-reading must:
  - Tie visual abilities to concrete context fields (e.g. `screen_image`, `screen_content`) rather than generic “you can see the screen” statements.
  - Include a negative rule: when no such field is present, the model must treat the situation as **no vision available** and avoid “the image you provided…” style hallucinations.

### 2026-03-18 — Aha: teaching validation clarifying_questions schema

- **Symptom**: Teaching validation crashed with `ValidationError` on `ValidationResult.clarifying_questions.0` because the LLM sometimes returned a list of **dicts** (e.g. `{ "why": "..." }`) instead of plain strings.
- **Root cause**: `TeachingService.validate` forwarded `parsed["clarifying_questions"]` directly into the Pydantic model, which expects `list[str]`, so nested dicts failed validation.
- **Fix**: Normalize both `clarifying_questions` and `contradictions` before constructing `ValidationResult` by:
  - Ensuring they are lists.
  - Converting each element to `str`, and when an element is a `dict`, flattening by joining all values into a single human-readable string.
- **Contract**: Any future LLM-parsed list fields that are typed as `list[str]` in Pydantic must defensively coerce **both the container and the elements** (including dicts) to strings before model construction.

### 2026-03-18 — Voice agent connection: proxy + transcription stability

- **Symptom**: "Couldn't connect to the voice agent" — UI at localhost:3000 calls voice-agent at localhost:8090; CORS/port/network issues could block direct access.
- **Fix**: Added API gateway proxy at `/api/v1/voice-proxy` (join, token, voice-id/*, health). UI now uses `OASIS_BASE_URL + '/api/v1/voice-proxy'` instead of direct port 8090. Same-origin requests avoid CORS; gateway reaches voice-agent via Docker service name.
- **Transcription**: `make restart-voice` no longer kills transcription (port 8099). Killing it was unnecessary and caused a window where voice-agent couldn't transcribe. Voice-agent has `extra_hosts: host.docker.internal:host-gateway` for Linux compatibility reaching host transcription.
- **Contract**: Voice agent HTTP endpoints are proxied through the API gateway. UI should use the proxy URL, not direct port 8090.

### 2026-03-18 — Log fixes: JSON parsing, LiveKit, ddgs, transcription, tool iterations

- **LLM JSON parsing**: Interpreter, teaching, and response-generator often received malformed/truncated JSON from Ollama. **Fix**: Enhanced `packages/shared_utils/json_utils.py` `extract_json()` to repair truncated JSON (close unclosed brackets, strip trailing commas). All `chat_json` callers benefit.
- **LiveKit secret**: LiveKit requires secret ≥32 chars. **Fix**: Updated `config/livekit/livekit.yaml` and docker-compose to use `oasis-livekit-dev-secret-min-32-chars`.
- **LiveKit "invalid token" / "cryptographic primitive"**: Token validation fails when (a) API key/secret mismatch between voice-agent and LiveKit server, or (b) clock skew between token-generating server and LiveKit. **Fix**: Added `LIVEKIT_KEYS` env to LiveKit container so both use identical credentials. If still failing, ensure host clock is synced (`ntpdate` or `timedatectl`).
- **duckduckgo_search deprecation**: Package renamed to `ddgs`. **Fix**: Switched `services/teaching-service/web_search.py` and `services/teaching_service/web_search.py` to `from ddgs import DDGS`; updated requirements to `ddgs>=9.0.0`.
- **Voice transcription**: MLX transcription failures ("Network unreachable", "Remote end closed"). **Fix**: Voice-agent now uses httpx for transcription calls, 3 retries with 2s/4s backoff, clearer error message suggesting `make transcription-ensure`.
- **Tool iterations**: Default 6 was too low for complex tool-use flows. **Fix**: `MAX_TOOL_ITERATIONS` now configurable via env (default 10).

### 2026-03-18 — Multi-agent tool_use architecture

- **Change**: Converted single-agent tool_use flow into a multi-agent system with Planning Agent, Execution Agent, and Observer Agent.
- **Agent roles**:
  - **Planning Agent** (Brain): Creates upfront plan via `POST /internal/plan/tool-use` (response-generator). Uses Oasis Cognition persona. Returns `{ steps, success_criteria }`.
  - **Execution Agent**: Runs tools via `tool-plan` LLM. Receives plan + observer feedback. Does NOT decide final_answer alone.
  - **Observer Agent** (Brain): Holds task graph, validates goal completion via `POST /internal/observer/validate` (observer-service). Uses logic-engine `validate_goal`. Returns `{ goal_met, feedback, updated_graph }`.
- **Flow**: Plan → Execute → Observer validate → if not goal_met, inject feedback and continue (Observer decides, not LLM).
- **New services**: `observer-service` (port 8009), calls graph-builder + logic-engine.
- **New schema**: `GoalNode`, `PlanNode`, `ActionNode`, `CompletionNode`; `ToolUsePlan`, `GoalValidationResult`; edge types `IMPLEMENTS`, `EXECUTES`, `COMPLETES`.
- **Contract**: Tool-plan prompt now accepts `upfront_plan` and `observer_feedback`. Observer is the arbiter of goal completion.

### 2026-03-18 — Plan card & Reply-to-message UI

- **Plan card**: Gateway publishes `ToolPlanReady` event with `steps` and `success_criteria` after Planning Agent creates upfront plan. UI shows `PlanCard` during processing (next to tool cards) and in ThinkingCard/timeline overlay so user can preview why tools are being executed.
- **Reply to specific response**: User can click "Reply" on any assistant message to give feedback. When replying, the next message is sent as `[Feedback on your previous response] "..." User feedback: {text}` so the agent receives guidance on how to correct its approach.

### 2026-03-18 — Tool-plan: explore first, never ask for clarification without searching

- **Symptom**: Agent asked "Can you please provide more details or clarify what you're looking for?" for "syntax highlighting in the code view" instead of proactively searching.
- **Fix**: Strengthened tool-plan prompt: (1) "Explore first, ask later" — when vague, grep/list_dir/read_file first; (2) If must ask, ask SPECIFIC question based on what was found, not generic "provide more details"; (3) First action for implementation requests must be a tool call, never final_answer asking for clarification.

### 2026-03-18 — Interpreter: code-editing requests must route to tool_use

- **Symptom**: User asks "enable syntax highlighting in the code view" → shows "Deep Reasoning", agent says "I'll work on it" but no tools run, then silence.
- **Root cause**: Interpreter routed to "complex" instead of "tool_use". Complex route does symbolic reasoning only — no bash, read_file, edit_file. Tool use never happens.
- **Fix**: Strengthened Interpreter prompt: added "enable", "implement", "add X to the UI" as tool_use signals; added rule "NEVER use complex for adding features, enabling something, fixing code"; added "If the user wants to add/enable/implement/change something in the codebase → ALWAYS use tool_use".

### 2026-03-18 — Tool failure: retry with different approach

- **Problem**: When a tool failed, the Execution Agent would accept the failure and sometimes give up or give final_answer.
- **Fix**: Tool-plan prompt now instructs: when a tool FAILED, retry with a different approach (different command, path, read file again for edit_file, list_dir to find path, etc.). When the last result was a failure, an explicit hint is injected: "You MUST retry with a different approach. Do NOT give final_answer yet."

### 2026-03-18 — Voice auto-connect on chat page load

- **Change**: Voice connection now auto-connects when the chat page opens. If the browser blocks (e.g. Chrome autoplay policy), the user can click Connect to retry.
- **Implementation**: `useEffect` calls `handleConnect()` once on mount via `hasAutoConnectedRef` guard.

### 2026-03-18 — App.tsx split into individual components

- **Change**: Refactored monolithic ~3000-line `App.tsx` into modular components for maintainability.
- **Structure**:
  - `lib/types.ts` — Message, TimelineEvent, ProjectConfig, GraphData, GraphPanelProps
  - `lib/constants.ts` — OASIS_BASE_URL, VOICE_AGENT_URL, pipeline stages
  - `components/voice/` — WaveformVisualizer, ListeningOrb, VoiceIdModal
  - `components/chat/` — CodeBlock, MarkdownMessage, DiffViewer, InlineToolCards, ChatHeader, TimelineOverlay
  - `components/timeline/` — PipelineProgress, ToolCallsDisplay, PlanCard, ThinkingCard
  - `components/graph/` — GraphPanel, KnowledgeGraphViz, LogicEngineViz
  - `components/panels/` — SettingsPanel, HistoryPanel
- **App.tsx** now ~1000 lines: state, effects, handlers, and composition of extracted components.

### 2026-03-18 — Reasoning panel: Knowledge graph & Logic engine separated

- **Change**: Split the combined "Knowledge graph & logic engine" panel into two distinct tabs, each with its own best-of-kind visualization.
- **Knowledge graph tab**: Hierarchical node-link graph (top-down layers: Problem/Goal → Evidence/Trigger/Constraint → Hypotheses/Plan → Action → Conclusion/Completion). Nodes colored by type; curved edges with edge-type labels (TRIGGERS, SUPPORTS, LEADS_TO, etc.).
- **Logic engine tab**: Decision (conclusion + confidence bar), reasoning trace (step-by-step inference flow), and learned rules (IF/THEN cards).
- **Data**: API now returns `conclusion` in complex-route response; UI stores `reasoning_trace`, `confidence`, `conclusion` per message for Logic Engine viz.

### 2026-03-18 — Architecture: LLM = mouth, Logic engine = brain, Knowledge graph = memory

- **Contract**: All routes must use the triad: **Logic Engine** (brain), **Knowledge Graph / Memory** (memory), **LLM** (mouth).
- **Complex route**: Already correct — graph-builder → memory query + rules → logic-engine reason → response-generator formats. LLM only formats the decision.
- **Tool use route**: Now wired:
  - Fetches memory + rules at start; passes to Planning Agent, tool-plan LLM, and Observer.
  - Observer passes memory + rules to logic-engine `validate_goal`; logic engine uses them for grounded validation (confidence boost when memory/rules match tool outputs).
  - Task graph stored in memory when goal met.
- **Casual route**: Now wired — fetches memory + rules; injects into casual prompt so responses are grounded in past context.
- **Logic engine**: `reason` (complex) and `validate_goal` (tool_use Observer) both accept `memory_context` and `rules`; they are connected to the same memory layer.

### 2026-03-18 — Knowledge graph expiration: verify ground truth when stale

- **Problem**: Memory entries can expire (code changes, files move, tool outputs become outdated). Relying on old knowledge without verification causes hallucinations.
- **Fix**: Memory query returns `stale_count` and `stale_hint` when entries exceed `OASIS_MEMORY_MAX_AGE_HOURS` (default 24).
- **Flow**: When stale, `memory_stale_hint` is passed to: (1) Logic engine — reduces memory weight in scoring, skips confidence boost in validate_goal; (2) Response generator — injects "verify against ground truth (re-read files, re-run commands) before relying; renew knowledge by re-executing tools"; (3) Tool-plan — instructs to verify first, then proceed.
- **Config**: `OASIS_MEMORY_MAX_AGE_HOURS` (default 24). Set lower for fast-moving codebases.

### 2026-03-18 — Knowledge graph: wall-hitting and aha moments

- **Problem**: Agent repeats the same failed attempts (e.g. read_file on path that doesn't exist, grep that found nothing) instead of trying different approaches.
- **Fix**: Extract "walls" from failed tool results (path doesn't exist, grep found nothing, edit_file old_string not found) and:
  - Accumulate in session; pass `walls_hit` to tool-plan each iteration.
  - Inject prominently: "FAILED ATTEMPTS / WALLS HIT (do NOT retry these; try different paths, patterns, or approaches)".
  - Store walls in memory when storing task graph (tags + content.walls) so future sessions avoid same mistakes.
- **Memory**: Walls from past sessions (memory_context entries with content.walls) are merged with current session walls and injected into tool-plan.

### 2026-03-18 — Plan step highlighting & tool calls scroll container

- **Problem**: AI response bubbles pushed out of viewport due to many tool calls and long plan cards.
- **PlanCard**: Steps now have checkboxes (✓ when done, □ when pending). Current step is highlighted (blue bg) when activity relates to it. Step is "done" when we have more successful tool completions than step index (heuristic: tools progress through plan steps in order).
- **ToolCallsScrollContainer**: Tool calls wrapped in scrollable container (max-height 280px). Auto-scrolls to bottom when streaming; pauses if user scrolls up; resumes when user scrolls back to bottom; stops when response complete (`isStreaming=false`).

### 2026-03-18 — App.tsx refactor: under 700 lines

- **Extracted**: `useVoiceConnection` hook (LiveKit room, mic, screen share, data handlers), `ChatMessage` (single message with tools/diff/markdown), `ChatInputArea` (textarea + reply bar), `ThinkingOverlay` (plan + tools during thinking), `VoiceBubbles` (transcription + live transcript). `getErrorMessage` moved to `lib/utils.ts`.
- **Result**: App.tsx reduced from ~1009 to ~389 lines.

### 2026-03-18 — Plan step highlighting + knowledge graph live update

- **Plan step highlighting**: API gateway now publishes `step_index` in ToolCallStarted, ToolCallCompleted, ToolCallBlocked. PlanCard uses it: when a tool is running, highlights the step from the last ToolCallStarted; when between tools, highlights the next step (last completion step_index + 1). Falls back to heuristic (successfulCount) when step_index is absent.
- **Knowledge graph on the fly**: After each observer validation (post-tool), when we have walls, call memory/store with task_graph + walls. This persists walls to the knowledge graph during execution so future steps/sessions can avoid them. The tool-plan already receives walls_hit each iteration; the interim store ensures the graph is updated live.

### 2026-03-18 — Knowledge graph, observer, reply UX, context summary (plan implementation)

- **Storage & linking**: (1) Always store task graph after every observer validation (removed wallsHit-only condition). (2) Memory store accepts `session_id`; stored in content and tags. (3) Memory query accepts `session_id` for thread-based retrieval. (4) Gateway passes `session_id` to all store calls and initial memory query.
- **Live updates**: (1) After each store, re-fetch memory with `session_id` so next tool-plan sees latest graph. (2) Tool-plan receives `task_graph`; prompt injects "Current task graph: N nodes. Last actions: ...". (3) Publish `TaskGraphUpdated` event after each store; UI subscribes and updates `graphBySessionId`.
- **Observer**: (1) On observer validate failure, inject fallback feedback instead of null: "Observer unavailable. If you have exhausted options, explain to the user and give final_answer." (2) Logic-engine: when 5+ consecutive read_file/list_dir failures for same path (path does not exist), return goal_met with feedback "User should be informed the path does not exist: {path}".
- **Reply UI**: (1) Message type has `replyToMessageId`, `replyToPreview`. (2) ChatMessage shows compact "Replying to" card above bubble (icon, truncated preview ~60 chars, "Reply" badge); user feedback in bubble. (3) API: `context.reply_to` = { message_id, preview }; gateway builds formatted prompt when present.
- **Graph by thread**: UI switched from `graphsByMessageId` to `graphsBySessionId`; GraphPanel shows graph for current session; TaskGraphUpdated updates live.
- **Context summarization**: (1) `estimateTokens(text)` ~4 chars/token. (2) `OASIS_CONTEXT_WINDOW` (default 8192). (3) Before building chat_history, if tokens > 50% of window: call `POST /internal/response/summarize-history` with older messages; replace with "Conversation summary: ..." + keep last 5 messages.

### 2026-03-18 — Tool-plan robustness, walls prominence, path-failure heuristic

- **Tool-plan JSON robustness**: (1) `extract_json` now handles nested braces, ast.literal_eval for Python dicts. (2) `_normalize_tool_plan_output` maps common LLM mistakes: `tool_id`→`tool`, `output`→`answer`, builds valid call_tool from malformed structure. (3) Few-shot example and stricter "ONLY JSON" instruction in prompt. (4) Retry hint is more explicit.
- **Walls prominence**: Walls moved to TOP of tool-plan prompt with ⚠️. Explicit rule: "Before any read_file/list_dir/grep, check the path is NOT in the list." Note that /workspace/X and /X are equivalent.
- **Path-failure heuristic**: Logic-engine normalizes paths (strip /workspace), extracts path from output when attr empty, logs when heuristic triggers. Handles both path formats for counting failures.

### 2026-03-18 — Grep semantic search (pattern expansion + ripgrep)

- **Problem**: LLM searches like `grep pattern=CodeView path=...` often miss matches when code uses `code-view`, `code_view`, or `CodeView` in different files.
- **Fix**: (1) **Pattern expansion**: `_expand_pattern_semantic()` turns identifiers into regex alternation: `CodeView` → `(CodeView|codeview|code_view|code-view)`. Multi-word: `syntax highlighting` → `(SyntaxHighlighting|syntax_highlighting|syntax-highlighting|...)`. Skips expansion when pattern looks like regex (`\s`, `\d`, `+`, `*`, etc.). (2) **Ripgrep**: Prefer `rg` over `grep` (faster, better Unicode); fall back to `grep` if `rg` unavailable. (3) **Exclude dirs**: Skip `node_modules`, `.git`, `__pycache__`, `.next`, `dist`, `build`, `.venv`, `venv` to reduce noise. (4) **Case-insensitive fallback**: If expanded pattern finds nothing, retry with `-i`.
- **Contract**: Tool-executor Dockerfile installs `ripgrep`. Grep tool is now more robust for codebase search without embedding/semantic infra.

### 2026-03-18 — Autonomous mode, Logic Engine fixes, Knowledge Graph UX

- **Logic Engine decisions empty**: TaskGraphUpdated was overwriting conclusion/reasoning_trace/confidence with undefined. **Fix**: Merge with existing session data; preserve payload fields when provided. API Gateway now includes observer conclusion/confidence/reasoning_trace in TaskGraphUpdated and tool_use response. LogicEngineViz derives conclusion from CompletionNode when absent.
- **Knowledge Graph bigger view**: Added expand button (Maximize2) on Knowledge Graph tab; modal renders at 800x550. KnowledgeGraphViz accepts containerWidth/containerHeight for responsive layout.
- **Logic Engine feasibility**: New `POST /internal/assess-feasibility` checks memory (not_achievable entries) and walls (5+ path failures). Memory `store-not-achievable` endpoint stores goal, reason, suggestion. Feasibility pre-check runs before tool loop (skipped in autonomous mode).
- **Autonomous mode**: Session config (autonomous_mode, autonomous_max_duration_hours) via `POST /api/v1/session/config`. When enabled: unlimited tool iterations (10k cap), 6hr default time limit, snapshot every 5 iterations, knowledge graph summary injected into tool-plan, feasibility pre-check skipped.
- **Snapshots**: Dev-agent `create_snapshot`/`restore_snapshot`/`list_snapshots` capture worktree diffs to `~/.oasis/snapshots/{session_id}/`. API gateway proxies to dev-agent. SnapshotCreated event published for timeline.
- **UI**: Settings panel "Autonomous" tab: toggle, max hours input, snapshot list with Restore. SnapshotCreated in TOOL_PIPELINE_STAGES.

### 2026-03-19 — Self-teaching pipeline: rules creation, teaching triggers, failure learning

- **Problem**: Agent in autonomous mode never created rules despite having teach_rule capability. It would grep for non-existent files endlessly, give up, or tell the user to do it.
- **Root causes identified**:
  1. TOOL_PLAN_PROMPT had no teach_rule/update_rule/delete_rule tools defined — agent couldn't create rules.
  2. A bad example in the prompt referenced `CodeView.tsx` (non-existent) — agent followed it literally.
  3. Tool-executor blocked `npm install` and `pip install` — agent couldn't install packages and gave up.
  4. PLAN_TOOL_USE_PROMPT generated vague plans with no per-step verification criteria.
  5. No mechanism to force teaching when the agent hit repeated failures.

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

### 2026-03-20 — “Stopped after plan” / RulesSnapshot: abort false positives

- **Symptom**: Pipeline died at the **first tool-loop iteration** right after **ToolPlanReady** or **RulesSnapshotCreated** while the user did not stop.
- **Causes tried**:
  1. `req.on('close')` — fires when the **request body stream** finishes after a full read, not TCP teardown.
  2. `res.on('close')` / `socket.on('close')` during **chunked NDJSON** — can still fire on some Node/Docker stacks without a real client disconnect.
- **Fix (default)**: `isAborted()` = **`req.socket != null && req.socket.destroyed`** only (real connection teardown when the user aborts fetch / closes tab). Optional **`OASIS_STRICT_STREAM_CLOSE_ABORT=1`** restores stream-close + `req.destroyed` for stricter (but riskier) detection.

### 2026-03-20 — Long POST keepalive (NDJSON stream)

- **Problem**: Single JSON response meant **no bytes on the wire** during long LLM/tool gaps → proxies or stacks closed the TCP leg; gateway logged “connection closed before response”.
- **Fix**: `POST /api/v1/interaction` returns **`Content-Type: application/x-ndjson`**: immediate line + `OASIS_INTERACTION_KEEPALIVE_MS` (default 12s) lines `{"_oasis_keepalive":true}`, then final line is the usual `InteractionResponse` JSON. Errors: `{"_oasis_error":true,"status", "body"}`.
- **Clients updated**: `oasis-ui-react` (`postInteractionNdjson`), `openai-adapter`, `voice_agent`, `web-client` + `voice_agent/client` HTML, `scripts/test-interaction.sh`. Abort detection (default): `socket.destroyed` only; see **“Stopped after plan”** note for `OASIS_STRICT_STREAM_CLOSE_ABORT`.

### 2026-03-20 — False "Client aborted" on long tool_use POSTs

- **Symptom**: Pipeline logs `Client aborted request` / `Pipeline stopped by client` even though the user did not click Stop.
- **Causes**: (1) **Bug**: `isAborted` treated `!req.socket` as abort — can false-positive; removed. (2) **Real closes**: `req.socket.destroyed` after **proxy/load balancer idle timeout** while the server is busy between tool iterations (no bytes on the client↔proxy TCP leg during long LLM gaps).
- **Fix**: `interaction.controller.ts` — subscribe to `req.on('close')` only when `!res.headersSent`, and abort only on that + `req.destroyed` + `socket.destroyed` when `socket` is present. Clearer WARN in `interaction.service.ts` listing causes.
- **If idle timeout persists**: Raise proxy `read_timeout` / `send_timeout` (or equivalent), or move long runs to chunked/streaming responses / SSE so the connection isn’t silent for minutes.

### 2026-03-20 — Compass: self-teaching for better tool use (beyond prompt text)

- **Reality check**: In-loop “the model teaches itself” only sticks if **something durable** changes: injected context (rules, playbooks, walls), structured tool feedback, or offline weight updates (SFT/LoRA). Prompts alone plateau.
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

- **Change**: `apps/oasis-ui-react/src/index.css` — `overscroll-behavior-x: none` on `html` and `body` so macOS trackpad (and similar) horizontal overscroll doesn’t trigger history navigation.

### 2026-03-20 — Tool_use loop: fix validate-goal crash + narrow plan context

- **Problem**: Tool_use “overthinking loop” for simple tasks.
- **Root cause #1**: `services/logic_engine/service.py` `validate_goal()` referenced an undefined `user_goal` variable, causing logic-engine `/internal/validate-goal` to 500; observer defaulted to `goal_met=false`, so the loop never stopped.
- **Root cause #2**: Tool-plan prompt/context was too broad, so the planner often retried parsing invalid tool-plan JSON and kept exploring.
- **Fix**:
  - `services/logic_engine/service.py`: implement detection now derives from `goal_title + success_criteria` (no undefined variables).
  - `services/response_generator/service.py`: tool-plan output format allows ```json``` code fences; also the prompt shows only the *current* plan step.
  - `apps/api-gateway/src/interaction/interaction.service.ts`: tool-plan calls now send `active_step_index/description`, filter memory/rules by overlap with that step, and send only the last 5 tool results.

### 2026-03-20 — Current struggles: tool-plan JSON + tool-use stalls

- **Symptoms seen in logs**:
  - `response-generator` tool planning retries with `Tool plan attempt ... failed (bad JSON)` and messages like `Could not extract valid JSON from text: plaintext` or the model producing non-tool-plan text (e.g. “request incomplete...” / apology text).
  - Sometimes the parsed object is missing required fields (observed: `Invalid action: None`), which forces retries and can make the overall interaction feel stuck/slow.
  - End-to-end smoke tests for tool_use can take a long time when the model keeps emitting non-JSON/tool-incompatible outputs.
- **Root causes (suspected / observed)**:
  - The tool-plan model is not consistently producing a JSON object that our extractor can parse, even with prompt constraints.
  - JSON extraction needs to be tolerant of common “near JSON” mistakes (code fences, trailing commas, unquoted keys/values, etc.).
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

- **Symptom**: On tool_use, the chat overlay showed `ToolPlanReady` first, while the “Agent Thoughts” card rendered the full content only after completion (no incremental streaming).
- **Root cause**: `ThinkingOverlay` decided whether to render `ActivityStream` based only on `ThoughtsValidated`; it ignored `ThoughtChunkGenerated` / `ThoughtLayerGenerated`, so the streaming thought UI was gated until a later event.
- **Fix**: `ThinkingOverlay` now treats `ThoughtChunkGenerated` / `ThoughtLayerGenerated` as “thought present” so the overlay renders early and streams incrementally.

- **Symptom**: `PlanCard` highlighting/progress appeared stuck across iterations.
- **Root cause**: `interaction.service.ts` published `step_index` with an off-by-one error (`Math.min(iteration, planSteps) - 1`), so UI step highlighting didn’t advance correctly.
- **Fix**: `step_index` is now `max(0, min(iteration, planSteps - 1))`, and `PlanCard` uses the latest `ToolPlanReady` event.

### 2026-03-20 — Self Teaching: UI + 2-agent flow

- Implemented a dedicated “Self Teaching” sidebar panel (`apps/oasis-ui-react/src/components/self-teaching/SelfTeachingPanel.tsx`) that runs:
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

- Added “almost agree” adjustment loop:
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

- **Symptom**: Multi-turn chats didn’t get `chat_history` on response-generator (tool-plan, chat, etc.).
- **Root cause**: `RedisEventService.pushMessage` / `getRecentMessages` returned immediately when `this.connected` was false. `connected` flips true only in the `.then()` of `redis.connect()`, so the first requests (and any request before connect finished) **skipped** storing the user message and **returned []** for history.
- **Fix**: `ensureRedisReady()` awaits `redis.connect()` before chat list ops (and reuse for `publish` / `getBacklog`). `InteractionService` logs prior-turn count when non-zero.

### 2026-03-21 — Logic rules panel: 0 rules + fixes

- **Symptom**: Reasoning → Logic engine showed `Rules graph (0 rules, 0 connections)` even when Neo4j had rules.
- **Causes**:
  - **`onRefreshRules` was never passed** from `App.tsx` into `GraphPanel`, so switching to the Logic tab did not refetch.
  - **Silent axios failures** in a single `try/catch` cleared both list and graph; graph used `.catch(() => null)` so failures were invisible.
  - **Memory-service on Neo4j fallback** at startup: rules live in Neo4j but API reads empty in-process `_fallback_rules` — looks like “no rules”.
  - **Neo4j `Rule` nodes**: `dict(record["r"])` can yield non–JSON-safe values; list endpoint may error or return unusable payloads — now normalized via `_rule_node_to_dict`.
- **Fixes**:
  - `services/memory_service/service.py`: `_rule_node_to_dict` + `storage_backend`; `GET /internal/memory/rules` returns `"storage": "neo4j"|"fallback"`.
  - `App.tsx`: separate fetch/parse for rules vs graph; normalize rule rows; toasts on error; `onRefreshRules={loadGraphPanelData}`; `rulesStorageBackend` → banner in `LogicEngineViz` when `fallback`.
  - `LogicEngineViz`: merge **rules list + graph nodes** (dedupe by `rule_id`).

### 2026-03-21 — UI: streaming reply overwrote user bubble

- **Symptom**: While the assistant streamed, the **user’s** message text was replaced by the assistant output.
- **Cause**: `ResponseChunkGenerated` keyed updates by `client_message_id`, which is the **same** as the user row’s `id`. `prev.map(m => m.id === clientId ? { ...m, text: fullText } : m)` updated the user message. User and assistant rows also reused that id.
- **Fix** (`apps/oasis-ui-react`): assistant rows use `assistantMessageId(clientId)` = `` `${clientId}-assistant` ``; streaming and final `upsertAssistantMessage` only touch that id. Timeline/SSE stay keyed by raw `client_message_id` via `timelineClientKeyForMessage()`. Voice `oasis-response` uses the same upsert.

### 2026-03-20 — Tool-plan: flat line output + `parse-raw` (streaming 2A, contract 1A)

- **1A (contract)**: The execution loop still receives the same normalized plan dict (`action`, `tool`, params, `teach_rule`, etc.); only the **LLM surface format** changed.
- **Flat format**: `TOOL_PLAN_PROMPT` asks for lines like `DECISION:`, `ACTION:`, `PARAM_*:`, `REASONING:` (no JSON). `parse_flat_tool_plan_lines` → `flat_dict_to_plan` → `_normalize_tool_plan_output`.
- **Non-stream**: `plan_tool_calls` builds context via `_build_tool_plan_combined_message`, then `parse_tool_plan_raw` (flat first, then JSON + `repair_json` if the buffer looks like `{...}`).
- **2A (streaming UX)**: `stream_tool_plan` uses the **same** combined message (including `knowledge_summary` on `ToolPlanRequest`). Gateway publishes incremental **ToolReasoningChunk** from the last `REASONING:` line (with legacy fallback to partial `"reasoning"` JSON). On stream end it calls **`POST /internal/response/tool-plan/parse-raw`** first, then falls back to `/internal/json/repair` + `extractAndParseJson`.

### 2026-03-20 — UI “Connecting…” forever (voice / whole gateway wedged)

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

### 2026-03-21 — Redis `ensureRedisReady`: “already connecting/connected”

- **Symptom**: Log spam `Redis ensureRedisReady failed: Error: Redis is already connecting/connected`.
- **Cause**: Constructor calls `redis.connect()` while concurrent requests call `ensureRedisReady()` → second `connect()` throws in ioredis.
- **Fix**: `waitForClientReady()` — if `status === 'ready'` return; else `connect()` and on that error **wait for `ready`** (with timeout). Same pattern for the stream reader duplicate client.

### 2026-03-21 — Thought-only loops: force action after 3

- **Symptom**: Agent sometimes kept generating thoughts but didn’t produce new tool-results for multiple iterations (appearing “thoughts only”).
- **Fix** (`apps/api-gateway/src/interaction/interaction.service.ts`): added a `thoughtsOnlyStreak` counter for consecutive iterations where `toolResults` didn’t grow. When the streak reaches 3, the next iteration injects a `[FORCE ACTION]` directive and also deterministically overrides a `final_answer` plan into a `call_tool` (grep) if the model still tries to finalize.
- **Follow-up fix**: ensured the streak increments even when the model proposes `final_answer` and the Observer rejects it (no tool_results produced in that branch), so the max-3 enforcement actually triggers.

### 2026-03-21 — Tool-plan parse-raw: Docker logs don’t show model output (until preview)

- **Aha**: Grepping `docker logs oasis-cognition-response-generator-1` for `parse-raw rejected` only showed the **error + repair char count** — the streamed tool-plan body was **never logged**, so you couldn’t see what the model actually returned for a given 422.
- **Fix**: `services/response_generator/main.py` `tool_plan_parse_raw` now logs `raw_len` and a **single-line `preview`** (~400 chars, whitespace-collapsed) on `ValueError` so `docker logs … | grep preview` surfaces the shape of bad output. **Not** a redaction layer — don’t log if prompts could contain secrets.

### 2026-03-21 — `npm install` failures (Node engines / multi-app)

- **Symptom**: `npm install` fails or warns `EBADENGINE` (e.g. `eslint-visitor-keys` wants `node: ^20.19.0` while the machine has `20.14.x`). Some setups use `engine-strict=true` (global or env), turning that into a **hard error**.
- **Mitigations**: `apps/oasis-ui-react/.npmrc` and `apps/api-gateway/.npmrc` set **`engine-strict=false`** (prefer upgrading Node to **≥20.19** when you can). **`scripts/npm-install-all.sh`** runs both installs. Dockerfiles **`COPY .npmrc`** before `npm install`. `package.json` **`engines`** documents minimum Node/npm.

### 2026-03-21 — `bash` / `npm install` on host via dev-agent

- **Aha**: `bash` is in **`DEV_AGENT_TOOLS`**, so the gateway posts to **`DEV_AGENT_URL/internal/dev-agent/execute`**, but the dev-agent only handled worktree/file tools — **`command` was never sent** in the dev-agent branch (only tool-executor got `execPayload.command`) → “Unknown dev-agent tool” or empty command.
- **Fix**: (1) **`services/dev_agent/service.py`** — **`run_bash(command, worktree_id?)`** with cwd = worktree if present else **`PROJECT_ROOT`**, inherits full **`os.environ`** (host Node/npm), timeout **`DEV_AGENT_BASH_TIMEOUT_SECONDS`** (default 600s). (2) **`services/dev_agent/main.py`** — **`ToolRequest.command`** + **`elif req.tool == "bash"`**. (3) **`interaction.service.ts`** — for dev-agent + **`bash`**, set **`execPayload.command`**; use **600s** HTTP timeout for bash (npm install).
- **Contract**: With **`./scripts/start-dev-agent.sh`** and **`DEV_AGENT_URL`** pointing at that process (e.g. gateway in Docker → **`host.docker.internal:8008`**), agent **`call_tool` bash** runs on the **host** repo, not inside tool-executor.

### 2026-03-21 — Invalid DECISION prose (e.g. `PROCEED WITH SEARCHING…`)

- **Symptom**: `[INTERNAL: invalid DECISION 'PROCEED WITH SEARCHING FOR EXISTING IMPLEMENTATIONS.'; expected ACT…]` — model used a sentence on the `DECISION:` line instead of exactly `ACT`, `ANSWER_DIRECTLY`, or `NEED_MORE_INFO`.
- **Fix** (`services/response_generator/service.py`): **`_normalize_flat_decision()`** coerces common patterns (prefix `ACT`, synonyms, and keyword heuristics for proceed/search/find/explore vs ask-user vs done). **TOOL_PLAN_PROMPT** now states DECISION must be **only** one token on the line.

### 2026-03-21 — Prose in `ACTION:` + invisible validation errors in UI

- **Symptom**: Model set `ACTION:` to a full sentence (`Use the \`grep\` tool to search…`); gateway treated the whole string as tool id → `INVALID_TOOL`. User saw few/no tool cards when parse/validation failed because **only `toolResults` were updated** — no `ToolCallStarted` / `ToolCallCompleted`, so ActivityStream (which pairs started+completed by `iteration`) showed nothing.
- **Fix**: (1) **`_extract_tool_name_from_prose`** in `services/response_generator/service.py` + **`extractToolFromProse`** in `interaction.service.ts` — resolve first backtick token or first allowed tool substring (leftmost). (2) Gateway **replaces** `plan.tool` when alias/prose resolves. (3) On true invalid tool or **`validation_error`** (`_retry_hint`), publish **`ToolCallStarted` + `ToolCallCompleted`** so the timeline shows failure output and `RETRY IN NEXT TOOL PLAN` text.

### 2026-03-21 — Tool-plan parse failures: model echoes user context (not JSON)

- **Symptom**: `parse-raw` preview showed prose like “Relevant memory entries… User request… Current plan step… Let's start by…” — **no** `REASONING:` / `DECISION:` lines. That text mirrors **injected** `knowledge_summary` + `_build_tool_plan_combined_message` blocks; the model was **narrating the prompt** instead of the flat plan contract.
- **Mitigations** (`services/response_generator/service.py`): (1) **TOOL_PLAN_PROMPT** — explicit “OUTPUT DISCIPLINE”: first line must be `REASONING:`, never echo user sections. (2) **Footer** on the combined user message — “NOW OUTPUT YOUR TOOL PLAN ONLY”. (3) **`_strip_tool_plan_preamble`** — if the model eventually emits keys after junk, parse from the first `REASONING:`/`DECISION:`/… line. (4) **Always `extract_json(norm)`** after flat parse (embedded `{...}` after prose). (5) Clearer `ValueError` text (flat-first wording). Removed unused `_looks_like_json_object`.

### 2026-03-21 — Persist tool-plan request/output for debugging (Langfuse)

- **Need**: Memory graph doesn’t store raw tool-plan streams; Docker logs alone aren’t enough without preview logging.
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

- **Symptom**: Agent “thought” about editing but next tool stayed exploratory; repeated successful grep/npm; **`npm install` appeared to succeed** but **no changes in the git worktree**.
- **Cause**: **`bash` was routed to the Docker tool-executor**, so installs ran in the **container’s** `/workspace`, not the **host dev-agent git worktree** under `.oasis-worktrees/`. Tool plan text also said npm was “blocked”, so the model’s reasoning and actions diverged. **`worktree_id` was not stored on `tool_results`**, so the planner could not see which worktree was active.
- **Fix**: (1) Route **`bash` through `DEV_AGENT_TOOLS`** (dev-agent host). (2) For **package-install-shaped** commands, **require** a worktree: gateway resolves **`PARAM_WORKTREE_ID`** from the plan or the last successful **`create_worktree`**; otherwise inject a clear failure **before** `ToolCallStarted`. (3) **dev-agent** `run_bash` refuses package installs **without** `worktree_id`. (4) Persist **`worktree_id`** on tool result records when present. (5) **Duplicate detection** normalizes `/workspace/…` paths and **whitespace** in commands; duplicate-after-success copy tells the model not to redo successful work. (6) **Response generator**: “already succeeded” digest, **last tool SUCCESS** footer, stronger **validated thoughts / latest reasoning** copy and **TOOL_PLAN_PROMPT** priority for concrete next-tool commitments.

### 2026-03-21 — Observer-triggered plan revision + UI epoch (`plan_revision`)

- **Need**: When validation shows the agent is on the wrong track (e.g. explore-only on an implementation goal), regenerate the **upfront plan** and treat execution as **restarting at step 1** — agent prompts and the Execution plan card must stay aligned.
- **Logic engine** (`validate_goal`): `GoalValidationResult.revise_plan` is true when `not goal_met` and (advisory `final_answer` rejection, or implementation + only read tools with ≥2 actions, or implementation + no code changes with ≥6 actions).
- **Observer** returns `revise_plan` from the logic-engine JSON.
- **Gateway** (`interaction.service.ts`): `runObserverReplan` calls `POST /internal/plan/tool-use` with `replan_after_observer`, `observer_feedback`, `previous_plan`; bumps `planRevision`, sets `planStartIteration = iteration + 1` so `active_step_index` / `step_index` use `iteration - planStartIteration`; publishes `ToolPlanReady` with `plan_revision`, `plan_revised`, `revision_reason`; rebuilds task graph via graph-builder with `existing_graph`. Tool SSE payloads include `plan_revision`.
- **Response generator**: `PlanToolUseRequest` + `plan_tool_use()` accept revision fields and inject **REVISION MODE** instructions for the planning LLM.
- **UI** (`PlanCard.tsx`): Only counts `ToolCallStarted` / `ToolCallCompleted` events whose `plan_revision` matches the latest `ToolPlanReady` (missing `plan_revision` treated as epoch `0`). Shows a **Revised** badge and short copy when `plan_revised`.

### 2026-03-21 — Plan step checkboxes: “Modify…” marked done after only grep

- **Symptom**: Upfront plan step like “Modify the identified UI component to use the selected library…” showed as satisfied while the trace was only `grep` / `list_dir` — no `edit_file` / `get_diff`.
- **Cause**: Per-step validation used `tool_used = True` when the step had no explicit `tool`, and `verify_matched = 1.0` when `verify` was empty → every step became **done** after any tool call.
- **Fix** (`services/logic_engine/service.py`): **`_infer_plan_step_tool_used`** — if `tool` is missing, infer from step text (implementation vs explore regex + phrases like “selected library”) and require **`create_worktree` / `write_file` / `edit_file` / `get_diff`** vs **read-only** tools accordingly; on implementation tasks, ambiguous steps default to requiring edit tools.

### 2026-03-21 — Observer “silent” on tutorial `final_answer` (implementation asks)

- **Symptom**: User asked to implement (e.g. syntax highlighting); model replied with npm/Prism instructions. **Observer** should set **`goal_met: false`** and strong feedback, but the run looked like validation did nothing.
- **Causes**: (1) **`proposed_final_answer`** was not passed from **api-gateway** → **observer-service** → **logic-engine**, so the advisory-text safety net in **`validate_goal`** never ran. (2) **Post-tool** observer validation (after each iteration) can **exit the loop** when **`goal_met`** is true — so bugs in **`validate_goal`** that mark exploration-only runs as “done” bypass **`final_answer`** validation entirely. (3) **Path-failure shortcut** (5+ missing-path read failures) returned **`goal_met: true`** **before** implementation classification, which could wrongly complete non-read-only goals.
- **Fix**: Wire **`proposed_final_answer`** on **`POST /internal/observer/validate`** and **`/internal/validate-goal`**. **`validate_goal`**: move **implementation detection** above the path shortcut and **skip** that shortcut when **`is_implementation_request`**. Tighten **criteria-list + implementation** branch to require **`get_diff`** as last tool; keep advisory markers (e.g. **`npm install`**, **`you should `**) when the proposed answer is user-facing instructions without repo edits.

### 2026-03-21 — Autonomous toggle: “stops responding” / wrong mode (race + empty UI)

- **Symptom**: After turning **Autonomous** off in Settings, the next reply can look like the app “hung” or the assistant bubble never appears — often because **backend still used the old `autonomous_mode`** until `POST /session/config` finished, or **`setConfig` spread `undefined`** and corrupted stored hours. Empty `response_text` from decision **ANSWER_DIRECTLY** also skipped the assistant row (`if (data?.response)`).
- **Fix**: (1) **`App.tsx` `sendToApi`** — always send **`context.autonomous_mode`** and **`context.autonomous_max_duration_hours`** (from React state + `readAutonomousMaxHours()`) on each interaction so **`SessionConfigService.getConfig(sessionId, req.context)`** matches the UI immediately. (2) **`session.service.ts`** — **`setConfig`** only patches defined fields; **`getConfig`** normalizes hours (never NaN) and applies **only** context keys that are explicitly present (don’t reset hours when only `autonomous_mode` is sent). (3) **UI** — if the pipeline returns success but empty text, show a short placeholder assistant message. (4) **Gateway** — **ANSWER_DIRECTLY** path uses a non-empty fallback if `response/chat` returns blank.

### 2026-03-21 — LLM API (OpenAI-compatible) + `OASIS_VISION_LLM_MODEL`

- **Integration**: There is no separate “llmapi” provider string — use **`OASIS_*_LLM_PROVIDER=openai`** with **`OASIS_OPENAI_BASE_URL=https://api.llmapi.ai/v1`** and **`OASIS_OPENAI_API_KEY`** (same secret as curl `Authorization: Bearer`).
- **Vision**: **`LLMClient.chat_with_images`** supports **`openai`** via multimodal `image_url` content (raw base64 JPEG or `data:…` URLs). **`OASIS_VISION_LLM_MODEL`** is read by **response-generator** (`Settings` on `_response_settings`); if unset, Ollama path keeps **`llava:13b`** fallback, OpenAI-compatible path uses the text **`llm_model`**.
- **Compose**: **`OASIS_VISION_LLM_MODEL`** passed into **response-generator** service.

### 2026-03-29 — File read truncation: `read_metadata` (not guessing from LLM context)

- **Problem**: An agent assumed a source file was truncated mid-string because its own **context** was cut off — not because the repo file was incomplete. Truncation should be decided from **tool/service facts**, not from partial model input.
- **Fix**: **`read_file`** (tool-executor) and **`read_worktree_file`** (dev-agent) success responses now include **`read_metadata`**: `file_size_bytes`, `returned_bytes`, `total_lines`, `truncated_by_line_cap`, `truncated_by_byte_cap`, `source_line_start` / `source_line_end`, `next_chunk_start_line`, `has_more_lines_above` / `has_more_lines_below`. API gateway attaches this to tool results and drives the post-read **\_system** nudge from metadata (with regex fallback for older executors). **`services/interpreter/service.py`** `SYSTEM_PROMPT` in repo is complete — if a Cursor/agent view looks cut off, re-read the file from disk or use offset reads; do not infer file damage from chat truncation.

