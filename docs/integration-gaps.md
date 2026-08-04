# Integration gap log

This document records defects found while integrating Oasis Cognition with
optional platform libraries. Local defects are fixed in this repository;
upstream defects are documented for follow-up and are not patched here.

## Current findings

### INT-001 — Interaction response protocol drift

- **Component:** Oasis Cognition gateway/UI/integration client
- **Status:** Fixed locally
- **Reproduction:** POST `/api/v1/interaction` and parse the response as NDJSON.
- **Expected:** A client can receive the completed response from the POST body.
- **Observed:** The gateway returns `202 {"session_id": ...}` and publishes the
  completed response asynchronously on `/api/v1/events/timeline`.
- **Impact:** The old UI helper and integration client treated acceptance as a
  final empty response and cleared in-flight state too early.
- **Fix:** UI now validates the acceptance payload and waits for timeline
  events; integration tests wait for the assistant history entry correlated by
  `client_message_id`.
- **Regression coverage:** Gateway/UI build and integration client protocol
  coverage.

### INT-002 — Shared service schemas drifted from Python responses

- **Component:** `packages/gateway-contracts`
- **Status:** Fixed locally
- **Reproduction:** Validate memory graph storage and tool-plan responses
  against the old schemas.
- **Observed:** Memory returns `{status, graph_id}`; tool planning returns its
  action object directly; tool-plan requests accept context-window overrides
  omitted by the TypeScript schema.
- **Impact:** Runtime payload validation could reject valid service responses or
  fail to describe fields actually sent by the gateway.
- **Fix:** Updated schemas to match the live endpoint contracts.

### INT-003 — Browser filesystem picker cannot expose host paths

- **Component:** Projects panel
- **Status:** Fixed locally
- **Reproduction:** Use `showDirectoryPicker()` in a normal browser and create
  a local project.
- **Observed:** The browser exposes only the directory name, not its absolute
  host path.
- **Impact:** A directory name could be sent to the dev-agent as a filesystem
  path and index the wrong location.
- **Fix:** Only desktop-provided absolute paths are accepted from the picker;
  browser users must enter the host path manually.

### INT-004 — Full Python suite stalls in fallback-backed tests

- **Component:** Python test suite / memory-service fallback
- **Status:** Fixed locally
- **Reproduction:** Run `python -m pytest -q` with external services stopped.
- **Observed:** 48 tests report progress and the suite remains running past
  90 seconds; the command was stopped by the timeout. Focused LLM-client and
  logic-engine tests pass.
- **Fix:** Bounded Neo4j initialization with configurable connection timeout,
  retry count, and delay. Defaults now fail fast and rely on service/container
  restart policy for persistent database recovery.
- **Verification:** Memory tests pass 5/5; full Python suite passes 56/56.
- **GitHub tracking:** [#27](https://github.com/theaiinc/oasis-cognition/issues/27) (closed)

### INT-005 — Browser E2E runner is not installed

- **Component:** UI test infrastructure
- **Status:** Fixed locally
- **Fix:** Added a dedicated Playwright package, Chromium setup, and a
  deterministic interaction smoke test covering UI load, client-message
  correlation, and the asynchronous 202 interaction contract.
- **Verification:** Browser smoke test passes 1/1.
- **GitHub tracking:** [#24](https://github.com/theaiinc/oasis-cognition/issues/24) (closed)

### INT-006 — Integration setup waited too long without services

- **Component:** Integration test harness
- **Status:** Fixed locally
- **Fix:** Setup now uses the canonical service ports, has a configurable
  10-second default timeout, and reports the exact Compose provisioning
  command. A standalone setup-contract test covers the defaults and
  unavailable-service error.
- **Verification:** Setup unit tests pass 2/2; the full suite now fails in
  about 12 seconds with an actionable prerequisite message when the stack is
  absent.
- **GitHub tracking:** [#26](https://github.com/theaiinc/oasis-cognition/issues/26) (closed)

## External integrations

### Leyline

- **Repository:** `@theaiinc/leyline`
- **Current state:** Optional routing is already implemented in
  `packages/shared_utils/llm_client.py`.
- **Verified:** 32 focused client tests pass, including provider override,
  endpoint selection, streaming, and budget headers.
- **Not verified:** A live Leyline-routed request; no Leyline service endpoint
  was configured during this run.
- **Constraint:** Empty `OASIS_LEYLINE_BASE_URL` must preserve direct-provider
  behavior.

### Janus

- **Repository:** `https://github.com/theaiinc/janus`
- **Identified role:** Cloudflared tunnel guardian that monitors health and
  runs recovery steps.
- **Status:** Optional health adapter implemented against Janus v0.1.4.
- **Action:** `GET /api/v1/health/janus` calls Janus `/api/status` only when
  `JANUS_BASE_URL` is configured, returns sanitized disabled/healthy/unavailable
  state, and never makes chat or management flows depend on tunnel supervision.
- **Verification:** Janus adapter tests pass 3/3; gateway build passes.
- **GitHub tracking:** [#25](https://github.com/theaiinc/oasis-cognition/issues/25) (closed)

### Arcana

- **Identified role:** Local policy/account and approved-command boundary.
- **Status:** Optional Ash adapter implemented.
- **Action:** `GET /api/v1/health/arcana` reports disabled/ready/unavailable
  status. Project commands use fixed argv through Ash, require absolute paths,
  reject NUL bytes, and never accept secret values from the gateway.
- **Verification:** Arcana adapter tests pass 4/4; gateway build passes.
- **Limitation:** The local Arcana project has no Oasis project mapping and the
  daemon was unavailable during verification, so a real policy-backed command
  remains unverified.
- **GitHub tracking:** [#28](https://github.com/theaiinc/oasis-cognition/issues/28) (closed)

### Integration harness tracking

- **GitHub tracking:** [#26](https://github.com/theaiinc/oasis-cognition/issues/26)

## Classification rule

Failures in gateway, UI, contracts, configuration, adapters, and test
infrastructure are Oasis Cognition issues and should be fixed here. Failures
reproduced only inside an external library are documented with a version,
reproduction, impact, workaround, and proposed upstream location, but the
external library is not modified in this pass.
