/** Shape returned by POST /api/v1/interaction (final NDJSON line). */
export interface InteractionResponsePayload {
  session_id: string;
  response: string;
  reasoning_graph: Record<string, unknown>;
  confidence: number;
  reasoning_trace: string[];
  conclusion?: string;
  route?: string;
  clarifying_questions?: string[];
}

/**
 * Parse raw NDJSON text into an {@link InteractionResponsePayload}.
 *
 * Iterates lines, skips keepalives (`_oasis_keepalive`), throws on
 * `_oasis_error`, and returns the last valid payload object.
 */
export function parseNdjsonPayload(text: string): InteractionResponsePayload {
  let last: InteractionResponsePayload | null = null;

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj._oasis_keepalive) continue;

    if (obj._oasis_error) {
      const b = obj.body as { detail?: unknown; error?: string } | undefined;
      let msg = b?.error || 'Interaction failed';
      if (b?.detail != null) {
        msg = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail);
      } else if (b && typeof b === 'object' && !b.detail && !b.error) {
        msg = JSON.stringify(b);
      }
      throw new Error(msg);
    }

    last = obj as unknown as InteractionResponsePayload;
  }

  if (!last) throw new Error('Empty interaction response');
  return last;
}
