import { z } from 'zod';
import { MemoryEntry, ReasoningGraph } from './types';

// ── Memory Query ───────────────────────────────────────────────────────

export const MemoryQueryRequest = z.object({
  q: z.string(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  session_id: z.string().optional(),
  project_id: z.string().optional(),
});

export const MemoryQueryResponse = z.object({
  query: z.string(),
  count: z.number(),
  results: z.array(MemoryEntry),
  stale_count: z.number(),
  stale_hint: z.string().nullable(),
});

// ── Store Graph ────────────────────────────────────────────────────────

export const StoreGraphRequest = z.object({
  reasoning_graph: z.record(z.unknown()),
  user_id: z.string(),
  session_id: z.string().optional(),
  walls: z.array(z.string()).optional(),
  project_id: z.string().optional(),
});

export const StoreGraphResponse = z.object({
  status: z.literal('ok'),
  graph_id: z.string(),
});

// ── Store Not Achievable ───────────────────────────────────────────────

export const StoreNotAchievableRequest = z.object({
  goal: z.string(),
  reason: z.string(),
  suggestion: z.string(),
  session_id: z.string().optional(),
  project_id: z.string().optional(),
  user_id: z.string(),
});

// ── Rules ──────────────────────────────────────────────────────────────

export const RulesListResponse = z.object({
  rules: z.array(z.record(z.unknown())),
  storage: z.string().nullable().optional(),
});

export const RulesGraphResponse = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    condition: z.string().optional(),
    conclusion: z.string().optional(),
    confidence: z.number().optional(),
    created_at: z.string().optional(),
  })),
  edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
    edge_type: z.string().optional(),
    shared_concepts: z.array(z.string()).optional(),
  })),
});

// ── Nodes by Tier ──────────────────────────────────────────────────────

export const NodesByTierRequest = z.object({
  tier: z.string(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const NodesByTierResponse = z.object({
  nodes: z.array(z.record(z.unknown())),
});

// ── Projects rules ─────────────────────────────────────────────────────

export const ProjectRulesRequest = z.object({
  project_id: z.string(),
});

export const ProjectRulesResponse = z.object({
  rules: z.array(z.record(z.unknown())),
});

// ── Teaching pending ───────────────────────────────────────────────────

export const TeachingPendingResponse = z.object({
  pending: z.any(),
});

export const TeachingPendingDeleteResponse = z.object({
  ok: z.boolean(),
});

// ── Rules Snapshots ────────────────────────────────────────────────────

export const SnapshotRulesRequest = z.object({
  session_id: z.string(),
});

export const SnapshotRulesResponse = z.object({
  snapshot_id: z.string(),
});

export const RestoreRulesRequest = z.object({
  snapshot_id: z.string(),
});
