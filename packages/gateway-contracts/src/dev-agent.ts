import { z } from 'zod';

// ── Snapshot ───────────────────────────────────────────────────────────

export const CreateSnapshotRequest = z.object({
  session_id: z.string(),
});

export const CreateSnapshotResponse = z.object({
  snapshot_id: z.string(),
  ok: z.boolean(),
});

// ── Apply ──────────────────────────────────────────────────────────────

export const ApplyRequest = z.object({
  worktree_id: z.string(),
});

export const ApplyResponse = z.object({
  ok: z.boolean(),
});

// ── Worktree Delete ────────────────────────────────────────────────────

export const DeleteWorktreeResponse = z.object({
  ok: z.boolean(),
});
