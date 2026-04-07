# Oasis Cognition documentation

Index of curated docs for operators and contributors. For day-to-day agent conventions and interface contracts, see `[AGENT_GUIDELINES.md](../AGENT_GUIDELINES.md)` at the repo root.

## Architecture


| Document                                                 | What it covers                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Architecture overview](architecture/overview.md)        | How services connect, ports, request flow, infrastructure (Neo4j, Redis, Langfuse, LiveKit). |
| [System Architecture Document (SAD)](SAD.md)             | Long-form neuro-symbolic vision, reasoning graph, and design rationale (LogicCopilot era).   |
| [Code indexing service](code-indexing-service-design.md) | Tree-sitter indexing, Neo4j schema (`CodeFile`, `CodeSymbol`, `CodeModule`), APIs, watcher.  |


## Guides


| Document                                                           | What it covers                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [Getting started](guides/getting-started.md)                       | Prerequisites, `make up`, Ollama, dev-agent, optional code indexer, health checks.              |
| [What makes Oasis different](guides/what-makes-oasis-different.md) | Differentiators: symbolic layer, memory, code graph in the tool loop, worktrees, observability. |


## Other notes


| Document                                                    | Notes                          |
| ----------------------------------------------------------- | ------------------------------ |
| [GoT alternative implementation](GoT_Alt_Implementation.md) | Graph-of-Thoughts exploration. |
| [Improve plexibility](IMPROVE_PLEXIBILITY.md)               | Internal design notes.         |


