/**
 * POST /api/v1/interaction accepts work and returns immediately. The response
 * is completed asynchronously on the session timeline SSE stream.
 */
export interface InteractionAccepted {
  session_id: string;
}

export async function postInteraction(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<InteractionAccepted> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

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

  const data = JSON.parse(text) as Partial<InteractionAccepted>;
  if (typeof data.session_id !== 'string' || !data.session_id) {
    throw new Error('Interaction accepted response did not include session_id');
  }
  return { session_id: data.session_id };
}
