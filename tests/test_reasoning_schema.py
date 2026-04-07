"""Tests for reasoning schema models."""

from packages.reasoning_schema.enums import EdgeType, GraphTier, NodeType
from packages.reasoning_schema.models import (
    ActionNode,
    GoalNode,
    HypothesisNode,
    PlanNode,
    ProblemNode,
    ReasoningEdge,
    ReasoningGraph,
    TriggerNode,
)


def test_create_problem_node():
    node = ProblemNode(title="API latency", description="slow response")
    assert node.node_type == NodeType.PROBLEM
    assert node.title == "API latency"
    assert node.id  # auto-generated


def test_reasoning_graph_operations():
    graph = ReasoningGraph(session_id="test-session")

    problem = ProblemNode(title="API latency")
    trigger = TriggerNode(title="high concurrency")
    hypothesis = HypothesisNode(title="DB pool exhaustion")

    graph.add_node(problem)
    graph.add_node(trigger)
    graph.add_node(hypothesis)

    graph.add_edge(ReasoningEdge(
        source_node=trigger.id,
        target_node=problem.id,
        edge_type=EdgeType.TRIGGERS,
    ))
    graph.add_edge(ReasoningEdge(
        source_node=problem.id,
        target_node=hypothesis.id,
        edge_type=EdgeType.LEADS_TO,
    ))

    assert len(graph.nodes) == 3
    assert len(graph.edges) == 2
    assert graph.get_node(problem.id) is problem
    assert len(graph.get_nodes_by_type(NodeType.PROBLEM)) == 1
    assert len(graph.get_edges_from(problem.id)) == 1
    assert len(graph.get_edges_to(problem.id)) == 1


def test_tier_auto_assignment():
    """Foundational nodes get FOUNDATIONAL tier, active nodes get ACTIVE tier."""
    problem = ProblemNode(title="test problem")
    trigger = TriggerNode(title="test trigger")
    hypothesis = HypothesisNode(title="test hypothesis")
    goal = GoalNode(title="test goal")
    plan = PlanNode(title="test plan")
    action = ActionNode(title="test action")

    assert problem.tier == GraphTier.FOUNDATIONAL
    assert trigger.tier == GraphTier.FOUNDATIONAL
    assert hypothesis.tier == GraphTier.FOUNDATIONAL
    assert goal.tier == GraphTier.ACTIVE
    assert plan.tier == GraphTier.ACTIVE
    assert action.tier == GraphTier.ACTIVE


def test_tier_explicit_override():
    """Explicit tier overrides the default."""
    goal = GoalNode(title="important goal", tier=GraphTier.FOUNDATIONAL)
    assert goal.tier == GraphTier.FOUNDATIONAL


def test_graph_get_nodes_by_tier():
    graph = ReasoningGraph(session_id="tier-test")
    graph.add_node(ProblemNode(title="problem"))
    graph.add_node(TriggerNode(title="trigger"))
    graph.add_node(GoalNode(title="goal"))
    graph.add_node(PlanNode(title="plan"))
    graph.add_node(ActionNode(title="action"))

    foundational = graph.get_nodes_by_tier(GraphTier.FOUNDATIONAL)
    active = graph.get_nodes_by_tier(GraphTier.ACTIVE)

    assert len(foundational) == 2  # problem + trigger
    assert len(active) == 3  # goal + plan + action


def test_graph_get_nodes_by_type_and_tier():
    graph = ReasoningGraph(session_id="tier-test")
    graph.add_node(GoalNode(title="goal 1"))
    graph.add_node(GoalNode(title="goal 2", tier=GraphTier.FOUNDATIONAL))
    graph.add_node(PlanNode(title="plan 1"))

    active_goals = graph.get_nodes_by_type_and_tier(NodeType.GOAL, GraphTier.ACTIVE)
    foundational_goals = graph.get_nodes_by_type_and_tier(NodeType.GOAL, GraphTier.FOUNDATIONAL)

    assert len(active_goals) == 1
    assert active_goals[0].title == "goal 1"
    assert len(foundational_goals) == 1
    assert foundational_goals[0].title == "goal 2"
