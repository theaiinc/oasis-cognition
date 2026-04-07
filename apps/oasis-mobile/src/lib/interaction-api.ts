import type { InteractionResponsePayload } from '@oasis/ui-kit';
import type { EncryptedPayload, PairingState } from './types';
import { encrypt, decrypt } from './crypto';

/**
 * Callbacks for progressive streaming events from the relay.
 */
export interface StreamCallbacks {
  /** Called with cumulative response text (full_text from ResponseChunkGenerated) */
  onResponseChunk: (fullText: string) => void;
  /** Called with an incremental thinking chunk to append */
  onThinkingChunk: (chunk: string) => void;
  /** Called with a complete thought layer text (replaces accumulated chunks) */
  onThinkingLayer: (fullText: string) => void;
  onThinkingDone: () => void;
  onToolCallStarted: (toolName: string) => void;
  onToolCallCompleted: (toolName: string) => void;
  onFinalResponse: (response: InteractionResponsePayload) => void;
  onError: (error: Error) => void;
}

/**
 * Send an encrypted chat message through the relay and progressively
 * stream back events (thinking, tool calls, response chunks).
 */
export async function streamEncryptedMessage(
  userMessage: string,
  pairing: PairingState,
  callbacks: StreamCallbacks,
  options?: {
    signal?: AbortSignal;
    projectId?: string;
  },
): Promise<void> {
  if (!pairing.paired || !pairing.sessionKey || !pairing.tunnelUrl || !pairing.pairingId) {
    callbacks.onError(new Error('Not paired'));
    return;
  }

  const clientMessageId = Math.random().toString(36).substring(7);

  const context: Record<string, unknown> = {
    source: 'mobile-companion',
    client_message_id: clientMessageId,
    autonomous_mode: false,
    autonomous_max_duration_hours: 0,
  };
  if (options?.projectId) {
    context.project_id = options.projectId;
  }

  const body = JSON.stringify({
    user_message: userMessage,
    session_id: pairing.mobileSessionId,
    context,
  });

  const encrypted = await encrypt(body, pairing.sessionKey, pairing.pairingId);

  let res: Response;
  try {
    res = await fetch(`${pairing.tunnelUrl}/relay/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encrypted),
      signal: options?.signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    callbacks.onError(err);
    return;
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) {
      callbacks.onError(new SessionExpiredError(errData.message || 'Session expired'));
    } else {
      callbacks.onError(new Error(errData.message || errData.error || `Request failed (${res.status})`));
    }
    return;
  }

  // Use ReadableStream to process NDJSON lines progressively
  const reader = res.body?.getReader();
  if (!reader) {
    callbacks.onError(new Error('No response body'));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastPayload: InteractionResponsePayload | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const encryptedLine: EncryptedPayload = JSON.parse(trimmed);
          const decrypted = await decrypt(encryptedLine, pairing.sessionKey!);
          const obj = JSON.parse(decrypted);

          // Skip keepalives
          if (obj._oasis_keepalive) continue;

          // Handle errors
          if (obj._oasis_error) {
            const b = obj.body as { detail?: unknown; error?: string } | undefined;
            let msg = b?.error || 'Interaction failed';
            if (b?.detail != null) {
              msg = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail);
            }
            callbacks.onError(new Error(msg));
            return;
          }

          // Handle streaming events from SSE timeline
          if (obj._mobile_event) {
            handleMobileEvent(obj, callbacks);
            continue;
          }

          // This is an interaction response line (final payload)
          lastPayload = obj as unknown as InteractionResponsePayload;
        } catch {
          // Skip unparseable or undecryptable lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const encryptedLine: EncryptedPayload = JSON.parse(buffer.trim());
        const decrypted = await decrypt(encryptedLine, pairing.sessionKey!);
        const obj = JSON.parse(decrypted);
        if (!obj._oasis_keepalive && !obj._oasis_error && !obj._mobile_event) {
          lastPayload = obj as unknown as InteractionResponsePayload;
        }
      } catch {
        // ignore
      }
    }

    if (lastPayload) {
      callbacks.onFinalResponse(lastPayload);
    } else {
      callbacks.onError(new Error('Empty interaction response'));
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    callbacks.onError(err);
  }
}

/**
 * Handle a mobile streaming event from the relay's SSE timeline subscription.
 */
function handleMobileEvent(
  event: { event_type: string; payload: Record<string, unknown> },
  callbacks: StreamCallbacks,
): void {
  switch (event.event_type) {
    case 'ResponseChunkGenerated': {
      // payload.full_text is cumulative
      const fullText = (event.payload.full_text as string) || '';
      if (fullText) {
        callbacks.onResponseChunk(fullText);
      }
      break;
    }
    case 'ThoughtChunkGenerated': {
      // payload.chunk is incremental — append
      const chunk = (event.payload.chunk as string) || '';
      if (chunk) {
        callbacks.onThinkingChunk(chunk);
      }
      break;
    }
    case 'ThoughtLayerGenerated': {
      // payload.thoughts is the full text for this thought layer
      const thoughts = (event.payload.thoughts as string) || '';
      if (thoughts) {
        callbacks.onThinkingLayer(thoughts);
      }
      break;
    }
    case 'ToolReasoningChunkGenerated': {
      // payload.full_reasoning is cumulative reasoning for this tool iteration
      const reasoning = (event.payload.full_reasoning as string) || '';
      if (reasoning) {
        callbacks.onThinkingLayer(reasoning);
      }
      break;
    }
    case 'ThoughtsValidated': {
      callbacks.onThinkingDone();
      break;
    }
    case 'ToolCallStarted': {
      const toolName = (event.payload.tool_name as string) || (event.payload.name as string) || 'tool';
      callbacks.onToolCallStarted(toolName);
      break;
    }
    case 'ToolCallCompleted': {
      const toolName = (event.payload.tool_name as string) || (event.payload.name as string) || 'tool';
      callbacks.onToolCallCompleted(toolName);
      break;
    }
  }
}

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}
