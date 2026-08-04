import { z } from 'zod';
import { DecisionTree, SemanticStructure } from './types';

// ── Chat (casual route) ────────────────────────────────────────────────

export const ChatRequest = z.object({
  user_message: z.string(),
  context: z.record(z.unknown()).nullable().optional(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
});

export const ChatResponse = z.object({
  response: z.string(),
  confidence: z.number().optional(),
  reasoning_graph: z.record(z.unknown()).optional(),
  reasoning_trace: z.array(z.string()).optional(),
});

// ── Decision ───────────────────────────────────────────────────────────

export const DecisionRequest = z.object({
  thoughts: z.union([z.array(z.record(z.unknown())), z.string()]),
  user_message: z.string(),
  context: z.record(z.unknown()).nullable().optional(),
  memory_context: z.array(z.record(z.unknown())).nullable().optional(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
});

export const DecisionResponse = z.object({
  decision: z.record(z.unknown()),
});

// ── Tool Plan ──────────────────────────────────────────────────────────

export const ToolPlanRequest = z.object({
  user_message: z.string(),
  tool_results: z.array(z.record(z.unknown())).nullable().optional(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
  upfront_plan: z.record(z.unknown()).nullable().optional(),
  active_step_index: z.number().int().nullable().optional(),
  active_step_description: z.string().nullable().optional(),
  observer_feedback: z.string().nullable().optional(),
  knowledge_summary: z.string().nullable().optional(),
  memory_context: z.array(z.record(z.unknown())).nullable().optional(),
  rules: z.array(z.record(z.unknown())).nullable().optional(),
  memory_stale_hint: z.string().nullable().optional(),
  walls_hit: z.array(z.string()).nullable().optional(),
  task_graph: z.record(z.unknown()).nullable().optional(),
  validated_thoughts: z.array(z.record(z.unknown())).nullable().optional(),
  free_thoughts: z.string().nullable().optional(),
  active_worktree_id: z.string().nullable().optional(),
  tool_history_digest: z.array(z.string()).nullable().optional(),
  artifact_search_results: z.array(z.record(z.unknown())).nullable().optional(),
  artifact_context: z.string().nullable().optional(),
  model_override: z.string().nullable().optional(),
  rule_packs_to_inject: z.array(z.string()).nullable().optional(),
  max_tokens: z.number().int().nullable().optional(),
  context_window_override: z.number().int().nullable().optional(),
  context_output_reserve: z.number().min(0).max(1).nullable().optional(),
});

// The endpoint returns the planner's action object directly, e.g.
// { action: "tool_call", tool: "...", arguments: {...} }.
export const ToolPlanResponse = z.record(z.unknown());

// ── Plan Tool Use ──────────────────────────────────────────────────────

export const PlanToolUseRequest = z.object({
  user_message: z.string(),
  semantic_structure: z.record(z.unknown()).nullable().optional(),
  memory_context: z.array(z.record(z.unknown())).nullable().optional(),
  rules: z.array(z.record(z.unknown())).nullable().optional(),
  memory_stale_hint: z.string().nullable().optional(),
  free_thoughts: z.string().nullable().optional(),
  observer_feedback: z.string().nullable().optional(),
  previous_plan: z.record(z.unknown()).nullable().optional(),
  replan_after_observer: z.boolean(),
  artifact_search_results: z.array(z.record(z.unknown())).nullable().optional(),
  artifact_context: z.string().nullable().optional(),
});

// /internal/plan/tool-use also returns the plan object directly.
export const PlanToolUseResponse = z.record(z.unknown());

// ── Thought Generate ───────────────────────────────────────────────────

export const ThoughtGenerateRequest = z.object({
  user_message: z.string(),
  tool_results: z.array(z.record(z.unknown())).nullable().optional(),
  upfront_plan: z.record(z.unknown()).nullable().optional(),
  memory_context: z.array(z.record(z.unknown())).nullable().optional(),
  rules: z.array(z.record(z.unknown())).nullable().optional(),
  walls_hit: z.array(z.string()).nullable().optional(),
  observer_feedback: z.string().nullable().optional(),
});

export const ThoughtGenerateResponse = z.object({
  thoughts: z.record(z.unknown()),
});

// ── Punt Check ─────────────────────────────────────────────────────────

export const PuntCheckRequest = z.object({
  user_goal: z.string(),
  proposed_answer: z.string(),
  has_code_edits: z.boolean(),
});

export const PuntCheckResponse = z.object({
  is_punt: z.boolean(),
  score: z.number().optional(),
});

// ── Route ──────────────────────────────────────────────────────────────

export const RouteRequest = z.object({
  user_message: z.string(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
});

export const RouteResponse = z.object({
  route: z.string(),
  semantic_structure: SemanticStructure.optional(),
});

// ── Tool Summarize ─────────────────────────────────────────────────────

export const ToolSummarizeRequest = z.object({
  user_message: z.string(),
  tool_results: z.array(z.record(z.unknown())),
});

export const ToolSummarizeResponse = z.object({
  summary: z.string(),
});

// ── JSON Repair ────────────────────────────────────────────────────────

export const JsonRepairRequest = z.object({
  malformed_json: z.string(),
});

export const JsonRepairResponse = z.object({
  repaired: z.record(z.unknown()),
});

// ── Tool Plan Parse Raw ────────────────────────────────────────────────

export const ToolPlanParseRawRequest = z.object({
  raw: z.string(),
});

export const ToolPlanParseRawResponse = z.object({
  parsed: z.record(z.unknown()),
});

// ── Summarize History ──────────────────────────────────────────────────

export const SummarizeHistoryRequest = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
});

export const SummarizeHistoryResponse = z.object({
  summary: z.string(),
});

// ── Transcript Cleanup ─────────────────────────────────────────────────

export const TranscriptCleanupRequest = z.object({
  raw_text: z.string(),
});

export const TranscriptCleanupResponse = z.object({
  cleaned: z.string(),
});

// ── Self-Teaching Plan ─────────────────────────────────────────────────

export const SelfTeachingPlanRequest = z.object({
  topic: z.string(),
  llm_thoughts: z.array(z.record(z.unknown())),
  logic_solution: z.record(z.unknown()),
  user_comment: z.string().nullable().optional(),
  prior_plan: z.record(z.unknown()).nullable().optional(),
});

export const SelfTeachingPlanResponse = z.object({
  plan: z.record(z.unknown()),
});

// ── Thought Reason ─────────────────────────────────────────────────────

export const ThoughtReasonRequest = z.object({
  user_message: z.string(),
  context: z.record(z.unknown()).nullable().optional(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
  tool_results: z.array(z.record(z.unknown())).nullable().optional(),
  observer_feedback: z.string().nullable().optional(),
});

export const ThoughtReasonResponse = z.object({
  reasoning: z.record(z.unknown()),
});
