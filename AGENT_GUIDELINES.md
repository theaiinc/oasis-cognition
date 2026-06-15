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
