# Parallel Subagent Coordinator

> Design doc for the parallel subagent coordinator feature. See [GitHub issue](#) (TBD).
> Tracking config: admission + cost preflight + user approval gate + dispatch.

## Goal

Enable **one user task** to be decomposed into **parallel subtasks**, each run by an independent agent worker, while the parent chat session continues non-blocking work and aggregates reports as children complete. Safe operation requires **host capacity estimation**, **multi-ledger cost estimation**, and a **user approval gate** before execution when spend is non-zero or auto-approve is disabled.

## Division of labour

| Layer | Owns | Component |
|-------|------|-----------|
| **Cognition** | Plan decomposition, parallel-group detection, report merging | `Planner` (response-generator) + `CoordinatorService` (gateway) |
| **Economics** | Free vs paid model classification, job/session USD caps, billing class | `pricing.ts` + `JobUsageService` + `JobBudgetService` |
| **Capacity** | How many concurrent agents can run on the host, queue vs reject, CPU/RAM/disk/GPU limits | `HostCapacityService` (dev-agent probe) + Yggdrasil `AgentManager` / `OrchestrationConfig` |
| **Execution** | Spawn agent subprocesses with worktrees, route via load balancer | `ExternalAgentsService` (v1) → future Docker pool (v2) |
| **Approval** | Surfaces preflight card, user edits proposed budget, approve/reject/sequential | `JobApprovalCard` (UI) + REST API |

## Architecture

```mermaid
flowchart TB
  subgraph oasis [Oasis api-gateway]
    Chat[InteractionService]
    Planner[Planner - parallel_groups]
    Preflight[CoordinatorPreflightService]
    Coord[CoordinatorService]
    JobUsage[JobUsageService]
    HostCap[HostCapacityService]
    Approval[Approval gate]
  end
  subgraph ygg [Yggdrasil library (in-process)]
    AM[AgentManager]
    LB[LoadBalancer]
    Admit[Admission state]
  end
  subgraph host [Host]
    Probe[dev-agent host-capacity API]
    ExtCLI[Subprocess workers]
  end
  Chat --> Planner
  Planner --> Preflight
  Preflight --> HostCap
  HostCap --> Probe
  Preflight --> Admit
  Preflight --> JobUsage
  Preflight --> Approval
  Approval -->|approved| Coord
  Coord --> AM
  Coord --> LB
  LB --> ExtCLI
  ExtCLI -->|SubagentReport| Coord
  Coord -->|"SSE / RedisEvent"| Chat
```

## Data model (Redis keys)

New redis key family `oasis:job:*`:

| Key | Type | Payload |
|-----|------|---------|
| `oasis:job:{id}` | Hash | `CoordinatorJob` — parent `session_id`, `interaction_id`, plan, `parallel_groups`, status, timestamps |
| `oasis:job_budget:{id}` | Hash | `JobBudget` — `max_usd`, `max_tokens`, `auto_approved`, `user_adjusted_limit`, `safety_factor` |
| `oasis:job_usage:{id}` | Hash | Rollup of child `cost_usd` + tokens |
| `oasis:job_child:{id}` | Hash | Map `taskId -> childSessionId | yggdrasilAgentId` |

Job statuses: `draft` → `preflight` → `awaiting_approval` → `running` → `completed` | `failed` | `cancelled`.

The `ExternalAgentSession` type gets two optional fields: `parent_job_id` and `task_id` for rollup.

## Admission formula

The `parallel_allowed` cap is computed as a min over independent resource constraints:

```
parallel_allowed = min(
    plan.parallel_count,               // what the planner thinks is possible
    ygg.maxConcurrency - ygg.load,     // Yggdrasil available slots
    floor(ram_free_mb / ram_per_child_mb), // host RAM
    floor(disk_free_gb / disk_per_child_gb), // worktree disk
    gpu_slots_remaining,               // GPU-configured max (typically 1 on consumer)
    floor(budget_remaining_usd / est_usd_per_child)  // remaining job budget
)
```

When `plan.parallel_count > parallel_allowed`, the job executes in **`degraded_mode: sequential`** or with fewer workers, and the preflight card explains why.

Each resource factor is independently configurable via defaults:

| Env | Default | Purpose |
|-----|---------|---------|
| `RAM_PER_CHILD_MB` | 1024 | Estimated RAM per child agent process (excludes model VRAM) |
| `DISK_PER_CHILD_GB` | 1 | Estimated worktree disk (repo clone + artifacts) |
| `GPU_SLOTS` | 1 | Max concurrent GPU-bound children (local inference) |

## Billing classes

Each agent profile has an optional `billing_class` field. Defaults are inferred:

| Class | Type | Examples | Pricing |
|-------|------|----------|---------|
| `free_local` | Local inference | Ollama qwen3, llama3, gemma4 | $0.00 (pricing.ts) |
| `paid_api` | Provider token API | Claude Sonnet, GPT-4o, etc. | Static pricing table |
| `subscription_external` | External CLI subscription | Claude Code, Cursor CLI | Cost from transcript |
| `uncertain` | Unknown or mixed | Fallback | "$?" — treated as paid until proven |

### T-shirt sizing estimates

For each `agent_profile` + `goal`, the preflight service computes:

- **Token range** (`low_token_count`, `high_token_count`) per task based on goal length, agent type
- **USD estimate** via `pricingFor(model)` for API models or `cost_usd` history for external CLIs
- **Safety factor**: `est_usd = sum(high_per_child) * 1.2`

## Approval policy matrix

| `billing_class` | `auto_approve_free_jobs` | `auto_approve_paid_jobs` | Behaviour |
|----------------|--------------------------|--------------------------|-----------|
| `free_local` | true (default) | — | Auto-approve, no card |
| `free_local` | false | — | Show card, pre-filled $0 |
| `paid_api` / `subscription_external` | — | true | Auto-approve, card with budget preview |
| `paid_api` / `subscription_external` | — | false (default) | **Await user approval**, card with editable budget |
| `uncertain` | — | — | Treat as paid; show card |

## Host capacity probe

New endpoint on dev-agent:

```
GET /internal/dev-agent/host-capacity
```

Response:

```json
{
  "ram_total_mb": 16384,
  "ram_free_mb": 8192,
  "disk_free_gb": 120,
  "cpu_cores": 8,
  "gpu_vram_mb": null,
  "npu_available": false,
  "fetched_at": "2026-06-04T12:00:00Z"
}
```

Gateway caches this for 30 seconds (TTL config via `HOST_CAPACITY_CACHE_TTL_MS`).

## Planner extension (response-generator)

The existing `POST /internal/plan/tool-use` endpoint adds optional fields:

```json
{
  "steps": [...],
  "success_criteria": [...],
  "parallel_groups": [
    {"id": "g1", "task_ids": ["t1", "t2"]},
    {"id": "g2", "task_ids": ["t3"]}
  ],
  "tasks": [
    {"id": "t1", "goal": "search files for...", "profile_id": "...", "billing_class": "free_local", "depends_on": []},
    {"id": "t2", "goal": "list open PRs...", "profile_id": "...", "billing_class": "paid_api", "depends_on": []},
    {"id": "t3", "goal": "merge results...", "depends_on": ["t1", "t2"]}
  ]
}
```

Parallel groups are an annotation on the plan output, not a separate endpoint. If absent, the planner output is treated as sequential (no subagent workflow).

## Yggdrasil integration

The `@theaiinc/yggdrasil` library is embedded in the api-gateway as a dependency (not a separate compose service for v1). The bridge service wraps:

- `AgentManager` — register workers, health checks, `getAdmissionState()`
- `LoadBalancer` — route subtasks to available workers
- `OrchestrationConfig` — from env vars

**v1 worker model**: Yggdrasil manages **concurrency slots**. Actual execution calls `ExternalAgentsService.createSession` (host subprocess + worktree). A `WorkerBackend` interface abstracts the slot-vs-execution mapping.

### Env vars for Yggdrasil bridge

| Env | Default | Purpose |
|-----|---------|---------|
| `YGGDRASIL_MAX_CONCURRENCY` | 8 | Max concurrent worker slots |
| `YGGDRASIL_MAX_INSTANCES` | 10 | Max registered worker instances |
| `YGGDRASIL_HEALTH_INTERVAL_MS` | 30000 | Health check polling interval |
| `YGGDRASIL_CIRCUIT_BREAKER_THRESHOLD` | 5 | Failures before circuit breaker opens |

## New services (api-gateway/src/coordinator/)

All new code lives under `apps/api-gateway/src/coordinator/`:

| File | Responsibility |
|------|----------------|
| `coordinator.types.ts` | Types: `CoordinatorJob`, `JobBudget`, `CoordinatorTask`, `ParallelGroup`, `JobStatus`, `BillingClass`, `WorkerBackend` |
| `coordinator-preflight.service.ts` | Host probe + Yggdrasil admission + cost estimate → compute `parallel_allowed` + propose budget |
| `coordinator.service.ts` | Job lifecycle: `createJob`, `approveJob`, `dispatchApprovedJob`, `cancelJob`, `onChildReport` |
| `job-usage.service.ts` | Per-job token and USD rollup (mirrors `SessionUsageService`) |
| `job-budget.service.ts` | Per-job budget config + check (mirrors `SessionUsageService` budget methods) |
| `yggdrasil-bridge.service.ts` | Wraps `@theaiinc/yggdrasil` AgentManager + LoadBalancer |
| `host-capacity.service.ts` | Fetches + caches dev-agent host-capacity probe |
| `coordinator.controller.ts` | REST: `POST /api/v1/coordinator/jobs`, `GET /:id`, `POST /:id/approve`, `POST /:id/cancel` |
| `coordinator.module.ts` | NestJS module, imports Yggdrasil |

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/coordinator/jobs` | Create job from plan (triggers preflight) |
| GET | `/api/v1/coordinator/jobs/:id` | Status + preflight result |
| POST | `/api/v1/coordinator/jobs/:id/approve` | User budget + dispatch |
| POST | `/api/v1/coordinator/jobs/:id/cancel` | Cancel children |
| GET | `/api/v1/coordinator/host-capacity` | Cached host probe |

## UI components

| Component | File | Purpose |
|-----------|------|---------|
| `JobApprovalCard` | `oasis-ui/src/components/chat/JobApprovalCard.tsx` | Preflight card in chat stream |
| `JobBudgetPill` | `oasis-ui/src/components/chat/JobBudgetPill.tsx` | Job spend meter in header (alongside SessionBudgetPill) |

### JobApprovalCard

Renders inline in the chat stream (like `MissionDigestCard`). Shows:

- Task count and parallel vs sequential mode
- Estimated USD/ token range
- Host resource summary (slots, RAM, disk)
- Editable budget input (default = sum(high) * 1.2)
- Action buttons: Approve (with limit), Reject, Run sequentially (cheaper)

## Settings panel extensions

The Settings Panel gains two new toggles under a "Job/Subagent" section:

| Setting | Key | Default | Description |
|---------|-----|---------|-------------|
| Auto-approve free jobs | `oasis_auto_approve_free_jobs` | true | Skip approval for $0 tasks |
| Auto-approve paid jobs | `oasis_auto_approve_paid_jobs` | false | Skip approval for paid tasks |
| Default job USD cap | `oasis_default_job_budget_usd` | 5.0 | Proposed default limit |

## Event flow (Redis events)

New event types published to the parent session:

| Event | When | Payload |
|-------|------|---------|
| `CoordinatorPreflightReady` | Preflight computed | `{ job_id, task_count, parallel_count, parallel_allowed, est_usd_low, est_usd_high, host_ram, degraded_mode }` |
| `SubagentStarted` | Child agent spawned | `{ job_id, task_id, child_session_id, goal }` |
| `SubagentReport` | Child reached terminal state | `{ job_id, task_id, status, cost_usd, tokens, final_message }` |
| `SubagentBudgetWarn` | Job budget nearing limit | `{ job_id, pct, remaining_usd }` |
| `JobCompleted` | All children done | `{ job_id, status, total_cost, total_time_ms }` |

## Non-goals (deferred to later phases)

- **Workflow engine parallel execution**: The sequential DAG engine (`apps/api-gateway/src/workflows/engine.ts`) remains unchanged. Parallel subagent flows go through the coordinator, not the workflow engine.
- **Docker agent pool**: v1 uses host CLI subprocesses via existing `ExternalAgentsService`. A `ContainerBackend` implementing the `WorkerBackend` interface is deferred.
- **GPU/NPU scheduling beyond slot counting**: V1 treats GPU slots as a hard limit (configurable via `GPU_SLOTS`). True GPU scheduling and VRAM-aware allocation are deferred.

## Testing strategy

- **Unit**: Admission math, approval policy, budget rollup with mocked Yggdrasil metrics.
- **Integration**: Approve job -> 2 mocked external sessions -> SubagentReport events on parent session.
- **Manual**: Settings auto-approve off, paid profile, verify card blocks spawn until approve.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Yggdrasil v0.0.1 thin npm dist | `WorkerBackend` abstraction; host CLI first |
| Worktree disk explosion | Per-job worktree cap; reuse project-deletion cascade (#22) |
| Double budget (session + job) | Child spend rolls to job; parent session check includes active job reserved USD |
| GPU oversubscription | `resource_class: gpu` max 1 slot in admission |
| UNLICENSED package in CI | Private npm registry token in docs + `.npmrc` template |
