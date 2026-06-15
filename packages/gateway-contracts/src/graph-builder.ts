import { z } from 'zod';
import { SemanticStructure } from './types';

export const BuildRequest = z.object({
  semantic_structure: z.record(z.unknown()),
  session_id: z.string(),
});

export const BuildTaskRequest = z.object({
  semantic_structure: z.record(z.unknown()),
  plan_steps: z.array(z.record(z.unknown())),
  session_id: z.string(),
  tool_results: z.array(z.record(z.unknown())).nullable().optional(),
  existing_graph: z.record(z.unknown()).nullable().optional(),
});

export const GraphBuilderResponse = z.object({
  graph: z.record(z.unknown()),
});
