/**
 * Changes waiting for the user's approval in this chat (the gateway's per-edit approval gate,
 * apps/api-gateway/src/interaction/edit-approval.ts). Read from GET /sessions/:id/edit-approval
 * and kept current from the EditApprovalRequested / EditApprovalResolved events.
 */

export interface PendingEdit {
  approval_id: string;
  session_id?: string;
  tool: 'edit_file' | 'write_file';
  path: string;
  diff: string;
  truncated?: boolean;
  reasoning?: string;
  created_at: string;
  expires_at: string;
}

function asPending(p: unknown): PendingEdit | null {
  if (!p || typeof p !== 'object') return null;
  const e = p as Record<string, unknown>;
  if (typeof e.approval_id !== 'string' || typeof e.diff !== 'string' || typeof e.expires_at !== 'string') return null;
  if (e.tool !== 'edit_file' && e.tool !== 'write_file') return null;
  return {
    approval_id: e.approval_id,
    tool: e.tool,
    path: typeof e.path === 'string' ? e.path : '',
    diff: e.diff,
    truncated: e.truncated === true,
    ...(typeof e.reasoning === 'string' && e.reasoning ? { reasoning: e.reasoning } : {}),
    created_at: typeof e.created_at === 'string' ? e.created_at : e.expires_at,
    expires_at: e.expires_at,
    ...(typeof e.session_id === 'string' ? { session_id: e.session_id } : {}),
  };
}

/** The pending list from the server, without expired or malformed entries. */
export function parsePending(raw: unknown, now = Date.now()): PendingEdit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asPending).filter((p): p is PendingEdit => !!p && Date.parse(p.expires_at) > now);
}

/**
 * One event applied to the list. Requested adds (once), Resolved removes; any other event is
 * ignored. Replayed backlog events are safe: a change already resolved or expired stays gone.
 */
export function applyApprovalEvent(
  list: PendingEdit[],
  event: { event_type?: string; payload?: unknown },
  now = Date.now(),
): PendingEdit[] {
  const live = list.filter((p) => Date.parse(p.expires_at) > now);
  if (event.event_type === 'EditApprovalRequested') {
    const p = asPending(event.payload);
    if (!p || Date.parse(p.expires_at) <= now || live.some((x) => x.approval_id === p.approval_id)) return live.length === list.length ? list : live;
    return [...live, p];
  }
  if (event.event_type === 'EditApprovalResolved') {
    const id = (event.payload as { approval_id?: unknown } | undefined)?.approval_id;
    const next = live.filter((p) => p.approval_id !== id);
    return next.length === list.length ? list : next;
  }
  return list;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'file' | 'context';

/** Each line of a unified diff with how to colour it. */
export function diffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  return diff.split('\n').map((text) => {
    if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'file' as const, text };
    if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
    if (text.startsWith('+')) return { kind: 'add' as const, text };
    if (text.startsWith('-')) return { kind: 'del' as const, text };
    return { kind: 'context' as const, text };
  });
}

/** "+12 −3" for a change's header. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diffLines(diff)) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** "9 min left" until the change stops waiting. */
export function timeLeft(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return 'expired';
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? 'under a minute left' : `${min} min left`;
}
