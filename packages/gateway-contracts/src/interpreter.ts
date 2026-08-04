import { z } from 'zod';
import { SemanticStructure } from './types';

export const InterpretRequest = z.object({
  text: z.string(),
  context: z.record(z.unknown()).nullable().optional(),
  chat_history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).nullable().optional(),
});

export const InterpretResponse = z.object({
  semantic_structure: SemanticStructure.optional(),
  route: z.string().optional(),
});
