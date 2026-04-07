/**
 * Parse @[Name](id) mention tokens from message text.
 * Returns an array of segments for rendering.
 */
export interface MentionSegment {
  type: 'text' | 'mention';
  content: string;
  artifactId?: string;
  artifactName?: string;
}

export function parseMessageMentions(text: string): MentionSegment[] {
  // regex to match @[Artifact Name](artifact_id)
  const mentionRegex = /@\[([^\]]+)\]\(([a-f0-9-]+)\)/g;
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'mention',
      content: match[1],
      artifactName: match[1],
      artifactId: match[2],
    });
    lastIndex = mentionRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

/**
 * Extract all mentioned artifact IDs from a message text.
 */
export function extractMentionedArtifactIds(text: string): string[] {
  const mentionRegex = /@\[([^\]]+)\]\(([a-f0-9-]+)\)/g;
  const ids: string[] = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    ids.push(match[2]);
  }
  return ids;
}

/**
 * Strip mention markup for display purposes (shows just the name with @ prefix).
 */
export function stripMentionMarkup(text: string): string {
  return text.replace(/@\[([^\]]+)\]\([a-f0-9-]+\)/g, '@$1');
}
