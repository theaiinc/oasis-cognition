# What makes Oasis Cognition different

Oasis is not “a single LLM with plugins.” It is a **composed system** where neural models handle language and structure, while **explicit services** handle memory, validation, execution, and long-horizon control.

## 1. Neuro-symbolic split

The **interpreter** and **response-generator** use LLMs for language understanding and planning, but **graph-builder** and **logic-engine** apply symbolic scoring, evidence weights, and rule-style checks. The **observer** closes the loop so plans and actions are critiqued with structured feedback rather than only free-form model prose. The product vision is documented in depth in [SAD.md](../SAD.md).

## 2. Durable graph memory (Neo4j)

**memory-service** stores session-scoped and longer-lived knowledge in **Neo4j**, not only ephemeral chat context. That supports richer retrieval, consistency checks, and internal APIs for agents (including code-aware queries).

## 3. Code knowledge in the tool loop

A dedicated **code-indexer** parses TS/JS with **Tree-sitter** and writes a **code graph** into the same Neo4j. Before tool-planning iterations, the **api-gateway** can attach a compact **`[CODE INDEX (Neo4j)]`** block to the planner context by querying memory-service — reducing blind `grep` loops and anchoring edits to real symbols. Details: [code-indexing-service-design.md](../code-indexing-service-design.md) and [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md).

## 4. Host-native dev-agent and git worktrees

File-changing tools run through **dev-agent** on the **host**, with real **git worktree** workflows. That avoids Docker-only filesystem snapshots for serious editing and keeps branch isolation explicit — closer to how engineers actually work.

## 5. Multiple specialized backends

Different stages can use different models and providers (**Ollama**, **Anthropic**, **OpenAI-compatible** gateways) via separate env knobs (`OASIS_LLM_*`, `OASIS_RESPONSE_*`, `OASIS_TOOL_PLAN_*`). Teaching, tool planning, and interpretation can be tuned independently.

## 6. Observable multi-step runs

**Langfuse** integration traces interactions and tool plans (with optional debug payload flags documented in compose). Combined with NDJSON streaming to the UI, you can see **thought layers**, tool cards, and observer feedback as a timeline rather than a single opaque completion.

## 7. Voice and multimodal path

**LiveKit**, **voice-agent**, and optional **screen context** forwarding into the interpreter allow voice-first and UI-aware sessions without forking the core gateway contract.

## 8. Artifact processing and transcription pipeline

**artifact-service** handles document uploads (PDF, DOCX, PPTX), text extraction, embedding generation, and integrates with the transcription backends. Audio files are processed through **diarization** (speaker segmentation) and **transcription** (MLX-Whisper or **GIPFormer** for Vietnamese) to produce searchable, speaker-attributed text stored in Neo4j via memory-service.

---

When comparing to other agent frameworks: Oasis optimizes for **inspectable pipelines**, **graph-backed memory**, **first-class code indexing**, **document and audio processing**, and **host-level engineering workflows** — not for the smallest possible single-process demo.
