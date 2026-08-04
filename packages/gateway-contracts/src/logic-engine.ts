import { z } from 'zod';

export const ReasonRequest = z.object({
  reasoning_graph: z.record(z.unknown()),
  memory_context: z.array(z.record(z.unknown())),
  memory_stale_hint: z.string().nullable().optional(),
});

export const ReasonResponse = z.object({
  decision_tree: z.record(z.unknown()),
});

export const ValidateGoalRequest = z.object({
  task_graph: z.record(z.unknown()),
  success_criteria: z.array(z.string()).nullable().optional(),
  plan_steps: z.array(z.record(z.unknown())).nullable().optional(),
  memory_context: z.array(z.record(z.unknown())),
  rules: z.array(z.record(z.unknown())),
  memory_stale_hint: z.string().nullable().optional(),
  validated_thoughts: z.array(z.record(z.unknown())).nullable().optional(),
  proposed_final_answer: z.string().nullable().optional(),
});

export const ValidateGoalResponse = z.object({
  goal_met: z.boolean(),
  feedback: z.string(),
  confidence: z.number(),
  revise_plan: z.boolean().optional(),
});

export const ValidateThoughtsRequest = z.object({
  thoughts: z.array(z.record(z.unknown())),
  memory_context: z.array(z.record(z.unknown())),
  rules: z.array(z.record(z.unknown())),
  walls_hit: z.array(z.string()),
  tool_results: z.array(z.record(z.unknown())),
});

export const ValidateThoughtsResponse = z.object({
  validated_thoughts: z.array(z.record(z.unknown())),
});

export const AssessFeasibilityRequest = z.object({
  user_goal: z.string(),
  memory_context: z.array(z.record(z.unknown())),
  walls: z.array(z.string()),
});

export const AssessFeasibilityResponse = z.object({
  feasible: z.boolean(),
  feedback: z.string().optional(),
});
