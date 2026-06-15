import { z } from 'zod';

// ── Reasoning graph enums ──────────────────────────────────────────────

export const NodeType = z.enum([
  'PROBLEM', 'TRIGGER', 'HYPOTHESIS', 'EVIDENCE', 'CONSTRAINT',
  'ACTION', 'CONCLUSION', 'MEMORY', 'GOAL', 'PLAN', 'COMPLETION',
  'THOUGHT', 'ARTIFACT',
]);

export const EdgeType = z.enum([
  'CAUSES', 'TRIGGERS', 'SUPPORTS', 'CONTRADICTS', 'LEADS_TO',
  'DERIVED_FROM', 'IMPLEMENTS', 'EXECUTES', 'COMPLETES', 'INFORMS',
]);

export const NodeSource = z.enum(['USER', 'SYSTEM', 'MEMORY']);

export const MemoryType = z.enum(['EPISODIC', 'SEMANTIC', 'PROCEDURAL']);

export const GraphTier = z.enum(['FOUNDATIONAL', 'ACTIVE']);

export const IntentRoute = z.enum(['CASUAL', 'COMPLEX', 'TEACHING']);

// ── Shared reasoning models ────────────────────────────────────────────

export const ReasoningNode = z.object({
  id: z.string(),
  node_type: NodeType,
  tier: GraphTier.nullable().optional(),
  title: z.string(),
  description: z.string().default(''),
  attributes: z.record(z.unknown()),
  confidence: z.number().default(0),
  source: NodeSource.default('SYSTEM'),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ReasoningEdge = z.object({
  source_node: z.string(),
  target_node: z.string(),
  edge_type: EdgeType,
  weight: z.number().default(1),
});

export const ReasoningGraph = z.object({
  id: z.string(),
  session_id: z.string().default(''),
  nodes: z.array(ReasoningNode),
  edges: z.array(ReasoningEdge),
  created_at: z.string(),
});

export const MemoryEntry = z.object({
  memory_id: z.string(),
  memory_type: MemoryType,
  content: z.record(z.unknown()),
  graph_reference: z.string().nullable().optional(),
  user_reference: z.string().nullable().optional(),
  tags: z.array(z.string()),
  created_at: z.string(),
});

export const SemanticStructure = z.object({
  problem: z.string().default(''),
  trigger: z.string().default(''),
  entities: z.record(z.unknown()),
  intent: z.string().default(''),
  context: z.record(z.unknown()),
  raw_input: z.string().default(''),
  route: z.string().default('complex'),
  is_simple: z.boolean().default(false),
});

export const DecisionTree = z.object({
  conclusion: z.string().default(''),
  confidence: z.number().default(0),
  hypotheses: z.array(z.record(z.unknown())),
  reasoning_trace: z.array(z.string()),
  eliminated: z.array(z.record(z.unknown())),
  graph: ReasoningGraph.nullable().optional(),
});

export const GoalValidationResult = z.object({
  goal_met: z.boolean().default(false),
  feedback: z.string().default(''),
  confidence: z.number().default(0),
  updated_graph: z.record(z.unknown()).nullable().optional(),
  revise_plan: z.boolean().default(false),
});

export const ToolUsePlan = z.object({
  steps: z.array(z.string()),
  success_criteria: z.array(z.string()),
  plan_graph: z.record(z.unknown()).nullable().optional(),
});
