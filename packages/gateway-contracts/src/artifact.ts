import { z } from 'zod';

export const LinkArtifactRequest = z.object({
  artifact_id: z.string(),
});

export const LinkArtifactResponse = z.object({
  ok: z.boolean(),
});

export const LinkChatRequest = z.object({
  session_id: z.string(),
});

export const LinkChatResponse = z.object({
  ok: z.boolean(),
});
