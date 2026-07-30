import { z } from 'zod';
import { SemanticStructure } from './types';

export const ValidateRequest = z.object({
  user_goal: z.string(),
  semantic_structure: z.record(z.unknown()).nullable().optional(),
  task_graph: z.record(z.unknown()).nullable().optional(),
  tool_results: z.array(z.record(z.unknown())),
  plan: z.record(z.unknown()).nullable().optional(),
  session_id: z.string(),
  memory_context: z.array(z.record(z.unknown())),
  rules: z.array(z.record(z.unknown())),
  memory_stale_hint: z.string().nullable().optional(),
  validated_thoughts: z.array(z.record(z.unknown())),
  proposed_final_answer: z.string().nullable().optional(),
});

export const ValidateResponse = z.object({
  observer_feedback: z.string(),
  goal_met: z.boolean(),
  confidence: z.number(),
});
