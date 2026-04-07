## Thought Layer (Graph-of-Thought) Implementation Plan
### Architecture Overview
The Thought Layer adds a **pre-execution reasoning phase** to the tool loop. Before the Execution Agent picks a tool, the system generates candidate "thoughts" (hypotheses about what to do next), validates them symbolically via the Logic Engine, and injects only validated thoughts into the tool-plan prompt. This creates a Graph-of-Thought structure where thoughts are nodes that link to plan steps, tool results, and each other.
### Key Design Decisions
1. **Thought generation lives in response-generator** because it already hosts all LLM-based planning (plan_tool_use, plan_tool_calls). Thoughts are a lightweight LLM call that produces structured candidates.
2. **Thought validation lives in logic-engine** because it already does symbolic reasoning (scoring, constraint application, memory matching). Validating thoughts is analogous to scoring hypotheses.
3. **Only validated thoughts get stored in memory** -- the memory-service already has `store_graph` which accepts ReasoningGraph with nodes. We add ThoughtNode as a new node type and store it in the task graph. Unvalidated thoughts never leave the response-generator response.
4. **Thoughts integrate BEFORE tool execution in the tool loop** (interaction.service.ts), between the planning call and the tool-executor call. This is the natural insertion point.
5. **Minimal new endpoints**: just 2 new endpoints. No new microservices needed.
---
### Step-by-Step Implementation
#### Step 1: Add ThoughtNode to the reasoning schema
**File: `/Users/stevetran/oasis-cognition/packages/reasoning-schema/enums.py`**
Add `THOUGHT = "ThoughtNode"` to `NodeType` enum (after COMPLETION). Add `INFORMS = "INFORMS"` to `EdgeType` enum (thought informs a plan step or action).
**File: `/Users/stevetran/oasis-cognition/packages/reasoning-schema/models.py`**
Add a `ThoughtNode` class:
```python
class ThoughtNode(ReasoningNode):
    """A validated thought/hypothesis from the Graph-of-Thought layer."""
    node_type: NodeType = NodeType.THOUGHT
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "thought": "",
        "rationale": "",
        "confidence": 0.0,
        "validated": False,
    })
```
No new standalone model needed for the thought validation result; it will be returned as a plain dict from the endpoints.
---
#### Step 2: Add `POST /internal/thought/generate` to response-generator
**File: `/Users/stevetran/oasis-cognition/services/response-generator/service.py`**
Add a new method `generate_thoughts()` to `ResponseGeneratorService`:
- **Input**: `user_message`, `tool_results` (recent), `upfront_plan`, `memory_context`, `rules`, `walls_hit`, `observer_feedback`
- **Output**: `{ thoughts: [{ thought: str, rationale: str, confidence: float }] }` -- a list of 2-4 candidate thought nodes
- **Prompt**: A new `THOUGHT_GENERATION_PROMPT` constant that instructs the LLM to produce a JSON array of thoughts. The prompt should say: "Given the user's goal, current tool results, walls hit, and observer feedback, generate 2-4 candidate next-step hypotheses. Each thought should be a specific, actionable hypothesis about what to do or investigate next. Output JSON: `{ thoughts: [{ thought: ..., rationale: ..., confidence: 0.0-1.0 }] }`."
- **Implementation pattern**: Follow the same pattern as `plan_tool_calls` -- use `self._llm.chat()`, `extract_json()`, retry up to 3 times, normalize output.
**File: `/Users/stevetran/oasis-cognition/services/response-generator/main.py`**
Add the endpoint:
- New Pydantic model `ThoughtGenerateRequest` with fields matching the method parameters
- New route `@app.post("/internal/thought/generate")` that calls `generator.generate_thoughts(...)` and returns the result
- Follow the existing pattern of try/except with fallback (return empty thoughts list on failure)
---
#### Step 3: Add `POST /internal/reason/validate-thoughts` to logic-engine
**File: `/Users/stevetran/oasis-cognition/services/logic-engine/service.py`**
Add a new method `validate_thoughts()` to `LogicEngineService`:
- **Input**: `thoughts: list[dict]`, `memory_context`, `rules`, `walls_hit`, `tool_results`
- **Output**: `{ validated_thoughts: [{ thought, rationale, confidence, validated: bool, rejection_reason?: str }] }`
- **Logic** (purely symbolic, no LLM call):
  1. **Wall check**: If a thought references a path/pattern that appears in `walls_hit`, reject it (`validated=False`, reason: "References a known failed path").
  2. **Rule alignment**: If taught rules contradict the thought, reject it. If rules support it, boost confidence by 0.1.
  3. **Memory grounding**: If memory_context has entries that support the thought (keyword overlap), boost confidence. If memory says "not_achievable" for similar goals, reject.
  4. **Deduplication**: If the thought is essentially the same as a recent tool result (same tool+path), reject as redundant.
  5. **Confidence threshold**: Only mark `validated=True` if final confidence >= 0.3.
**File: `/Users/stevetran/oasis-cognition/services/logic-engine/main.py`**
Add the endpoint:
- New Pydantic model `ValidateThoughtsRequest` with fields: `thoughts`, `memory_context`, `rules`, `walls_hit`, `tool_results`
- New route `@app.post("/internal/reason/validate-thoughts")` that calls `engine.validate_thoughts(...)` and returns the result
---
#### Step 4: Integrate into the tool loop in interaction.service.ts
**File: `/Users/stevetran/oasis-cognition/apps/api-gateway/src/interaction/interaction.service.ts`**
This is the most critical change. Inside `handleToolUse`, modify the main loop (starting at approximately line 701) to add thought generation + validation **between** the current "Ask Execution Agent to plan next tool call" step and the tool execution step.
**Specific insertion point**: After line 750 (where `planRes` is received from `/internal/response/tool-plan`) and BEFORE line 767 (the `if (plan.action === 'final_answer')` check).
The new flow for each iteration becomes:
```
1. Generate thoughts (POST /internal/thought/generate) -- pass recent tool_results, walls, plan, memory, rules
2. Validate thoughts (POST /internal/reason/validate-thoughts) -- symbolic check
3. Filter to only validated thoughts
4. Store validated thoughts as ThoughtNodes in taskGraph (locally, in-memory)
5. Inject validated thoughts into the tool-plan call (add to the prompt payload)
6. Existing: Ask Execution Agent for next action (with validated thoughts in context)
7. Existing: Execute tool / handle final_answer
8. Existing: Observer validates
```
**Important detail**: The thought generation call happens BEFORE the tool-plan call, not after it. This means restructuring the loop slightly:
Currently:
```
for iteration:
  planRes = call tool-plan  (line ~739)
  if final_answer: observer validate (line ~767)
  if call_tool: execute tool (line ~947)
  observer validate (line ~1127)
```
New flow:
```
for iteration:
  thoughtsRes = call thought/generate  (NEW)
  validateRes = call reason/validate-thoughts  (NEW)
  validatedThoughts = filter validated  (NEW)
  // Add validated thoughts to taskGraph nodes (NEW)
  planRes = call tool-plan (MODIFIED: add validated_thoughts to payload)
  if final_answer: observer validate
  if call_tool: execute tool
  observer validate (MODIFIED: include validated_thoughts)
```
**Specific changes in interaction.service.ts**:
a) Add a `validatedThoughts` array variable alongside `toolResults`, `wallsHit`, etc. (around line 640).
b) Before the `planRes` call (line 739), add:
   - Call `POST ${RESPONSE_URL}/internal/thought/generate` with `{ user_message, tool_results: toolResults.slice(-5), upfront_plan, memory_context, rules, walls_hit: wallsHit, observer_feedback }`
   - Call `POST ${LOGIC_ENGINE_URL}/internal/reason/validate-thoughts` with `{ thoughts: thoughtsRes.data.thoughts, memory_context, rules, walls_hit: wallsHit, tool_results: toolResults.slice(-5) }`
   - Filter to only `validated === true` thoughts
   - Both calls wrapped in try/catch (thought layer is best-effort, never blocks the loop)
c) Modify the `planRes` call (line 739) to include `validated_thoughts` in the payload.
d) Modify `TOOL_PLAN_PROMPT` in service.py to accept and display validated thoughts. Add a section like:
   ```
   ═══ VALIDATED THOUGHTS (from reasoning layer) ═══
   These thoughts have been validated by the logic engine. Consider them when deciding your next action:
   {thoughts_text}
   ```
e) After tool execution, add validated ThoughtNodes to the taskGraph for storage. Each validated thought becomes a ThoughtNode with an `INFORMS` edge to the subsequent ActionNode.
f) Publish a `ThoughtsValidated` event for the timeline UI:
   ```typescript
   await this.events.publish('ThoughtsValidated', sessionId, {
     thought_count: validatedThoughts.length,
     thoughts: validatedThoughts.map(t => ({ thought: t.thought, confidence: t.confidence })),
     client_message_id: clientMessageId,
   });
   ```
---
#### Step 5: Store only validated thoughts in Neo4j via memory-service
No new endpoint needed on memory-service. The existing `POST /internal/memory/store` already stores ReasoningGraph objects. When the gateway stores the task graph (already done at lines 1142-1149 and 1204-1215), the ThoughtNodes will be included automatically because they are added to the `taskGraph` object's nodes array.
The key constraint: **never add unvalidated thoughts to the taskGraph**. The filtering happens in interaction.service.ts before any node is created.
**File: `/Users/stevetran/oasis-cognition/services/memory-service/service.py`**
In `_store_graph_nodes`, ThoughtNodes will be handled automatically since the method iterates over all `graph.nodes`. No change needed here.
---
#### Step 6: Make teaching use validated thoughts only
**File: `/Users/stevetran/oasis-cognition/apps/api-gateway/src/interaction/interaction.service.ts`**
The self-teaching actions (teach_rule, update_rule, delete_rule at lines 872-944) currently create rules from whatever the LLM proposes. To integrate validated thoughts:
- When the LLM outputs a `teach_rule` action, check if the rule's content aligns with any validated thought from the current iteration. If it contradicts a rejected thought's rejection_reason, log a warning.
- This is a soft integration: validated thoughts provide context but do not block teaching. The existing teaching validation (via teaching-service) already handles hard validation.
No code change strictly required here, but the `validated_thoughts` context injected into the tool-plan prompt (Step 4d) will naturally cause the LLM to propose better-grounded rules.
---
#### Step 7: Enhance observer to receive and use validated thoughts
**File: `/Users/stevetran/oasis-cognition/services/observer-service/main.py`**
Modify `ValidateRequest` to accept an optional `validated_thoughts: list[dict[str, Any]] = []` field.
Modify the observer's `validate` function to pass `validated_thoughts` to the logic engine's `validate_goal` call. The logic engine can use these to make better judgments about whether the goal is met (e.g., if the agent followed validated thoughts, confidence is higher).
**File: `/Users/stevetran/oasis-cognition/services/logic-engine/service.py`**
Modify `validate_goal` to accept optional `validated_thoughts` parameter. When computing confidence:
- If the agent's actions align with validated thoughts, boost confidence by 0.05 per aligned thought.
- If the agent ignored all validated thoughts and failed, reduce confidence.
**File: `/Users/stevetran/oasis-cognition/apps/api-gateway/src/interaction/interaction.service.ts`**
Pass `validated_thoughts` to both observer validate calls (the one inside `final_answer` at line 769 and the post-tool one at line 1129).
---
#### Step 8: Modify TOOL_PLAN_PROMPT to receive validated thoughts
**File: `/Users/stevetran/oasis-cognition/services/response-generator/service.py`**
In `plan_tool_calls` method (line 580), accept a new parameter `validated_thoughts: list[dict[str, Any]] | None = None`.
In the prompt building section (around line 603-674), add a new block after walls and before the user request:
```python
if validated_thoughts:
    thoughts_text = "\n".join(
        f"  - [{t.get('confidence', 0):.1f}] {t.get('thought', '')}: {t.get('rationale', '')}"
        for t in validated_thoughts
    )
    parts.append(
        "═══ VALIDATED THOUGHTS (from reasoning layer — consider these) ═══\n"
        f"{thoughts_text}\n"
    )
```
**File: `/Users/stevetran/oasis-cognition/services/response-generator/main.py`**
Add `validated_thoughts: list[dict[str, Any]] | None = None` to `ToolPlanRequest` model. Pass it through to `generator.plan_tool_calls`.
---
### Performance Considerations
- **Latency**: Thought generation adds one LLM call per iteration. To mitigate: (a) use a faster/smaller model for thought generation if available, (b) skip thought generation on iteration 0 (the upfront plan already covers initial thoughts), (c) skip if the previous iteration succeeded (no need to rethink after success).
- **Skip conditions**: In interaction.service.ts, only call thought generation when `iteration > 0 AND (last tool failed OR observer gave feedback)`. This avoids unnecessary LLM calls on happy-path iterations.
- **Timeout**: Use a shorter timeout (15-20s) for thought generation since it should be a quick, structured JSON response.
---
### Memory Pollution Prevention
The primary guard is in interaction.service.ts: **only thoughts with `validated === true` from the logic engine response are ever added to the taskGraph**. The logic engine's `validate_thoughts` acts as the gatekeeper. Specifically:
1. Raw thoughts from response-generator are NEVER stored anywhere.
2. Only thoughts that pass `validate_thoughts` (returned with `validated: true`) are added to `validatedThoughts`.
3. Only items in `validatedThoughts` are converted to ThoughtNodes and added to `taskGraph`.
4. The taskGraph is what gets stored via `POST /internal/memory/store`.
There is no path for an unvalidated thought to reach Neo4j.
---
### Critical Files for Implementation
- `/Users/stevetran/oasis-cognition/apps/api-gateway/src/interaction/interaction.service.ts` - Core integration point: inject thought generation + validation into the tool loop before tool execution, pass validated thoughts to all downstream calls
- `/Users/stevetran/oasis-cognition/services/response-generator/service.py` - Add `generate_thoughts()` method with THOUGHT_GENERATION_PROMPT, modify `plan_tool_calls()` to accept and inject validated_thoughts into prompt
- `/Users/stevetran/oasis-cognition/services/logic-engine/service.py` - Add `validate_thoughts()` method with symbolic validation (wall check, rule alignment, memory grounding, dedup, confidence threshold)
- `/Users/stevetran/oasis-cognition/packages/reasoning-schema/enums.py` - Add THOUGHT NodeType and INFORMS EdgeType to the schema enums
- `/Users/stevetran/oasis-cognition/packages/reasoning-schema/models.py` - Add ThoughtNode class following existing ReasoningNode pattern
agentId: aec4eebdded2115cb (for resuming to continue this agent's work if needed)
<usage>total_tokens: 109708
tool_uses: 18
duration_ms: 143352</usage>