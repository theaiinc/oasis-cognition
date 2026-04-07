"""Graph Builder: converts SemanticStructure into a ReasoningGraph."""

from __future__ import annotations

import logging
from typing import Any

from packages.reasoning_schema.enums import EdgeType, NodeSource, NodeType
from packages.reasoning_schema.models import (
    ActionNode,
    CompletionNode,
    ConstraintNode,
    EvidenceNode,
    GoalNode,
    HypothesisNode,
    PlanNode,
    ProblemNode,
    ReasoningEdge,
    ReasoningGraph,
    ReasoningNode,
    SemanticStructure,
    TriggerNode,
)

logger = logging.getLogger(__name__)


class GraphBuilderService:
    """Builds a ReasoningGraph from a SemanticStructure."""

    async def build_graph(
        self,
        semantic: SemanticStructure,
        session_id: str = "",
    ) -> ReasoningGraph:
        """Construct the initial reasoning graph from interpreted semantics."""
        logger.info("Building graph for session=%s", session_id)

        graph = ReasoningGraph(session_id=session_id)

        # --- Problem node ---
        problem_node = ProblemNode(
            title=semantic.problem or "Unknown problem",
            description=semantic.raw_input,
            source=NodeSource.USER,
            confidence=1.0,
            attributes={
                "problem_type": semantic.context.get("problem_type", ""),
                "system_component": semantic.entities.get("system_component", ""),
                "metric": semantic.entities.get("metric", ""),
            },
        )
        graph.add_node(problem_node)

        # --- Trigger node (if present) ---
        trigger_node: ReasoningNode | None = None
        if semantic.trigger:
            trigger_node = TriggerNode(
                title=semantic.trigger,
                source=NodeSource.USER,
                confidence=1.0,
            )
            graph.add_node(trigger_node)
            graph.add_edge(ReasoningEdge(
                source_node=trigger_node.id,
                target_node=problem_node.id,
                edge_type=EdgeType.TRIGGERS,
            ))

        # --- Evidence nodes from entities ---
        for key, value in semantic.entities.items():
            if key in ("system_component", "metric"):
                continue
            ev = EvidenceNode(
                title=f"{key}: {value}",
                source=NodeSource.USER,
                confidence=0.9,
                attributes={"metric": key, "value": value},
            )
            graph.add_node(ev)
            graph.add_edge(ReasoningEdge(
                source_node=ev.id,
                target_node=problem_node.id,
                edge_type=EdgeType.SUPPORTS,
            ))

        # --- Constraint nodes from context ---
        for key, value in semantic.context.items():
            if key.startswith("constraint"):
                cn = ConstraintNode(
                    title=str(value),
                    source=NodeSource.USER,
                    confidence=1.0,
                    attributes={"rule": str(value)},
                )
                graph.add_node(cn)

        logger.info(
            "Graph built: %d nodes, %d edges",
            len(graph.nodes),
            len(graph.edges),
        )
        return graph

    async def build_task_graph(
        self,
        semantic: SemanticStructure,
        plan_steps: list[dict[str, Any]],
        session_id: str = "",
        tool_results: list[dict[str, Any]] | None = None,
        existing_graph: ReasoningGraph | None = None,
    ) -> ReasoningGraph:
        """Build or update a task graph for tool_use (goal → plan → actions → completion)."""
        graph = existing_graph or ReasoningGraph(session_id=session_id)

        # Goal node (from semantic)
        goal_nodes = graph.get_nodes_by_type(NodeType.GOAL)
        if not goal_nodes:
            goal_node = GoalNode(
                title=semantic.problem or semantic.raw_input or "Unknown goal",
                description=semantic.raw_input,
                source=NodeSource.USER,
                confidence=1.0,
                attributes={
                    "success_criteria": str(semantic.context.get("success_criteria", "")),
                    "intent": semantic.intent or "",
                },
            )
            graph.add_node(goal_node)
        else:
            goal_node = goal_nodes[0]

        # Plan nodes (from plan_steps) — only add if not already present
        existing_plan_nodes = graph.get_nodes_by_type(NodeType.PLAN)
        if not existing_plan_nodes and plan_steps:
            for i, step in enumerate(plan_steps):
                desc = step.get("description", step.get("step", str(step)))
                plan_node = PlanNode(
                    title=f"Step {i + 1}: {desc[:80]}",
                    description=desc,
                    source=NodeSource.SYSTEM,
                    confidence=0.9,
                    attributes={"step_index": i, "description": desc},
                )
                graph.add_node(plan_node)
                graph.add_edge(ReasoningEdge(
                    source_node=plan_node.id,
                    target_node=goal_node.id,
                    edge_type=EdgeType.IMPLEMENTS,
                ))

        # Action nodes from tool_results — only add new ones (append)
        existing_action_count = len(graph.get_nodes_by_type(NodeType.ACTION))
        new_results = (tool_results or [])[existing_action_count:]
        plan_nodes = graph.get_nodes_by_type(NodeType.PLAN)

        for tr in new_results:
            tool_name = tr.get("tool", "unknown")
            output = (tr.get("output", "") or "")[:500]
            success = tr.get("success", False)
            path = tr.get("path") or tr.get("command", "") or ""
            action_node = ActionNode(
                title=f"{tool_name}: {output[:60]}...",
                description=output,
                source=NodeSource.SYSTEM,
                confidence=0.8 if success else 0.3,
                attributes={
                    "tool": tool_name,
                    "output": output,
                    "success": success,
                    "path": path,
                },
            )
            graph.add_node(action_node)
            if plan_nodes:
                graph.add_edge(ReasoningEdge(
                    source_node=action_node.id,
                    target_node=plan_nodes[0].id,
                    edge_type=EdgeType.EXECUTES,
                ))
            graph.add_edge(ReasoningEdge(
                source_node=action_node.id,
                target_node=goal_node.id,
                edge_type=EdgeType.SUPPORTS,
            ))

        logger.info(
            "Task graph built: %d nodes, %d edges",
            len(graph.nodes),
            len(graph.edges),
        )
        return graph
