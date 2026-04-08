"""Enumerations for the reasoning schema."""

from enum import Enum


class NodeType(str, Enum):
    PROBLEM = "ProblemNode"
    TRIGGER = "TriggerNode"
    HYPOTHESIS = "HypothesisNode"
    EVIDENCE = "EvidenceNode"
    CONSTRAINT = "ConstraintNode"
    ACTION = "ActionNode"
    CONCLUSION = "ConclusionNode"
    MEMORY = "MemoryNode"
    # Task graph nodes for tool_use multi-agent flow
    GOAL = "GoalNode"
    PLAN = "PlanNode"
    COMPLETION = "CompletionNode"
    THOUGHT = "ThoughtNode"
    ARTIFACT = "ArtifactNode"


class EdgeType(str, Enum):
    CAUSES = "CAUSES"
    TRIGGERS = "TRIGGERS"
    SUPPORTS = "SUPPORTS"
    CONTRADICTS = "CONTRADICTS"
    LEADS_TO = "LEADS_TO"
    DERIVED_FROM = "DERIVED_FROM"
    # Task graph edges
    IMPLEMENTS = "IMPLEMENTS"  # plan step implements goal
    EXECUTES = "EXECUTES"  # action executes plan step
    COMPLETES = "COMPLETES"  # completion validates goal
    INFORMS = "INFORMS"  # thought informs a plan step or action


class NodeSource(str, Enum):
    USER = "user"
    SYSTEM = "system"
    MEMORY = "memory"


class MemoryType(str, Enum):
    EPISODIC = "episodic"
    SEMANTIC = "semantic"
    PROCEDURAL = "procedural"


class GraphTier(str, Enum):
    """Distinguishes foundational base knowledge from in-progress agent steps."""
    FOUNDATIONAL = "foundational"  # durable knowledge: evidence, constraints, memories, conclusions
    ACTIVE = "active"              # session-scoped task state: goals, plans, actions, completions


# Default tier assignment per NodeType.  Foundational nodes represent persistent
# knowledge that should never be filtered out early; active nodes represent the
# agent's in-progress workflow state.
NODE_TYPE_DEFAULT_TIER: dict[NodeType, "GraphTier"] = {
    NodeType.PROBLEM: GraphTier.FOUNDATIONAL,
    NodeType.TRIGGER: GraphTier.FOUNDATIONAL,
    NodeType.HYPOTHESIS: GraphTier.FOUNDATIONAL,
    NodeType.EVIDENCE: GraphTier.FOUNDATIONAL,
    NodeType.CONSTRAINT: GraphTier.FOUNDATIONAL,
    NodeType.CONCLUSION: GraphTier.FOUNDATIONAL,
    NodeType.MEMORY: GraphTier.FOUNDATIONAL,
    NodeType.THOUGHT: GraphTier.FOUNDATIONAL,
    NodeType.ARTIFACT: GraphTier.FOUNDATIONAL,
    NodeType.GOAL: GraphTier.ACTIVE,
    NodeType.PLAN: GraphTier.ACTIVE,
    NodeType.ACTION: GraphTier.ACTIVE,
    NodeType.COMPLETION: GraphTier.ACTIVE,
}


class IntentRoute(str, Enum):
    """How the gateway should route an interaction."""
    CASUAL = "casual"       # greetings, small talk → simple LLM chat, no reasoning
    COMPLEX = "complex"     # any hard problem (coding, business, strategy) → full reasoning pipeline
    TEACHING = "teaching"   # user asserting knowledge → validate, search, store
