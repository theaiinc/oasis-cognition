# System Architecture Document (SAD)

## Project: Oasis Cognition / LogicCopilot

Version: 1.0 Draft

---

# 1. Introduction

## 1.1 Purpose

This document defines the system architecture for **Oasis Cognition (LogicCopilot)**, a hybrid neuro‑symbolic AI system designed to operate as a real‑time reasoning co‑pilot for programmers and technical users.

The system separates **communication intelligence** (LLMs and multimodal models) from **reasoning intelligence** (a symbolic logic core). Neural models translate human interaction into structured data, while the symbolic engine performs the actual reasoning and decision processes.

The architecture enables:

• explainable reasoning
• incremental learning through feedback
• low compute cost compared to pure LLM reasoning
• personalized cognitive models per user

---

## 1.2 System Vision

Oasis Cognition is designed as a **cognitive partner** that learns how its user thinks and solves problems.

Through repeated interaction, the system constructs a reasoning graph representing:

• user thinking patterns
• domain knowledge
• reasoning strategies
• constraints and heuristics

Instead of retraining neural networks, the system evolves through **structured knowledge updates**.

---

## 1.3 Design Principles

### Separation of Communication and Reasoning

Language models are responsible only for interpreting and expressing language. All reasoning is executed in the logic engine.

### Incremental Learning

The system learns by modifying structured knowledge (rules, graphs, constraints) rather than retraining neural models.

### Explainability

All reasoning paths must be observable and traceable.

### Compute Efficiency

The reasoning engine must run efficiently on CPU infrastructure without requiring GPU training pipelines.

---

# 2. System Overview

## 2.1 High‑Level Architecture

User
↓
Multimodal Input Layer
↓
Semantic Interpreter (LLM) — *Fast Path Detection*
↓
Thought Layer (Free-form Reasoning)
↓
Intent Structuring Engine
↓
Reasoning Graph Builder
↓
Logic Core Engine — *ThoughtNode Integration*
↓
Memory System
↓
Response Generator (LLM) — *JSON Repair*
↓
User

---

## 2.2 Core Responsibilities


| Component          | Role                                                         |
| ------------------ | ------------------------------------------------------------ |
| Input Layer        | Capture multimodal interaction                               |
| Interpreter        | Convert language to structured data; **Fast Path Detection** |
| Thought Layer      | Generate ephemeral free-form reasoning trace                 |
| Structuring Engine | Build reasoning graph; encapsulate Thoughts as nodes         |
| Logic Core         | Perform reasoning and inference; validate goal via Thoughts  |
| Memory             | Store long‑term knowledge and Reasoning Graphs               |
| Response Generator | Communicate results; **JSON Repair** for tool plans          |


---

# 3. Component Architecture

---

# 3.1 Multimodal Input Layer

## Purpose

Capture user input from multiple modalities and normalize it for interpretation.

## Supported Inputs

Voice
Text
Code snippets
Images
System logs

## Candidate Technologies

Speech recognition
• Whisper
• Deepgram
• Azure Speech

Code parsing
• Tree‑sitter

Vision models
• CLIP
• Vision Transformers

---

# 3.2 Semantic Interpreter

## Purpose

Translate natural language into structured semantic representation.

Responsibilities:

• intent extraction
• entity recognition
• context extraction
• ambiguity resolution
• **Fast Path detection** (trivial vs. technical task classification)

Important: **the interpreter does not perform reasoning**.

Example

User Input:

"My API becomes slow when traffic reaches 2000 users."

Structured Output:

Problem: API latency
Trigger: concurrency
Threshold: 2000
Metric: response time

---

# 3.3 Intent Structuring Engine

## Purpose

Convert semantic information into a reasoning graph structure.

This graph represents relationships between:

• problems
• triggers
• hypotheses
• constraints
• conclusions

Example Graph

Problem → Trigger → Hypothesis

---

# 3.4 Logic Core Engine

## Purpose

The logic engine performs structured reasoning over the reasoning graph.

Modules:

• **Thought Layer Generator** (Free-form reasoning trace)
• Reasoning Planner
• Hypothesis Generator
• Constraint Solver
• Decision Evaluator
• **Mid-loop Re-thinking Engine** (Reactive refinement)

---

## Reasoning Modes

### Instinct Mode

Fast rule‑based reasoning derived from learned patterns.

Example Rule:

IF API latency AND concurrency high
THEN inspect database connection pool

### Historical Mode

Search memory for similar previous problems.

### Hypothesis Mode

Generate potential explanations.

Example:

H1: database bottleneck
H2: thread pool exhaustion
H3: network latency

---

# 3.5 Constraint Solver

Validates logical consistency.

Possible technologies:

• Z3 SMT Solver
• Prolog
• custom rule engine

Example constraint

CPU utilization < 30%

Used to eliminate impossible hypotheses.

---

# 3.6 Memory System

Stores structured knowledge rather than raw conversations.

Memory Types

Episodic Memory
Session‑level reasoning context.

Semantic Memory
Conceptual knowledge about programming.

Procedural Memory
Reasoning strategies and rules.

Technologies

Graph Database: Neo4j
Vector Memory: embedding database
Short‑term memory: Redis

---

# 3.7 Learning and Feedback System

Learning occurs through graph updates.

Feedback Loop

System reasoning
↓
User correction
↓
Graph update
↓
Rule reinforcement

Example

User feedback:

"Caching will not fix this issue."

Stored rule:

If database locking exists → caching ineffective

---

# 3.8 Response Generator

Uses LLMs only to convert reasoning results into natural communication.

Capabilities

• explanation generation
• summarization
• conversational formatting
• voice synthesis
• **JSON Repair** (recovering malformed tool-call structures)

---

# 4. Reasoning Graph Schema

The reasoning graph represents cognitive state.

## Node Types

ProblemNode
TriggerNode
**ThoughtNode** (Free-form reasoning trace)
HypothesisNode
EvidenceNode
ConstraintNode
ActionNode
ConclusionNode
MemoryNode

---

## Edge Types

CAUSES
TRIGGERS
SUPPORTS
CONTRADICTS
LEADS_TO
DERIVED_FROM

---

## Example Graph

Problem(API latency)
→ Trigger(high concurrency)
→ Hypothesis(DB pool limit)
→ Evidence(pool size = 100)
→ Conclusion(bottleneck)

---

# 5. Data Models

## Reasoning Node

id
node_type
attributes
confidence_score
created_at
updated_at

## Reasoning Edge

source_node
target_node
edge_type
weight

## Memory Entry

memory_id
memory_type
graph_reference
user_reference
created_at

---

# 6. API Design

Base Path

/api/v1

---

## Interaction API

POST /interaction

Input

user_message
session_id
context

Output

structured_response
reasoning_graph
confidence

---

## Feedback API

POST /feedback

Input

session_id
reasoning_node
feedback_type
comment

Purpose

Refine reasoning graph.

---

## Memory API

GET /memory/query

Query semantic or graph memory.

---

# 7. Module Interfaces

## Interpreter Interface

interpret(input) → semantic_structure

---

## Graph Builder Interface

build_graph(semantic_structure) → reasoning_graph

---

## Logic Engine Interface

reason(reasoning_graph) → decision_tree

---

## Memory Interface

store(memory_entry)

retrieve(query)

---

## Response Generator Interface

format_response(decision_tree) → natural_language_output

---

# 8. Infrastructure Architecture

Microservice Layout

input-service
interpreter-service
graph-builder
logic-engine
memory-service
response-service

Deployment

Docker
Kubernetes

---

# 8.1 Event Architecture (Real‑Time Reasoning Pipeline)

The system follows an event‑driven architecture to support real‑time reasoning and continuous feedback learning.

## Event Flow Overview

User Input Event
↓
Interpretation Event (Fast Path check)
↓
Thought Generation Event (Free-form)
↓
Graph Build Event
↓
Reasoning Event (Mid-loop re-thinking)
↓
Validation Event
↓
Response Event (JSON Repair if needed)
↓
Feedback Event (optional)

## Event Bus

Recommended technologies:

• Kafka (production scale)
• NATS (lightweight real‑time)
• Redis Streams (MVP)

## Core Event Types

InteractionReceived
SemanticParsed
**ThoughtLayerGenerated** (New: ephemeral reasoning trace)
GraphConstructed
ReasoningStarted
HypothesisGenerated
ConstraintEvaluated
DecisionFinalized
ResponseGenerated
FeedbackReceived
MemoryUpdated

Each event carries structured payloads and trace IDs for observability.

---

# 8.2 Reasoning Graph Query Language (RGQL)

To support inspection and debugging, Oasis Cognition defines a lightweight query language for reasoning graphs.

## Design Goals

• readable for engineers
• expressive for reasoning queries
• safe for runtime execution

## Example Queries

Find all hypotheses for a problem

FIND HypothesisNode WHERE parent = "API latency"

Trace reasoning path

TRACE FROM ProblemNode("API latency") TO ConclusionNode

Find contradictions

MATCH (h:HypothesisNode)-[:CONTRADICTS]->(e:EvidenceNode)

## Execution Model

RGQL compiles into graph database queries (Neo4j / Cypher compatible layer).

---

# 8.3 Logic Engine Algorithm Flow

This section defines the internal execution pipeline of the logic engine.

## Step‑by‑Step Flow

1. Receive reasoning graph
2. **Generate/Update ThoughtNodes** (messy reasoning)
3. Expand hypotheses
4. Retrieve historical matches
5. Apply constraints
6. Score hypotheses
7. Select best candidate
8. **Validate consistency** (including ThoughtNode alignment)
9. Produce reasoning trace

## Scoring Model (Example)

score = (evidence_weight × confidence)
− (contradictions × penalty) + (historical_match × boost)

## Pseudocode

function reason(graph):
hypotheses = expand(graph)
history = retrieve_similar(graph)
evaluated = apply_constraints(hypotheses)
scored = score(evaluated, history)
best = select_max(scored)
validate(best)
return build_trace(best)

---

# 8.4 Implementation Roadmap

## Phase 1 — MVP (0‑3 months)

• text‑only interface
• basic reasoning graph
• simple rule engine
• manual feedback loop

## Phase 2 — Real‑Time Copilot (3‑6 months)

• voice support
• event architecture
• memory persistence
• IDE integration (VSCode)

## Phase 3 — Advanced Cognitive System (6‑12 months)

• multi‑agent reasoning
• visual graph debugger
• automated hypothesis generation
• collaborative knowledge sharing

---

# 9. Cost Model

Most reasoning occurs in CPU symbolic engine.

Expected compute:

4‑8 CPU cores
16‑32GB RAM

LLM used only for:

interpretation
response formatting

Estimated cost per request

$0.01 – $0.05

Significantly cheaper than LLM reasoning loops.

---

# 10. Future Extensions

Potential future capabilities

multi‑agent reasoning
IDE integration
visual reasoning graphs
team knowledge networks
self‑critique reasoning modules

---

# 11. Detailed Reasoning Node Schema

To enable consistent reasoning and storage, all reasoning graph nodes follow a standardized schema.

## Base Node Structure (JSON)

{
"id": "uuid",
"node_type": "ProblemNode | HypothesisNode | EvidenceNode | ConstraintNode | ConclusionNode",
"title": "string",
"description": "string",
"attributes": {},
"confidence": 0.0,
"source": "user | system | memory",
"created_at": "timestamp",
"updated_at": "timestamp"
}

## Node Attribute Examples

ProblemNode

{
"problem_type": "performance",
"system_component": "API",
"metric": "latency"
}

HypothesisNode

{
"hypothesis": "database connection pool saturation",
"category": "database"
}

EvidenceNode

{
"metric": "db_pool_size",
"value": 100
}

ConstraintNode

{
"rule": "CPU utilization < 30%"
}

ConclusionNode

{
"result": "database bottleneck"
}

---

# 12. Event Payload Contracts

Every event emitted by the system must follow a standard structure to ensure observability and traceability.

## Base Event Schema

{
"event_id": "uuid",
"event_type": "string",
"session_id": "string",
"timestamp": "timestamp",
"trace_id": "string",
"payload": {}
}

## Example Event: InteractionReceived

{
"event_type": "InteractionReceived",
"session_id": "abc123",
"payload": {
"user_message": "API becomes slow at 2000 users"
}
}

## Example Event: HypothesisGenerated

{
"event_type": "HypothesisGenerated",
"payload": {
"hypotheses": [
"database bottleneck",
"thread pool exhaustion",
"network congestion"
]
}
}

## Example Event: DecisionFinalized

{
"event_type": "DecisionFinalized",
"payload": {
"decision": "database connection pool saturation",
"confidence": 0.82
}
}

---

# 13. Service Communication Contracts

The system microservices communicate using internal APIs.

## Interpreter Service

POST /internal/interpret

Input

{
"text": "string"
}

Output

{
"semantic_structure": {}
}

---

## Graph Builder Service

POST /internal/graph/build

Input

{
"semantic_structure": {}
}

Output

{
"reasoning_graph": {}
}

---

## Logic Engine Service

POST /internal/reason

Input

{
"reasoning_graph": {}
}

Output

{
"decision_tree": {},
"confidence": 0.0
}

---

## Memory Service

POST /internal/memory/store

GET /internal/memory/query

---

# 14. Repository Structure

Recommended repository layout for development.

project-root

apps/
api-gateway/

services/
interpreter/
graph-builder/
logic-engine/
memory-service/
response-generator/

packages/
reasoning-schema/
event-types/
shared-utils/

infra/
docker/
k8s/

---

# 15. Conclusion

Oasis Cognition introduces a hybrid AI architecture combining neural communication models with symbolic reasoning engines.

This architecture enables explainable reasoning, personalized learning, and low-cost operation while maintaining the flexibility of natural language interaction.

By separating language processing from logical reasoning, the system establishes a scalable foundation for future cognitive AI systems capable of structured thought, continuous learning, and transparent decision making.

---

# 16. Reasoning Graph Execution Example (Full Trace)

This section demonstrates a full reasoning execution trace from user input to final decision.

## Scenario

User input:

"My API becomes slow when traffic reaches 2000 users."

---

## Step 1 — Semantic Interpretation

Output:

{
"problem": "API latency",
"trigger": "high concurrency",
"threshold": 2000,
"metric": "response time"
}

---

## Step 2 — Graph Construction

Nodes Created:

ProblemNode(API latency)
TriggerNode(high concurrency)

Edges:

TRIGGERS → ProblemNode

---

## Step 3 — Hypothesis Expansion

Generated Hypotheses:

H1: database connection pool saturation
H2: thread pool exhaustion
H3: network congestion

Graph Update:

ProblemNode → HypothesisNodes

---

## Step 4 — Evidence Collection

System retrieves observed data:

CPU utilization = 25%
DB pool size = 100
Active connections ≈ 100

EvidenceNodes added and linked.

---

## Step 5 — Constraint Evaluation

ConstraintNode:

CPU utilization < 30%

Effect:

Eliminate H2 (thread pool hypothesis unlikely).

---

## Step 6 — Scoring

Example scoring:

H1 score = 0.82
H2 score = 0.21
H3 score = 0.35

---

## Step 7 — Decision Selection

Selected Conclusion:

Database connection pool saturation

---

## Step 8 — Response Generation

System Output:

"Your API slowdown is most likely caused by database connection pool limits under high concurrency."

---

# 17. Logic Engine Algorithm Specification (v1)

This section defines the formal algorithmic specification for the logic engine.

## 17.1 Core Objectives

The logic engine must:

• evaluate multiple hypotheses concurrently
• maintain logical consistency
• provide explainable outputs
• support incremental updates

---

## 17.2 Execution Pipeline

The engine follows this deterministic sequence:

1. Normalize graph
2. **Process/Update ThoughtNodes** (messy reasoning integration)
3. Expand hypothesis set
4. Retrieve contextual memory
5. Apply logical constraints
6. Perform probabilistic scoring (weighted by Thoughts)
7. Rank hypotheses
8. **Validate top candidate (Goal alignment)**
9. Generate explanation trace

---

## 17.3 Formal Algorithm (Pseudocode)

function logic_engine_execute(graph):

```
normalized = normalize(graph)

# Extract free-form reasoning from graph
thoughts = extract_thoughts_from_graph(normalized)

hypotheses = expand_hypotheses(normalized)

context = retrieve_memory(normalized)

constrained = apply_constraints(hypotheses, context)

# Score based on both structured evidence and messy thoughts
scored = probabilistic_score(constrained, context, thoughts)

ranked = sort_desc(scored)

best = ranked[0]

# Validate alignment between decision and reasoning thoughts
if not validate_alignment(best, thoughts):
    best = fallback(ranked)

trace = build_explanation(best, thoughts)

return best, trace
```

---

## 17.4 Scoring Function (Detailed)

score(h) =

(w1 × evidence_strength)

- (w2 × memory_similarity)
- (w3 × rule_match)
− (w4 × contradictions)

Weights configurable per domain.

---

## 17.5 Consistency Validation

The engine must ensure:

• no contradictory conclusions
• constraint compliance
• graph integrity

If violated:

→ trigger re-evaluation

---

## 17.6 Incremental Update Strategy

When feedback arrives:

1. adjust hypothesis weights
2. store correction in memory
3. reinforce valid rules
4. prune weak hypotheses

This enables continuous learning without retraining.