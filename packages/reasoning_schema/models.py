"""Core data models for the reasoning graph."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, model_validator

from packages.reasoning_schema.enums import EdgeType, GraphTier, MemoryType, NODE_TYPE_DEFAULT_TIER, NodeSource, NodeType


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class ReasoningNode(BaseModel):
    """A single node in the reasoning graph."""

    id: str = Field(default_factory=_uuid)
    node_type: NodeType
    tier: GraphTier | None = None  # auto-assigned from node_type if not set
    title: str
    description: str = ""
    attributes: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 0.0
    source: NodeSource = NodeSource.SYSTEM
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    @model_validator(mode="after")
    def _set_default_tier(self) -> "ReasoningNode":
        if self.tier is None:
            self.tier = NODE_TYPE_DEFAULT_TIER.get(self.node_type, GraphTier.FOUNDATIONAL)
        return self


class ProblemNode(ReasoningNode):
    node_type: NodeType = NodeType.PROBLEM
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "problem_type": "",
        "system_component": "",
        "metric": "",
    })


class TriggerNode(ReasoningNode):
    node_type: NodeType = NodeType.TRIGGER


class HypothesisNode(ReasoningNode):
    node_type: NodeType = NodeType.HYPOTHESIS
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "hypothesis": "",
        "category": "",
    })


class EvidenceNode(ReasoningNode):
    node_type: NodeType = NodeType.EVIDENCE
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "metric": "",
        "value": None,
    })


class ConstraintNode(ReasoningNode):
    node_type: NodeType = NodeType.CONSTRAINT
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "rule": "",
    })


class ConclusionNode(ReasoningNode):
    node_type: NodeType = NodeType.CONCLUSION
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "result": "",
    })


class MemoryNode(ReasoningNode):
    node_type: NodeType = NodeType.MEMORY
    memory_type: MemoryType = MemoryType.EPISODIC


# ── Task graph nodes (tool_use multi-agent) ────────────────────────────────────


class GoalNode(ReasoningNode):
    """User's stated goal for a tool_use task."""
    node_type: NodeType = NodeType.GOAL
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "success_criteria": "",
        "intent": "",
    })


class PlanNode(ReasoningNode):
    """High-level plan step from Planning Agent."""
    node_type: NodeType = NodeType.PLAN
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "step_index": 0,
        "description": "",
    })


class ActionNode(ReasoningNode):
    """Tool call executed by Execution Agent."""
    node_type: NodeType = NodeType.ACTION
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "tool": "",
        "output": "",
        "success": False,
    })


class CompletionNode(ReasoningNode):
    """Observer's validation result."""
    node_type: NodeType = NodeType.COMPLETION
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "goal_met": False,
        "feedback": "",
    })


class ThoughtNode(ReasoningNode):
    """A validated thought/hypothesis from the Graph-of-Thought layer."""
    node_type: NodeType = NodeType.THOUGHT
    attributes: dict[str, Any] = Field(default_factory=lambda: {
        "thought": "",
        "rationale": "",
        "confidence": 0.0,
        "validated": False,
    })


class ToolUsePlan(BaseModel):
    """Structured plan from Planning Agent for Execution Agent."""

    steps: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    plan_graph: dict[str, Any] | None = None  # ReasoningGraph as dict


class GoalValidationResult(BaseModel):
    """Output of logic engine validation mode."""

    goal_met: bool = False
    feedback: str = ""
    confidence: float = 0.0
    updated_graph: dict[str, Any] | None = None
    # When true, gateway should regenerate the upfront plan and reset active step to 0.
    revise_plan: bool = False


class ReasoningEdge(BaseModel):
    """An edge connecting two nodes in the reasoning graph."""

    source_node: str
    target_node: str
    edge_type: EdgeType
    weight: float = 1.0


class ReasoningGraph(BaseModel):
    """Complete reasoning graph for a session."""

    id: str = Field(default_factory=_uuid)
    session_id: str = ""
    nodes: list[ReasoningNode] = Field(default_factory=list)
    edges: list[ReasoningEdge] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)

    def add_node(self, node: ReasoningNode) -> None:
        self.nodes.append(node)

    def add_edge(self, edge: ReasoningEdge) -> None:
        self.edges.append(edge)

    def get_node(self, node_id: str) -> ReasoningNode | None:
        for node in self.nodes:
            if node.id == node_id:
                return node
        return None

    def get_nodes_by_type(self, node_type: NodeType) -> list[ReasoningNode]:
        return [n for n in self.nodes if n.node_type == node_type]

    def get_nodes_by_tier(self, tier: GraphTier) -> list[ReasoningNode]:
        """Return all nodes belonging to a specific tier."""
        return [n for n in self.nodes if n.tier == tier]

    def get_nodes_by_type_and_tier(self, node_type: NodeType, tier: GraphTier) -> list[ReasoningNode]:
        """Return nodes matching both a type and a tier."""
        return [n for n in self.nodes if n.node_type == node_type and n.tier == tier]

    def get_edges_from(self, node_id: str) -> list[ReasoningEdge]:
        return [e for e in self.edges if e.source_node == node_id]

    def get_edges_to(self, node_id: str) -> list[ReasoningEdge]:
        return [e for e in self.edges if e.target_node == node_id]


class MemoryEntry(BaseModel):
    """A stored memory entry."""

    memory_id: str = Field(default_factory=_uuid)
    memory_type: MemoryType
    content: dict[str, Any] = Field(default_factory=dict)
    graph_reference: str | None = None
    user_reference: str | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


class SemanticStructure(BaseModel):
    """Output of semantic interpretation."""

    problem: str = ""
    trigger: str = ""
    entities: dict[str, Any] = Field(default_factory=dict)
    intent: str = ""
    context: dict[str, Any] = Field(default_factory=dict)
    raw_input: str = ""
    route: str = "complex"  # casual | complex | teaching
    is_simple: bool = False  # If True, bypass the tool loop (Fast Path)



class TeachingAssertion(BaseModel):
    """An assertion the user is teaching the system."""

    assertion: str = ""
    category: str = ""  # rule, fact, preference, pattern, codebase_knowledge
    domain: str = ""    # coding, business, strategy, etc.
    confidence: float = 0.5
    source: str = "user"
    supporting_context: str = ""
    atomic_rules: list[str] = []  # individual verifiable rules decomposed from the assertion
    is_codebase_specific: bool = False  # if True, route to Knowledge Graph instead of Rules


class ValidationResult(BaseModel):
    """Result of validating a teaching assertion against external sources."""

    assertion: str = ""
    is_validated: bool = False
    web_sources: list[dict[str, Any]] = Field(default_factory=list)
    contradictions: list[str] = Field(default_factory=list)
    clarifying_questions: list[str] = Field(default_factory=list)
    underlying_concept: str = ""
    confidence: float = 0.0
    summary: str = ""


class DecisionTree(BaseModel):
    """Output of the logic engine reasoning."""

    conclusion: str = ""
    confidence: float = 0.0
    hypotheses: list[dict[str, Any]] = Field(default_factory=list)
    reasoning_trace: list[str] = Field(default_factory=list)
    eliminated: list[dict[str, Any]] = Field(default_factory=list)
    graph: ReasoningGraph | None = None
