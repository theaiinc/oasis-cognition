# Workflows, Agent Profiles, and Project Roles

> Tracking issue: [#20](https://github.com/theaiinc/oasis-cognition/issues/20)

This guide explains the three coupled subsystems that let users author task
automation, define reusable model/tool configurations, and bind them to named
personas per project.

## The three layers

```
┌──────────────────┐    runs in    ┌──────────────────┐
│   Workflow       │  ───────────► │  Workflow Run    │  (BullMQ job)
│   (DAG of nodes) │               │  (per-execution) │
└──────────────────┘               └──────────────────┘
        ▲                                    │
        │ may invoke via mcp_tool node       │
        │                                    ▼
┌──────────────────┐  resolves    ┌──────────────────┐
│ Project Role     │  ──────────► │ Agent Profile    │
│ (persona)        │              │ (model + config) │
└──────────────────┘              └──────────────────┘
        ▲                                    │
        │ chosen via <RolePicker>            │ used to spawn
        │                                    ▼
┌──────────────────┐              ┌──────────────────┐
│ Chat / spawn     │              │ Internal LLM /   │
│ caller           │              │ Claude Code /    │
│                  │              │ Cursor CLI       │
└──────────────────┘              └──────────────────┘
```

Each layer is independently useful — a workflow doesn't have to involve
agents, a profile is meaningful even without a role, and a role can be the
sole identity-routing signal for chat without ever spawning an external
agent.

## Workflows

A workflow is a directed acyclic graph of typed nodes. Each node consumes
upstream output and produces output that downstream nodes can interpolate.

### Node types

| Type        | What it does |
|-------------|--------------|
| `input`     | Entry point; receives the run's input payload |
| `transform` | Pure JS expression / template over upstream values |
| `branch`    | Conditional fan-out (`if/else` on a JSON-path expression) |
| `filter`    | Drop a payload from the run if a predicate fails |
| `delay`     | Wait N ms before continuing |
| `http`      | Generic HTTP request with templated headers/body |
| `mcp_tool`  | Invoke any tool exposed by the Oasis MCP server (artifacts, memory, code-graph, computer-use, …) |
| `output`    | Terminal node; the run's final payload |

### Parameter interpolation

Any node param accepts `{{in.<key>}}` (the run's input) and
`{{nodes.<id>.out.<path>}}` (an upstream node's output). Interpolation is
evaluated at execution time, after all upstream nodes have completed.

### Triggers

A workflow has zero or more triggers. Two trigger kinds today:

- **`cron`** — standard cron expression; the trigger manager schedules an
  enqueue at each tick.
- **`event`** — listens for an Oasis event with optional payload-field
  filters. Matching events enqueue a run with the event payload as input.

Trigger nodes (a special node type on the canvas) and side-tab trigger
definitions stay in sync bidirectionally — editing one updates the other.

### Storage and execution

- Workflows + runs persist in **Redis** (`wf:<id>`, `run:<id>`).
- A **BullMQ** queue handles execution; each run is a job with retries
  configurable per workflow.
- Manual runs and cancels are exposed via the gateway REST API.

### Authoring from chat

The in-conversation LLM has direct access to workflow CRUD via
`apps/api-gateway/src/interaction/native-workflow-tools.ts`. Tools include
`workflow_list`, `workflow_create`, `workflow_run`, `workflow_add_node`,
`workflow_add_edge`, `trigger_create`, etc. — the planner can iterate on a
workflow within a single conversation without leaving the chat surface.

## Agent Profiles

A profile is a reusable bundle that says *how* to run an agent, decoupled
from *which* agent. Fields:

| Field                     | Example                       |
|---------------------------|-------------------------------|
| `agent_type`              | `internal` / `claude-code` / `cursor-cli` |
| `model`                   | `claude-opus-4-7`, `qwen2.5-coder:7b`, … |
| `provider`                | `anthropic`, `ollama`, `openai-compatible` |
| `permission_mode`         | `read-only` / `read-write` / `dangerously-skip-permissions` |
| `mcp_enabled`             | bool — whether spawned children get MCP config |
| `system_prompt_preamble`  | extra system-prompt prefix appended to every spawn |
| `extra_args`              | passthrough CLI args for external agents |

A default profile (`internal-default`) is created on boot, so the system
always has something callable even before the user defines anything.

Profiles are stored in Redis with an in-memory fallback. They're consumed by:

- **`external-agents.service.ts`** — resolves the profile into spawn
  parameters and writes per-agent MCP config before exec'ing the subprocess.
- **`interaction.service.ts`** — uses the profile bound to the active role
  to route a chat turn to the right model/provider.

## Project Roles

A role is a named persona scoped to a project. Each role binds to one agent
profile and contributes a description that the system prepends as a
system-prompt preamble (before the profile's own preamble) when a spawn or
chat turn assumes that role.

Preset kinds — `researcher`, `developer`, `data_analyst`, `designer` — ship
with sensible default descriptions and bind to `internal-default`. Users
can also create `custom` roles.

Roles drive two distinct call sites:

1. **External agent spawn** — `external-agents` calls
   `agent_spawn(role_id: X)`. The role's description becomes the agent's
   identity ("you are a meticulous researcher…") and its profile dictates
   the model/permission mode.
2. **Chat routing** — the UI's `<RolePicker>` writes `activeRoleId` to
   localStorage per project; every chat turn includes it. The interaction
   service resolves it to a profile and routes accordingly.

Roles are persisted in Redis. Default roles are created in `onModuleInit()`
the first time a project requests them.

## The Oasis MCP server

`apps/mcp-server/` is a standalone Node service that re-exposes Oasis
capabilities as MCP tools:

- `registerWorkflowTools` — same surface as native-workflow-tools but
  reachable from external agents.
- `registerAgentProfileTools` — read-only browse + spawn shortcuts.
- `registerProjectRoleTools` — list/create/edit roles.
- Plus the existing artifact / memory / code-graph / computer-use surface.

When `external-agents.service.ts` spawns a Claude Code or Cursor CLI child
with `mcp_enabled: true`, it writes a per-agent MCP config that points the
child at `${OASIS_MCP_SERVER_URL}/mcp` (default
`http://localhost:8020/mcp`). The child agent then has the full Oasis
toolkit available alongside its own native tools.

The MCP server runs in `docker-compose.yml` as `oasis-mcp-server` and
depends on the gateway + Redis.

## Putting it together — typical flows

**Run a daily code review on a worktree**

1. User defines an agent profile: *Claude Code 4.7, read-write, MCP
   enabled, preamble = "You are an exacting code reviewer…"*
2. User defines a project role: *"Reviewer", bound to that profile*.
3. User authors a workflow: cron trigger (daily 9am) → mcp_tool
   (`agent_spawn` with `role_id: reviewer`, repo: …) → http (post
   summary to Slack).
4. The cron trigger enqueues a run; the spawn node calls into the MCP
   server which calls back into `external-agents` to actually run Claude
   Code in a worktree; the transcript flows back into the run output;
   the http node posts it.

**Switch personas mid-conversation**

1. User clicks `<RolePicker>` and selects "Researcher".
2. Subsequent chat turns include `role_id: researcher` in the
   interaction request.
3. `interaction.service.ts` resolves the role → its profile → the
   provider + model + preamble, and routes the turn accordingly. The
   user's chat is now backed by whatever model the Researcher profile
   designates, with the researcher persona prepended.

## Known gaps

See the issue tracker for the current punch list — major items:

- Web-search node implementation
- DAG cycle detection
- Custom-role authoring UI (CRUD via REST works, no panel yet)
- Workflow runs retention policy
- Multi-machine MCP server URL routing
