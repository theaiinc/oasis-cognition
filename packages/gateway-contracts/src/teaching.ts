import { z } from 'zod';

export const ValidateRequest = z.object({
  user_message: z.string(),
  semantic_structure: z.record(z.unknown()).nullable().optional(),
});

export const ValidateResponse = z.object({
  validation: z.record(z.unknown()),
});

export const ContinueRequest = z.object({
  user_message: z.string(),
  assertion: z.record(z.unknown()),
  search_query: z.string(),
  prior_validation: z.record(z.unknown()).nullable().optional(),
});

export const ContinueResponse = z.object({
  validation: z.record(z.unknown()),
});
