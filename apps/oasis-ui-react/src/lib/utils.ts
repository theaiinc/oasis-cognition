import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Suffix for assistant rows so they never share `id` with the user row (same `client_message_id` from the API). */
export const ASSISTANT_MESSAGE_ID_SUFFIX = '-assistant';

export function assistantMessageId(clientMessageId: string): string {
  return `${clientMessageId}${ASSISTANT_MESSAGE_ID_SUFFIX}`;
}

/** Timeline / SSE events are keyed by `client_message_id`; assistant bubble ids include {@link ASSISTANT_MESSAGE_ID_SUFFIX}. */
export function timelineClientKeyForMessage(m: { id: string; sender: string }): string {
  if (m.sender === 'assistant' && m.id.endsWith(ASSISTANT_MESSAGE_ID_SUFFIX)) {
    return m.id.slice(0, -ASSISTANT_MESSAGE_ID_SUFFIX.length);
  }
  return m.id;
}
