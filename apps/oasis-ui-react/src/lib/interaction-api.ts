import { parseNdjsonPayload } from '@oasis/ui-kit';
import type { InteractionResponsePayload } from '@oasis/ui-kit';

export type { InteractionResponsePayload };

/**
 * POST /api/v1/interaction streams newline-delimited JSON: keepalive lines
 * {"_oasis_keepalive":true} and a final InteractionResponse object (or _oasis_error).
 */
export async function postInteractionNdjson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<InteractionResponsePayload> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const ct = res.headers.get('content-type') || '';
  const text = await res.text();

  if (!res.ok) {
    let msg = text || res.statusText;
    try {
      const j = JSON.parse(text) as { error?: string; detail?: unknown };
      if (j.detail != null) {
        msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      } else if (j.error) {
        msg = j.error;
      }
    } catch {
      /* plain text body */
    }
    throw new Error(msg);
  }

  if (!ct.includes('ndjson')) {
    return JSON.parse(text) as InteractionResponsePayload;
  }

  return parseNdjsonPayload(text);
}
