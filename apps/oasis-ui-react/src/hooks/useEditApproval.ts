import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { OASIS_BASE_URL } from '@/lib/constants';
import { applyApprovalEvent, parsePending, type PendingEdit } from '@/lib/edit-approval';

const NO_PENDING: PendingEdit[] = [];
const base = (sid: string) => `${OASIS_BASE_URL}/api/v1/sessions/${encodeURIComponent(sid)}/edit-approval`;

/**
 * The chat's "Review edits" setting and the changes waiting for approval. Read from the
 * server when the chat opens (a waiting change shows again after a reload) and kept current
 * from the EditApprovalRequested / EditApprovalResolved events (applyEvent).
 */
export function useEditApproval(sessionId: string | null | undefined) {
  // Kept with the chat it belongs to: after a chat switch the old chat's state is never shown.
  const [held, setHeld] = useState<{ sid: string; available: boolean; enabled: boolean; pending: PendingEdit[] } | null>(null);
  const sessionRef = useRef(sessionId);
  const mine = held && held.sid === sessionId ? held : null;
  const update = useCallback((sid: string, fn: (s: { available: boolean; enabled: boolean; pending: PendingEdit[] }) => Partial<{ available: boolean; enabled: boolean; pending: PendingEdit[] }>) => {
    setHeld((prev) => {
      const cur = prev && prev.sid === sid ? prev : { sid, available: false, enabled: false, pending: [] as PendingEdit[] };
      return { ...cur, ...fn(cur) };
    });
  }, []);

  useEffect(() => {
    sessionRef.current = sessionId;
    if (!sessionId) return;
    let stopped = false;
    void axios.get(base(sessionId), { timeout: 15_000 }).then((res) => {
      if (stopped) return;
      const fromServer = parsePending(res.data?.pending);
      // Events that came while this was loading stay; the server's list fills in the rest.
      update(sessionId, (cur) => ({
        available: true,
        enabled: res.data?.enabled === true,
        pending: [...cur.pending, ...fromServer.filter((p) => !cur.pending.some((x) => x.approval_id === p.approval_id))],
      }));
    }).catch(() => { /* not served here (older gateway): the setting stays hidden */ });
    return () => { stopped = true; };
  }, [sessionId, update]);

  const applyEvent = useCallback((event: { event_type?: string; session_id?: string; payload?: unknown }) => {
    if (event.event_type !== 'EditApprovalRequested' && event.event_type !== 'EditApprovalResolved') return;
    if (!event.session_id || event.session_id !== sessionRef.current) return;
    const sid = event.session_id;
    update(sid, (cur) => ({ pending: applyApprovalEvent(cur.pending, event) }));
  }, [update]);

  const setEnabled = useCallback(async (on: boolean) => {
    const sid = sessionRef.current;
    if (!sid) return;
    update(sid, () => ({ enabled: on }));
    try {
      const res = await axios.put(base(sid), { enabled: on }, { timeout: 15_000 });
      update(sid, () => ({ enabled: res.data?.enabled === true }));
    } catch {
      update(sid, () => ({ enabled: !on }));
    }
  }, [update]);

  /** Approve or reject; false when the change was no longer waiting (it is removed either way). */
  const decide = useCallback(async (approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<boolean> => {
    const sid = sessionRef.current;
    if (!sid) return false;
    let ok = true;
    try {
      await axios.post(`${base(sid)}/${encodeURIComponent(approvalId)}`, { decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }, { timeout: 15_000 });
    } catch (err) {
      // 404: answered elsewhere, timed out or the turn stopped. Anything else: keep the card to retry.
      if (!(axios.isAxiosError(err) && err.response?.status === 404)) return false;
      ok = false;
    }
    update(sid, (cur) => ({ pending: cur.pending.filter((p) => p.approval_id !== approvalId) }));
    return ok;
  }, [update]);

  return {
    available: mine?.available ?? false,
    enabled: mine?.enabled ?? false,
    pending: mine?.pending ?? NO_PENDING,
    setEnabled, applyEvent, decide,
  };
}
