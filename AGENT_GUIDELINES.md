## AGENT_GUIDELINES (devlog + conventions)

This file is a running devlog/compass for Oasis Cognition agent work. Keep it updated with "aha" moments, interface contracts, and any conventions that are easy to forget.

### 2026-06-10 — Yggdrasil Agent Pool (combined controller + built-in runner)
- **Yggdrasil** is a 2-in-1 service: an HTTP controller (runner registration, job dispatch) + a built-in local runner. External runners register via `POST /runners/register`; the built-in runner registers itself on startup.
- **Types** shared between `agent-runner` and `oasis-agent` via `packages/oasis-agent-sdk/`.
- **Contracts**:
  - `POST /runners/register` accepts `RunnerInfo` (name, endpoint, capabilities, realmTemplates). Returns `{ ok: true, runner_id }`.
  - `POST /runners/:runnerId/reject` accepts `{ job_id, reason }`.
  - `POST /jobs` creates a job targeting a specific runner or auto-selects from idle pool.
  - `POST /jobs/result` accepts `{ job_id, runner_id, status, result, error? }`.
  - Job dispatch handles 3 realms: `code`, `knowledge`, `computer_use`. Unknown realms go to `code`.
  - Realm templates (`realmTemplates`) are used by the semantic matcher to score runner fitness.
- Code generation: created `apps/agent-runner/` (separate docker image) and added `POST /api/v1/jobs` → `POST /jobs` proxy in `apps/oasis-agent/src/coordinator/yggdrasil-bridge.ts`.
- **Pending**: Fix external runner registering on wrong port (171.225 hitting nginx instead of yggdrasil). Root cause: external config sends `POST /runners/register` to port 3000 (UI) instead of 3100 (yggdrasil). Not a code bug.

### 2026-06-11 — Projects Panel & UI Fixes
- **`SettingsPanel.tsx`**: Contains Code Index config (path, enabled toggle, re-index button). Project-specific config should stay here; global settings live separately.
- **`ProjectsPanel.tsx`**: New dedicated panel for managing projects. Features:
  - Create new project with name + source folder (uses `window.showDirectoryPicker()` for native folder selection)
  - List existing projects
  - Cog icon per project opens its settings in `SettingsPanel`
  - Code Index config integrated inline
  - Active project badge in ChatHeader opens this panel
- **IMPORTANT:** `sessionStorage` (not `localStorage`) is used for `oasis-session-id` so chat session IDs persist per-tab across refreshes.
- **UI fixes applied**:
  - `mention-utils.ts`: Added null/undefined guards in `parseMessageMentions`, `extractMentionedArtifactIds`, `stripMentionMarkup` to fix `TypeError: Cannot read properties of undefined (reading 'length')`
  - Removed errant `setShowProjectsPanel(false)` in sidebar button onClick
  - Fixed `.map()` returning sibling elements without wrapper in ProjectsPanel
  - Lint: added `title="Close panel"` to close buttons lacking discernible text
  - Added TypeScript cast for `window.showDirectoryPicker()` to avoid `Unexpected any` lint error

### 2026-06-13 — Chat Persistence & Live Reasoning Streaming

**Fix: Blocking LLM calls in async endpoints**
- Root cause: Synchronous `client.chat.completions.create()` calls in FastAPI endpoints (`interpreter`, `teaching-service`) block the asyncio event loop, causing the entire container to become unresponsive/unhealthy.
- Fix: `packages/shared_utils/llm_client.py` now exposes async wrappers (`chat_async`, `chat_json_async`) using `asyncio.to_thread()`. Services updated to use these.

**Live Reasoning / Thinking Streaming**
- `llm_client.py` adds `stream_chat_structured()` which yields `{type:"reasoning", text:"..."}` or `{type:"content", text:"..."}` dicts, capturing `delta.reasoning_content` from OpenAI-compatible models.
- `response-generator`: New `POST /internal/response/generate-stream-structured` endpoint returns NDJSON of structured chunks.
- `api-gateway`: `generateStreamingResponseStructured()` parses NDJSON and publishes `ThinkingChunkGenerated` / `ResponseChunkGenerated` as Redis events.
- UI: `ThinkingOverlay` shows live "working..." / "thinking..." with elapsed timer. SSE handlers feed `liveReasoningByClientId` state.
- Pipeline stages in `constants.ts` include `ThinkingChunkGenerated`.

**Session persistence across page refresh**
- Session ID (`oasis-session-id`) persists in `sessionStorage`.
- **New**: Auto-load effect on mount fetches history from `GET /api/v1/history/messages?session_id=X` and restores chat messages.
- **New**: `oasis-last-client-msg` stored in `sessionStorage` so after refresh, the last user/assistant message pair uses SSE-compatible IDs (`clientMessageId` / `assistantMessageId()`). This prevents SSE backlog replay from creating duplicate messages.

### 2026-06-14 — Decision Layer Chat Context & SSE Duplicate Fix

**Fix: Decision layer had no chat_history**
- Root cause: `api-gateway/src/interaction/interaction.service.ts` sent `{ thoughts, user_message, context }` to `/internal/decision` but **not** the chat history. When a user says "do it" after resuming a session, the decision layer only sees "do it" with zero conversation context about what was being discussed (e.g., the Asgard orchestrator idea).
- Fix: Added `chat_history` field to `DecisionRequest` model in `services/response_generator/main.py` and passed `chatHistory` from `handleComplex()` in the request. The `make_decision` method now includes the last 6 history turns in the prompt.

**Fix: Duplicate messages on session resume**
- Root cause: On page refresh, the auto-loader fetches all history messages with fallback `hist-*` IDs. The SSE backlog then replays `ResponseChunkGenerated` events for ALL past turns, but only the *last* pair got SSE-compatible IDs. Earlier turns couldn't be matched by ID, so `upsertAssistantMessage` created new duplicate rows.
- Fix (in `App.tsx`):
  1. Added content-based dedup in the `ResponseChunkGenerated` SSE handler: if the full text already exists in *any* assistant message, skip insertion.
  2. Added `notifiedIdsRef` (`Set<client_message_id>`) to suppress duplicate notification toasts from `ResponseGenerated` backlog replay.

### 2026-06-14 (Evening) — Thinking Streaming Pipeline Fix

**Problem**: When the model started thinking (free thoughts phase), the UI only showed "Working..." instead of live thinking tokens.
- Root cause: `_stream_openai()` in `services/response_generator/service.py` didn't yield `reasoning_content` during the Free Thoughts phase. The outer pipeline state machine sets `thoughts_generated=true` but no actual reasoning tokens reach the UI.
- Fix: The `_stream_openai()` helper method was responsible for yielding streamed tokens from OpenAI-compatible calls. Added logic to detect `delta.reasoning_content` from OpenAI streaming responses and yield it as structured `type: "reasoning"` chunks alongside existing `type: "content"` chunks. This affects ALL pipeline stages that use streaming (not just free thoughts).

**Fix: Stream not being cleaned up on abort (GPU not freed for LM Studio)**
- Problem: When the user clicked "Stop pipeline", the `AsyncClient` context managed by `generateStreamingResponseStructured()` wasn't being closed, meaning LM Studio continued generating tokens (and holding GPU memory) until the stream naturally completed.
- Root cause: The Python `async with` context exited but `httpx.AsyncClient`'s cleanup wasn't properly triggered, leaving the HTTP connection open.
- Fix: The client's event loop shutdown + proper async cleanup ensured the HTTP connection to LM Studio drops immediately on abort.

### 2026-06-14 — GPU Utilization / Stream Cancellation
**Key findings from async abort / GPU profiling:**
1. When the user clicks "Stop pipeline" in the UI, the `AbortController` fires and the backend receives a `ClientRequestAborted` event from Redis
2. The `async with httpx.AsyncClient(...)` context manager exits
3. The in-flight response is dropped, closing the HTTP connection to LM Studio
4. LM Studio sees the broken connection and stops model inference — GPU freed immediately

**Key detail**: `timeout=None` on `AsyncClient` — no wall-clock timeout, just cancellation-based or idle-based termination. The api-gateway's 60s idle timer handles the case where the stream goes silent.

### 2026-06-15 — OS Notifications & Notification Dropdown

**Notification feature overhaul:**
- The bell icon in `ChatHeader.tsx` was decorative — clicking it dismissed all notifications at once.
- **Fix** (`ChatHeader.tsx`):
  - Replaced the simple bell button with a `NotificationDropdown` component that opens a popover on click
  - Each notification shows individually with a hover-reveal "X" dismiss button
  - Header has "Dismiss all" link in the panel header
  - Click-outside closes the dropdown
- **Fix** (`App.tsx`):
  - `notifyAgentEvent` now fires OS-level notifications on every event:
    - **Electron desktop**: Uses `window.oasis.notify()` (IPC to Electron `Notification` API)
    - **Browser**: Uses the Web `Notification` API with the site's favicon
  - Auto-requests `Notification` permission 2s after mount (silent if already granted/denied)
  - Also cleaned up: removed `ensureNotifPermission` (was never called) since the auto-request covers it
