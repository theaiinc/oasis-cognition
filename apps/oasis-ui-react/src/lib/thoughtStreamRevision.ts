import type { TimelineEvent } from '@/lib/types';

/**
 * Revision for auto-scroll / layout: bumps when thought **content** grows (streaming chunks
 * or a new ThoughtLayer body). Re-sending the same ThoughtLayer text does not bump, so the
 * UI does not keep pinning to the bottom on duplicate layer events.
 */
export function computeThoughtStreamRevision(events: TimelineEvent[]): number {
  let chunks = 0;
  let chars = 0;
  let lastLayerText = '';
  for (const e of events) {
    if (e.event_type === 'ThoughtChunkGenerated') {
      chunks += 1;
      const chunk = (e.payload as Record<string, unknown> | undefined)?.chunk;
      chars += typeof chunk === 'string' ? chunk.length : 0;
    } else if (e.event_type === 'ThoughtLayerGenerated') {
      lastLayerText = String((e.payload as Record<string, unknown> | undefined)?.thoughts ?? '');
    }
  }
  let h = 0;
  const cap = Math.min(lastLayerText.length, 400);
  for (let i = 0; i < cap; i++) {
    h = (h * 31 + lastLayerText.charCodeAt(i)) | 0;
  }
  return chunks * 1_000_000 + chars + lastLayerText.length * 17 + Math.abs(h);
}
