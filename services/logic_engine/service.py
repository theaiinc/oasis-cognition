"""Logic Engine: the symbolic reasoning core of Oasis Cognition.

Implements the algorithm from SAD sections 17.2-17.6:
  1. Normalize graph
  2. Expand hypotheses
  3. Retrieve contextual memory
  4. Apply constraints
  5. Score hypotheses
  6. Rank & select
  7. Validate
  8. Generate explanation trace
"""

from __future__ import annotations

import logging
import re
from typing import Any

from packages.reasoning_schema.enums import EdgeType, GraphTier, NodeSource, NodeType
from packages.reasoning_schema.models import (
    CompletionNode,
    ConclusionNode,
    DecisionTree,
    GoalValidationResult,
    HypothesisNode,
    ReasoningEdge,
    ReasoningGraph,
)
from packages.shared_utils.config import Settings

logger = logging.getLogger(__name__)

_EDIT_TOOLS = frozenset({"create_worktree", "write_file", "edit_file", "get_diff"})
_READ_TOOLS = frozenset({"grep", "read_file", "list_dir", "find_files", "browse_url"})
_IMPL_STEP_RE = re.compile(
    r"\b(modify|edit|update|change|implement|integrates?|refactor|replaces?|patch|wire)\b",
    re.I,
)
_EXPLORE_STEP_RE = re.compile(
    r"\b(find|search|locates?|locate|identif(y|ied|ying)|discover|explores?|explore|inspect|grep|reads?)\b",
    re.I,
)
# Steps that add deps / run installers must not be satisfied by read-only tools alone.
_INSTALL_STEP_RE = re.compile(
    r"\b(install|installed|npm\s+i(?:nstall)?|yarn\s+add|pnpm\s+add|bun\s+add|pip(?:3)?\s+install|"
    r"add\s+(?:the\s+)?(?:chosen\s+)?(?:npm\s+)?package|(?:dependency|dependencies)|package\.json)\b",
    re.I,
)
_READ_TOOL_NAMES = frozenset({"read_file", "grep", "list_dir", "find_files", "browse_url"})


def _infer_plan_step_tool_used(
    step_tool: str,
    step_desc: str,
    all_tools_used: list[str],
    *,
    is_implementation_request: bool,
    total_actions: int,
) -> bool:
    """When the plan step has no explicit ``tool``, infer satisfaction from wording + tools run.

    Without this, ``tool_used`` defaulted to True and empty ``verify`` scored 1.0, so every
    step (e.g. \"Modify the UI component…\") was marked done after a single grep.
    """
    desc_l = str(step_desc or "").lower()
    used = set(all_tools_used)

    if step_tool:
        st = step_tool.lower()
        matched = any(t.lower() == st for t in all_tools_used)
        # Planner may wrongly assign read_file to an "Install library" step — do not accept.
        if matched and _INSTALL_STEP_RE.search(desc_l) and st in _READ_TOOL_NAMES:
            return False
        return matched

    desc = desc_l

    if _INSTALL_STEP_RE.search(desc):
        return bool(used & ({"bash", "edit_file", "write_file"}))

    if any(
        p in desc
        for p in (
            "selected library",
            "syntax highlight",
            "code snippet",
            "rendering code",
        )
    ) or _IMPL_STEP_RE.search(desc):
        return bool(used & _EDIT_TOOLS)
    if _EXPLORE_STEP_RE.search(desc) or desc.startswith("list ") or "list_dir" in desc:
        return bool(used & _READ_TOOLS)
    if is_implementation_request:
        return bool(used & _EDIT_TOOLS)
    return total_actions > 0


INSTINCT_RULES: list[dict[str, Any]] = [
    {
        "condition": {"problem_keywords": ["latency", "slow"], "trigger_keywords": ["concurrency", "traffic", "users"]},
        "hypotheses": [
            {"title": "Database connection pool saturation", "category": "database", "base_score": 0.6},
            {"title": "Thread pool exhaustion", "category": "compute", "base_score": 0.4},
            {"title": "Network congestion", "category": "network", "base_score": 0.3},
        ],
    },
    {
        "condition": {"problem_keywords": ["crash", "error", "exception"]},
        "hypotheses": [
            {"title": "Unhandled exception in application code", "category": "code", "base_score": 0.5},
            {"title": "Memory leak causing OOM", "category": "memory", "base_score": 0.4},
            {"title": "Dependency version conflict", "category": "dependency", "base_score": 0.3},
        ],
    },
    {
        "condition": {"problem_keywords": ["memory", "leak", "oom"]},
        "hypotheses": [
            {"title": "Unbounded cache growth", "category": "memory", "base_score": 0.5},
            {"title": "Connection or resource leak", "category": "resource", "base_score": 0.5},
        ],
    },
    {
        "condition": {"problem_keywords": ["timeout"]},
        "hypotheses": [
            {"title": "Downstream service unresponsive", "category": "network", "base_score": 0.5},
            {"title": "Database query too slow", "category": "database", "base_score": 0.4},
        ],
    },
]


class LogicEngineService:
    """Symbolic reasoning engine."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def reason(
        self,
        graph: ReasoningGraph,
        memory_context: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
    ) -> DecisionTree:
        """Execute the full reasoning pipeline (SAD section 17.2)."""
        logger.info("Reasoning started for session=%s", graph.session_id)
        logger.info(
            "Graph tiers: foundational=%d, active=%d",
            len(graph.get_nodes_by_tier(GraphTier.FOUNDATIONAL)),
            len(graph.get_nodes_by_tier(GraphTier.ACTIVE)),
        )
        memory_context = memory_context or []

        # 1. Normalize
        normalized = self._normalize(graph)

        # 2. Expand hypotheses
        hypotheses = self._expand_hypotheses(normalized)

        # 3. Memory context (provided by gateway)
        # 4. Apply constraints
        constrained = self._apply_constraints(hypotheses, normalized)

        # 5. Score (reduce memory weight when stale)
        scored = self._score(
            constrained,
            memory_context,
            memory_stale=bool(memory_stale_hint),
        )

        # 6. Rank
        ranked = sorted(scored, key=lambda h: h["score"], reverse=True)

        # 7. Validate
        best = self._validate(ranked)

        # 8. Build trace
        trace = self._build_trace(best, ranked, normalized)

        # Add conclusion node to graph
        conclusion = ConclusionNode(
            title=best["title"],
            confidence=best["score"],
            source=NodeSource.SYSTEM,
            attributes={"result": best["title"]},
        )
        normalized.add_node(conclusion)

        if best.get("node_id"):
            normalized.add_edge(ReasoningEdge(
                source_node=best["node_id"],
                target_node=conclusion.id,
                edge_type=EdgeType.LEADS_TO,
            ))

        logger.info("Reasoning complete: conclusion=%s (%.2f)", best["title"], best["score"])

        return DecisionTree(
            conclusion=best["title"],
            confidence=best["score"],
            hypotheses=ranked,
            reasoning_trace=trace,
            eliminated=[h for h in ranked if h.get("eliminated")],
            graph=normalized,
        )

    def _normalize(self, graph: ReasoningGraph) -> ReasoningGraph:
        seen = set()
        unique_edges = []
        for edge in graph.edges:
            key = (edge.source_node, edge.target_node, edge.edge_type)
            if key not in seen:
                seen.add(key)
                unique_edges.append(edge)
        graph.edges = unique_edges
        return graph

    def _expand_hypotheses(self, graph: ReasoningGraph) -> list[dict[str, Any]]:
        hypotheses: list[dict[str, Any]] = []

        for node in graph.get_nodes_by_type(NodeType.HYPOTHESIS):
            hypotheses.append({
                "node_id": node.id,
                "title": node.title,
                "category": node.attributes.get("category", ""),
                "score": node.confidence,
                "source": "graph",
            })

        problem_text = ""
        trigger_text = ""
        for node in graph.nodes:
            if node.node_type == NodeType.PROBLEM:
                problem_text = f"{node.title} {node.description}".lower()
            elif node.node_type == NodeType.TRIGGER:
                trigger_text = f"{node.title} {node.description}".lower()

        combined_text = f"{problem_text} {trigger_text}"

        for rule in INSTINCT_RULES:
            cond = rule["condition"]
            problem_match = any(kw in combined_text for kw in cond.get("problem_keywords", []))
            trigger_kws = cond.get("trigger_keywords", [])
            trigger_match = not trigger_kws or any(kw in combined_text for kw in trigger_kws)

            if problem_match and trigger_match:
                for h in rule["hypotheses"]:
                    if not any(existing["title"] == h["title"] for existing in hypotheses):
                        node = HypothesisNode(
                            title=h["title"],
                            source=NodeSource.SYSTEM,
                            confidence=h["base_score"],
                            attributes={"hypothesis": h["title"], "category": h["category"]},
                        )
                        graph.add_node(node)

                        for pn in graph.get_nodes_by_type(NodeType.PROBLEM):
                            graph.add_edge(ReasoningEdge(
                                source_node=pn.id,
                                target_node=node.id,
                                edge_type=EdgeType.LEADS_TO,
                            ))

                        hypotheses.append({
                            "node_id": node.id,
                            "title": h["title"],
                            "category": h["category"],
                            "score": h["base_score"],
                            "source": "instinct",
                        })

        if not hypotheses:
            node = HypothesisNode(
                title="Unknown root cause — requires investigation",
                source=NodeSource.SYSTEM,
                confidence=0.1,
            )
            graph.add_node(node)
            hypotheses.append({
                "node_id": node.id,
                "title": node.title,
                "category": "unknown",
                "score": 0.1,
                "source": "fallback",
            })

        logger.info("Expanded %d hypotheses", len(hypotheses))
        return hypotheses

    def _apply_constraints(
        self,
        hypotheses: list[dict[str, Any]],
        graph: ReasoningGraph,
    ) -> list[dict[str, Any]]:
        constraints = graph.get_nodes_by_type(NodeType.CONSTRAINT)
        evidence_nodes = graph.get_nodes_by_type(NodeType.EVIDENCE)

        for h in hypotheses:
            h["eliminated"] = False
            h["constraint_notes"] = []

            for constraint in constraints:
                rule = constraint.attributes.get("rule", "")
                for ev in evidence_nodes:
                    metric = ev.attributes.get("metric", "")
                    value = ev.attributes.get("value")
                    if self._constraint_eliminates(rule, metric, value, h):
                        h["eliminated"] = True
                        h["constraint_notes"].append(
                            f"Eliminated by constraint '{rule}' (evidence: {metric}={value})"
                        )

        active = [h for h in hypotheses if not h["eliminated"]]
        eliminated = [h for h in hypotheses if h["eliminated"]]
        logger.info("Constraints applied: %d active, %d eliminated", len(active), len(eliminated))
        return hypotheses

    def _constraint_eliminates(
        self,
        rule: str,
        metric: str,
        value: Any,
        hypothesis: dict[str, Any],
    ) -> bool:
        rule_lower = rule.lower()
        if "cpu" in rule_lower and "<" in rule_lower and hypothesis.get("category") == "compute":
            try:
                threshold = float("".join(c for c in rule_lower.split("<")[1] if c.isdigit() or c == "."))
                if isinstance(value, (int, float)) and value < threshold:
                    return True
            except (ValueError, IndexError):
                pass
        return False

    def _score(
        self,
        hypotheses: list[dict[str, Any]],
        memory_matches: list[dict[str, Any]],
        memory_stale: bool = False,
    ) -> list[dict[str, Any]]:
        w = self._settings
        # When memory is stale, reduce its influence on scoring
        mem_weight = w.weight_memory * 0.25 if memory_stale else w.weight_memory

        for h in hypotheses:
            if h.get("eliminated"):
                h["score"] = 0.0
                continue

            evidence_strength = h.get("score", 0.0)

            memory_sim = 0.0
            for mem in memory_matches:
                content = mem.get("content", {})
                if h["title"].lower() in str(content).lower():
                    memory_sim = max(memory_sim, 0.5)

            rule_match = 0.8 if h.get("source") == "instinct" else 0.3

            contradictions = len(h.get("constraint_notes", []))

            h["score"] = (
                w.weight_evidence * evidence_strength
                + mem_weight * memory_sim
                + w.weight_rule_match * rule_match
                - w.weight_contradiction_penalty * contradictions
            )
            h["score"] = max(0.0, min(1.0, h["score"]))

            h["score_breakdown"] = {
                "evidence_strength": evidence_strength,
                "memory_similarity": memory_sim,
                "rule_match": rule_match,
                "contradictions": contradictions,
            }

        return hypotheses

    def _validate(self, ranked: list[dict[str, Any]]) -> dict[str, Any]:
        for h in ranked:
            if not h.get("eliminated") and h["score"] > 0:
                return h

        return ranked[0] if ranked else {
            "title": "Unable to determine root cause",
            "score": 0.0,
            "category": "unknown",
        }

    def _build_trace(
        self,
        best: dict[str, Any],
        all_hypotheses: list[dict[str, Any]],
        graph: ReasoningGraph,
    ) -> list[str]:
        trace = []
        problem_nodes = graph.get_nodes_by_type(NodeType.PROBLEM)
        trace.append(f"Problem: {problem_nodes[0].title if problem_nodes else 'unknown'}")

        triggers = graph.get_nodes_by_type(NodeType.TRIGGER)
        if triggers:
            trace.append(f"Trigger: {triggers[0].title}")

        trace.append(f"Hypotheses evaluated: {len(all_hypotheses)}")

        for h in all_hypotheses:
            status = "ELIMINATED" if h.get("eliminated") else f"score={h['score']:.2f}"
            trace.append(f"  - {h['title']} [{status}]")

        trace.append(f"Conclusion: {best['title']} (confidence: {best['score']:.2f})")
        return trace

    def validate_thoughts(
        self,
        thoughts: list[dict[str, Any]],
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        walls_hit: list[str] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Validate candidate thoughts via symbolic reasoning."""
        memory_context = memory_context or []
        rules = rules or []
        walls_hit = walls_hit or []
        tool_results = tool_results or []
        
        validated = []
        for t in thoughts:
            thought_text = str(t.get("thought", "")).lower()
            confidence = float(t.get("confidence", 0.0))
            is_valid = True
            rejection_reason = None
            
            # 1. Wall check
            if any(w.lower() in thought_text for w in walls_hit if len(w) > 3):
                is_valid = False
                rejection_reason = "References a known failed path"
                
            # 2. Rule alignment
            for r in rules:
                rule_text = str(r.get("assertion", r.get("rule", ""))).lower()
                if rule_text and any(w in thought_text for w in rule_text.split() if len(w) > 3):
                    confidence += 0.1
                    
            # 3. Memory grounding
            for m in memory_context:
                content = m if isinstance(m, dict) else getattr(m, "content", m)
                if isinstance(content, dict):
                    if content.get("not_achievable"):
                        stored_goal = str(content.get("goal") or "").lower()
                        if stored_goal and any(w in thought_text for w in stored_goal.split() if len(w) > 3):
                            is_valid = False
                            rejection_reason = "Memory says similar goal is not achievable"
                    else:
                        content_str = str(content).lower()
                        if any(w in thought_text for w in content_str.split()[:5] if len(w) > 3):
                            confidence += 0.05
                            
            # 4. Deduplication
            for tr in tool_results:
                tool = tr.get("tool", "")
                path = tr.get("path", "")
                if tool and tool.lower() in thought_text and path and path.lower() in thought_text:
                    is_valid = False
                    rejection_reason = "Redundant with recent tool result"
                        
            # 5. Confidence threshold
            confidence = min(1.0, confidence)
            if is_valid and confidence < 0.3:
                is_valid = False
                rejection_reason = "Confidence too low"
                
            t["confidence"] = confidence
            t["validated"] = is_valid
            if rejection_reason:
                t["rejection_reason"] = rejection_reason
                
            validated.append(t)
            
        return {"validated_thoughts": validated}

    async def validate_goal(
        self,
        graph: ReasoningGraph,
        success_criteria: list[str] | None = None,
        plan_steps: list[dict[str, Any]] | None = None,
        memory_context: list[dict[str, Any]] | None = None,
        rules: list[dict[str, Any]] | None = None,
        memory_stale_hint: str | None = None,
        validated_thoughts: list[dict[str, Any]] | None = None,
        proposed_final_answer: str | None = None,
    ) -> GoalValidationResult:
        """Validate whether the goal in a task graph is met (Observer Agent).

        Uses memory (Knowledge Graph) and rules for grounded validation.
        """
        logger.info(
            "Validating goal for session=%s (memory=%d, rules=%d, foundational=%d, active=%d)",
            graph.session_id,
            len(memory_context or []),
            len(rules or []),
            len(graph.get_nodes_by_tier(GraphTier.FOUNDATIONAL)),
            len(graph.get_nodes_by_tier(GraphTier.ACTIVE)),
        )

        goal_nodes = graph.get_nodes_by_type(NodeType.GOAL)
        if not goal_nodes:
            return GoalValidationResult(
                goal_met=False,
                feedback="No goal defined in the task graph.",
                confidence=0.0,
            )

        goal_node = goal_nodes[0]
        goal_title = goal_node.title
        criteria = success_criteria or goal_node.attributes.get("success_criteria", "")
        if isinstance(criteria, str) and criteria:
            criteria_list = [c.strip() for c in criteria.split(";") if c.strip()]
        elif isinstance(criteria, list):
            criteria_list = criteria
        else:
            criteria_list = []

        action_nodes = graph.get_nodes_by_type(NodeType.ACTION)
        success_count = sum(1 for a in action_nodes if a.attributes.get("success"))
        total_actions = len(action_nodes)

        goal_intent = str(goal_node.attributes.get("intent", "") or "").lower().strip()
        goal_description = goal_node.description or ""
        request_text_lower = f"{goal_title} {goal_description} {';'.join(criteria_list)}".lower()
        is_implementation_request = goal_intent in ("fix", "implement") or any(
            kw in request_text_lower
            for kw in (
                "implement",
                "add",
                "create",
                "build",
                "fix",
                "modify",
                "update",
                "enable",
                "install",
                "set up",
                "refactor",
                "change",
                "write",
                "syntax highlight",
                "highlighting",
                "highlight ",
            )
        )

        # Heuristic: goal_met when many consecutive failures on same path (path doesn't exist)
        def _normalize_path(p: str) -> str:
            """Normalize path for comparison (strip /workspace prefix)."""
            if not p:
                return ""
            p = p.strip()
            if p.startswith("/workspace/"):
                return p[len("/workspace/"):] or p
            if p.startswith("/workspace"):
                return p[len("/workspace"):].lstrip("/") or p
            return p

        path_failures: dict[str, int] = {}
        for a in action_nodes:
            if a.attributes.get("success"):
                continue
            tool = a.attributes.get("tool", "")
            if tool not in ("read_file", "list_dir", "read_worktree_file"):
                continue
            path = _normalize_path(a.attributes.get("path", "") or "")
            # Also check output for path-like strings when path attr is empty
            out = (a.attributes.get("output", "") or "").lower()
            if not any(x in out for x in ("no such file", "not found", "does not exist", "enoent")):
                continue
            if not path:
                # Extract path from output (e.g. "File not found: /apps/foo/bar")
                for sep in ("file not found:", "path does not exist:", "not found:", "no such file:"):
                    if sep in out:
                        idx = out.find(sep) + len(sep)
                        rest = out[idx:].strip()
                        path = rest.split()[0] if rest else ""
                        path = _normalize_path(path.strip("'\""))
                        break
            if path:
                path_failures[path] = path_failures.get(path, 0) + 1
        if any(count >= 5 for count in path_failures.values()) and not is_implementation_request:
            bad_path = next(p for p, c in path_failures.items() if c >= 5)
            logger.info(
                "Path-failure heuristic: 5+ failures on path=%s — setting goal_met",
                bad_path,
            )
            return GoalValidationResult(
                goal_met=True,
                feedback=f"User should be informed the path does not exist: {bad_path}",
                confidence=0.8,
                updated_graph=graph.model_dump(mode="json"),
            )

        # ── Per-step validation: check which plan steps are completed ──
        steps = plan_steps or []
        step_statuses: list[dict[str, Any]] = []
        if steps:
            # Build a combined string of all tool outputs for matching
            all_outputs = " ".join(
                str(a.attributes.get("output", "")) for a in action_nodes
            ).lower()
            all_tools_used = [a.attributes.get("tool", "") for a in action_nodes]

            for step in steps:
                step_tool = (step.get("tool", "") or "").lower()
                step_verify = (step.get("verify", "") or "").lower()
                step_desc = step.get("description", step.get("action", ""))

                tool_used = _infer_plan_step_tool_used(
                    step_tool,
                    str(step_desc or ""),
                    all_tools_used,
                    is_implementation_request=is_implementation_request,
                    total_actions=total_actions,
                )
                verify_words = [w for w in step_verify.split() if len(w) > 3]
                if verify_words:
                    verify_matched = sum(1 for w in verify_words if w in all_outputs) / max(
                        len(verify_words), 1
                    )
                else:
                    verify_matched = 1.0 if tool_used else 0.0

                status = "done" if tool_used and verify_matched > 0.3 else "pending"
                step_statuses.append({
                    "step_index": step.get("step_index", 0),
                    "description": step_desc,
                    "status": status,
                    "tool_used": tool_used,
                    "verify_score": round(verify_matched, 2),
                })

            completed_count = sum(1 for s in step_statuses if s["status"] == "done")
            total_steps = len(step_statuses)
            logger.info(
                "Per-step validation: %d/%d steps completed",
                completed_count,
                total_steps,
            )

            # If we have steps and not all are done, provide specific feedback about what's missing
            # and signal that the goal is NOT met yet.
            if completed_count < total_steps:
                pending = [s for s in step_statuses if s["status"] == "pending"]
                next_step = pending[0] if pending else None
                if next_step:
                    next_desc = next_step["description"]
                    logger.info("Next pending step: %s", next_desc)

                # ── Early return: plan has pending steps, do NOT declare goal met ──
                step_progress = f"{completed_count}/{total_steps} plan steps completed"
                pending_descs = "; ".join(
                    s["description"][:80] for s in pending[:3]
                )
                logger.info("Plan incomplete: %s — returning goal_met=False", step_progress)
                return GoalValidationResult(
                    goal_met=False,
                    feedback=(
                        f"[PLAN INCOMPLETE] {step_progress}. "
                        f"Next steps: {pending_descs}. "
                        "Continue executing the remaining plan steps before summarizing."
                    ),
                    confidence=0.3,
                    updated_graph=graph.model_dump(mode="json"),
                    revise_plan=False,
                )

        # ── Detect if agent actually made code changes (not just explored) ──
        tools_used = {a.attributes.get("tool", "") for a in action_nodes}
        has_code_changes = bool(
            tools_used & {"create_worktree", "write_file", "edit_file", "apply_patch", "get_diff"}
        )
        only_read_tools = tools_used <= {"grep", "read_file", "list_dir", "find_files", "bash", "browse_url"}
        has_failures = any(not a.attributes.get("success") for a in action_nodes)

        # ── Heuristic: goal met based on actions and request type ──
        if not criteria_list:
            last_tool = action_nodes[-1].attributes.get("tool", "") if action_nodes else ""

            if is_implementation_request:
                if not has_code_changes:
                    goal_met = False
                    if only_read_tools and total_actions >= 2:  # Lower threshold to 2
                        feedback = (
                            "[STOP EXPLORING] You have done enough exploration. "
                            "The Knowledge Graph contains the symbols you need. "
                            "YOU MUST IMPLEMENT NOW: create_worktree → edit_file/write_file/apply_patch → get_diff. "
                            "NO MORE grep. NO MORE list_dir. Write the code."
                        )
                    elif only_read_tools and total_actions > 0:
                        feedback = (
                            "The user asked for an implementation but you only explored the codebase. "
                            "You MUST create a worktree, edit the files, and show the diff. "
                            "Do NOT tell the user to do it themselves — YOU are the coding agent. "
                            "Next steps: create_worktree → edit package.json (if adding deps) → "
                            "edit source files → get_diff."
                        )
                    elif total_actions > 0:
                        feedback = (
                            "Implementation was requested but no successful create_worktree / write_file / "
                            "edit_file / apply_patch / get_diff appears in the graph. Running bash or read-only tools alone "
                            "does not complete the task. Apply edits in a worktree, then get_diff."
                        )
                    else:
                        feedback = "More tool execution may be needed before answering."
                elif last_tool == "get_diff" and not has_failures:
                    goal_met = True
                    feedback = ""
                else:
                    goal_met = False
                    feedback = (
                        "You have started code changes but must finish with get_diff after edits, "
                        "or continue editing. Do not answer with tutorial-only text."
                    )
            elif total_actions > 0 and (
                success_count == total_actions or last_tool in ("get_diff", "bash")
            ):
                goal_met = True
                feedback = ""
            else:
                goal_met = False
                feedback = "More tool execution may be needed to complete the goal."
        else:
            if is_implementation_request and only_read_tools:
                goal_met = False
                feedback = (
                    "The user asked for an implementation but you only read/searched the codebase. "
                    "You must create a worktree and make the actual code changes. "
                    "Do NOT instruct the user to do it — implement it yourself."
                )
            elif is_implementation_request and not has_code_changes:
                goal_met = False
                feedback = (
                    "Implementation was requested but the task graph shows no worktree or file edits. "
                    "Use create_worktree → edit_file or write_file → get_diff."
                )
            elif is_implementation_request:
                last_tool_c = action_nodes[-1].attributes.get("tool", "") if action_nodes else ""
                goal_met = (
                    total_actions > 0
                    and not has_failures
                    and last_tool_c == "get_diff"
                )
                feedback = (
                    ""
                    if goal_met
                    else "Implementation with success criteria: complete edits and end with get_diff so the user can review."
                )
            else:
                goal_met = total_actions > 0 and not has_failures
                feedback = "" if goal_met else "Some criteria may not be satisfied. Continue working on the task."

        # ── Proposed final_answer is advisory while implementation required (safety net) ──
        advisory_blocked = False
        if (
            goal_met
            and is_implementation_request
            and (proposed_final_answer or "").strip()
        ):
            pa = (proposed_final_answer or "").lower()
            advisory_markers = (
                "you should ",
                "you can ",
                "here's ",
                "here is ",
                "npm install",
                "pip install",
                "yarn add",
                "pnpm add",
                "by following",
                "for example,",
                "ensure that you",
                "modify the ",
                "add the following",
                "try adding",
            )
            if any(m in pa for m in advisory_markers) and not has_code_changes:
                goal_met = False
                advisory_blocked = True
                feedback = (
                    "Validation failed: the answer reads like instructions for the user instead of changes "
                    "you applied. Use create_worktree → edit_file or write_file → get_diff in the repo."
                )

        # ── Enrich feedback with per-step progress ──
        if step_statuses and not goal_met:
            pending = [s for s in step_statuses if s["status"] == "pending"]
            completed = [s for s in step_statuses if s["status"] == "done"]
            progress = f"Step progress: {len(completed)}/{len(step_statuses)} completed."
            if pending:
                next_step = pending[0]
                progress += f" NEXT: {next_step['description']}"
            feedback = f"{feedback}\n{progress}" if feedback else progress

        # Confidence: base + boost when memory/rules support the outcome (skip boost if stale)
        base_confidence = 0.9 if goal_met else 0.5
        confidence = base_confidence
        memory_stale = bool(memory_stale_hint)

        memory_ctx = memory_context or []
        rules_list = rules or []
        if goal_met and (memory_ctx or rules_list) and not memory_stale:
            # Gather tool outputs for matching
            outputs_str = " ".join(
                str(a.attributes.get("output", "")) for a in action_nodes
            ).lower()
            # If memory or rules have content that appears in outputs, we're more confident
            for m in memory_ctx:
                content = str(m.get("content", m)).lower()
                if content and any(w in outputs_str for w in content.split()[:5] if len(w) > 3):
                    confidence = min(1.0, confidence + 0.05)
                    break
            for r in rules_list:
                assertion = str(r.get("assertion", r.get("rule", r))).lower()
                if assertion and any(w in outputs_str for w in assertion.split()[:3] if len(w) > 3):
                    confidence = min(1.0, confidence + 0.05)
                    break
                    
        # --- Incorporate thoughts from both parameter and graph nodes ---
        all_validated_thoughts = (validated_thoughts or []).copy()
        for tn in graph.get_nodes_by_type(NodeType.THOUGHT):
            # Avoid duplicates if they are already in validated_thoughts
            t_text = tn.attributes.get("thought") or tn.description
            if not any(t.get("thought") == t_text for t in all_validated_thoughts):
                all_validated_thoughts.append({
                    "thought": t_text,
                    "confidence": tn.confidence,
                    "validated": tn.attributes.get("validated", True)
                })

        if all_validated_thoughts:
            valid_t = [t for t in all_validated_thoughts if t.get("validated", False)]
            if valid_t:
                outputs_str = " ".join(str(a.attributes.get("output", "")) for a in action_nodes).lower()
                aligned_count = 0
                for vt in valid_t:
                    th_text = str(vt.get("thought", "")).lower()
                    if th_text and any(w in outputs_str for w in th_text.split() if len(w) > 4):
                        confidence = min(1.0, confidence + 0.05)
                        aligned_count += 1
                if aligned_count == 0 and not goal_met:
                    confidence = max(0.0, confidence - 0.1)

        # Add completion node to graph
        completion_node = CompletionNode(
            title="Goal met" if goal_met else "Goal not met",
            description=feedback,
            source=NodeSource.SYSTEM,
            confidence=confidence,
            attributes={
                "goal_met": goal_met,
                "feedback": feedback,
                "step_statuses": step_statuses if step_statuses else None,
            },
        )
        graph.add_node(completion_node)
        graph.add_edge(ReasoningEdge(
            source_node=completion_node.id,
            target_node=goal_node.id,
            edge_type=EdgeType.COMPLETES,
        ))

        # Replans are expensive and confuse step alignment; only trigger after many actions without
        # code mutations, or when final_answer was blocked as advisory. (Previously: read-only + >=2
        # and no-code + >=6 replanned almost every observer hop during normal exploration.)
        revise_plan_min_explore = 12
        revise_plan = not goal_met and (
            advisory_blocked
            or (
                is_implementation_request
                and not has_code_changes
                and total_actions >= revise_plan_min_explore
            )
        )

        return GoalValidationResult(
            goal_met=goal_met,
            feedback=feedback,
            confidence=confidence,
            updated_graph=graph.model_dump(mode="json"),
            revise_plan=revise_plan,
        )

    def assess_feasibility(
        self,
        user_goal: str,
        memory_context: list[dict[str, Any]] | None = None,
        walls: list[str] | None = None,
    ) -> dict[str, Any]:
        """Assess whether a task is achievable based on memory (not_achievable entries) and walls.

        Returns { achievable: bool, reason?: str, suggestion?: str }.
        """
        memory_context = memory_context or []
        walls = walls or []
        goal_lower = user_goal.lower().strip()

        # Check memory for explicit not_achievable entries
        for m in memory_context:
            content = m if isinstance(m, dict) else getattr(m, "content", m)
            if not isinstance(content, dict):
                continue
            if not content.get("not_achievable"):
                continue
            stored_goal = (content.get("goal") or "").lower()
            if not stored_goal:
                continue
            # Match if goal keywords overlap (simple heuristic)
            goal_words = set(w for w in goal_lower.split() if len(w) > 2)
            stored_words = set(w for w in stored_goal.split() if len(w) > 2)
            if goal_words & stored_words or stored_goal in goal_lower or goal_lower in stored_goal:
                return {
                    "achievable": False,
                    "reason": content.get("reason", "Previously marked as not achievable."),
                    "suggestion": content.get("suggestion", "Try a different approach or clarify the goal."),
                }

        # Heuristic: many walls with same path pattern suggests path doesn't exist
        path_failures: dict[str, int] = {}
        for w in walls:
            w_lower = w.lower()
            if any(x in w_lower for x in ("does not exist", "not found", "no such file", "enoent")):
                # Extract path-like part
                for sep in ("file not found:", "path does not exist:", "not found:", "no such file:"):
                    if sep in w_lower:
                        idx = w_lower.find(sep) + len(sep)
                        rest = w_lower[idx:].strip()
                        path = rest.split()[0] if rest else ""
                        path = path.strip("'\"")
                        if path and len(path) > 3:
                            path_failures[path] = path_failures.get(path, 0) + 1
                        break
        if any(c >= 5 for c in path_failures.values()):
            bad_path = next(p for p, c in path_failures.items() if c >= 5)
            return {
                "achievable": False,
                "reason": f"Path does not exist (repeated failures): {bad_path}",
                "suggestion": "Verify the path exists with list_dir or use a different path.",
            }

        return {"achievable": True}
