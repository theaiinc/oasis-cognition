# FLEXIBILITY IMPROVEMENT PLAN (Oasis Cognition)

## 🎯 Goal

Fix current limitation where the agent underperforms compared to a normal LLM on simple tasks.

Root cause:

- Over-structured too early
- No free-form thinking phase
- LLM forced into strict JSON planning prematurely

---

# 🧠 Key Architectural Fix

Introduce a **THOUGHT LAYER (ephemeral reasoning stage)** before tool planning.

New flow:

User
↓
Interpreter
↓
THOUGHT LAYER (NEW)
↓
Planner (structured JSON)
↓
Execution
↓
Observer
↓
Memory

---

# 🔥 Core Principles

1. Separate THINK vs ACT
2. Allow messy reasoning before structure
3. Delay validation until after thinking
4. Only store validated reasoning

---

# 🧩 Implementation Plan

## 1️⃣ Add Thought Layer Service

Create new internal service or module:

POST /internal/thought

Input:
{
"user_input": string,
"context": object,
"memory_context": [],
"rules": []
}

Output:
{
"thoughts": string
}

IMPORTANT:

- Output is FREE TEXT
- NOT JSON
- NOT structured

Example:

"This looks like a frontend issue. Probably related to syntax highlighting. Might involve CodeBlock or markdown rendering. Need to search codebase."

---

## 2️⃣ Modify Planner Input

Update TOOL_PLAN_PROMPT to include:

THOUGHTS:
{thoughts}

Instruction:
"Use the thoughts above as reasoning context before deciding actions."

---

## 3️⃣ Relax JSON Strictness

Before:

- LLM must output perfect JSON

After:

- Allow imperfect output
- Apply repair step AFTER generation

Steps:

1. Generate raw output
2. Attempt JSON parse
3. If fail → repair using secondary LLM call or regex

---

## 4️⃣ Add Fast Path (IMPORTANT)

Detect simple tasks:

If:

- no tool required
- direct answer possible

Then bypass:

Interpreter → Thought → Response (LLM)

Skip:

- planner
- tool execution
- observer

---

## 5️⃣ Delay Logic Engine Enforcement

Current problem:

- logic engine blocks too early

Fix:

Logic engine should:

- validate AFTER planning
- not block thought generation

---

## 6️⃣ Observer Adjustment

Current:

- strict validation immediately

Change to:

Observer should:

- allow 1–2 exploration attempts
- only enforce strict validation after attempts

---

## 7️⃣ Thought Lifecycle (CRITICAL)

Define lifecycle:

LLM Thought (temporary)
↓
Planner Decision
↓
Execution Result
↓
Observer Validation
↓
Logic Engine Validation
↓
Memory Storage (Neo4j)

Rules:

- NEVER store raw thoughts
- ONLY store validated reasoning

---

## 8️⃣ Memory Improvement

When storing reasoning:

Convert:

thought → structured rule

Example:

IF syntax highlighting missing
THEN check CodeBlock component

---

## 9️⃣ Error Handling Improvement

Replace current loop:

invalid JSON → retry → fail

With:

invalid JSON → repair → continue

---

# 🧪 Expected Improvements

After implementation:

- Fewer JSON failures
- Better performance on simple tasks
- More human-like reasoning
- Reduced retry loops
- Better tool selection

---

# ⚠️ Constraints

DO NOT:

- store unvalidated thoughts
- enforce strict schema before thinking
- block reasoning early

DO:

- allow exploration
- validate later
- keep logic engine authoritative

---

# 🎯 Final Outcome

System becomes:

LLM = thinking + communication
Logic Engine = validation + consistency
Graph DB = long-term reasoning memory

---

# 🚀 Summary

This upgrade converts the system from:

"Rigid tool executor"

→ into

"Reasoning-first intelligent agent"

---

# END
