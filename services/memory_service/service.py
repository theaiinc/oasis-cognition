"""Memory Service: stores and retrieves structured knowledge using Neo4j.

Stores reasoning graphs, memories, and learned rules in Neo4j.
Falls back to in-memory storage if Neo4j is unavailable.
"""

from __future__ import annotations

import json
import hashlib
import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from packages.reasoning_schema.enums import MemoryType
from packages.reasoning_schema.models import MemoryEntry, ReasoningGraph
from packages.shared_utils.config import Settings

logger = logging.getLogger(__name__)


class MemoryService:
    """Stores episodic, semantic, and procedural memories in Neo4j."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._driver: Any = None
        self._fallback_memories: list[dict[str, Any]] = []
        self._fallback_rules: list[dict[str, Any]] = []
        self._fallback_pending_teaching: dict[str, dict[str, Any]] = {}
        self._fallback_pending_self_teaching: dict[str, dict[str, Any]] = {}
        # CU learning memory fallbacks
        self._fallback_skills: list[dict[str, Any]] = []
        self._fallback_ui_elements: list[dict[str, Any]] = []
        self._fallback_actions: list[dict[str, Any]] = []
        self._use_fallback = False
        self._init_driver()

    def _init_driver(self) -> None:
        import time as _time
        max_retries = 10
        retry_delay = 3  # seconds
        for attempt in range(1, max_retries + 1):
            try:
                from neo4j import GraphDatabase
                self._driver = GraphDatabase.driver(
                    self._settings.neo4j_uri,
                    auth=(self._settings.neo4j_user, self._settings.neo4j_password),
                )
                self._driver.verify_connectivity()
                self._ensure_schema()
                logger.info("Connected to Neo4j at %s (attempt %d)", self._settings.neo4j_uri, attempt)
                self._use_fallback = False
                return
            except Exception as e:
                if attempt < max_retries:
                    logger.warning("Neo4j unavailable (attempt %d/%d: %s), retrying in %ds...", attempt, max_retries, e, retry_delay)
                    _time.sleep(retry_delay)
                else:
                    logger.warning("Neo4j unavailable after %d attempts (%s), using in-memory fallback", max_retries, e)
                    self._use_fallback = True

    @property
    def storage_backend(self) -> str:
        """Where Rule nodes live: neo4j (durable) vs fallback (ephemeral in-process)."""
        return "fallback" if self._use_fallback else "neo4j"

    @staticmethod
    def _safe_rule_float(val: Any, default: float = 0.5) -> float:
        try:
            x = float(val)
            if math.isnan(x) or math.isinf(x):
                return default
            return x
        except (TypeError, ValueError):
            return default

    @classmethod
    def _rule_node_to_dict(cls, node: Any) -> dict[str, Any]:
        """Convert Neo4j Rule node to JSON-safe dict (explicit keys; no driver-specific types)."""
        if node is None:
            return {}
        try:
            raw = dict(node)
        except Exception:
            raw = getattr(node, "_properties", {}) or {}
        out: dict[str, Any] = {}
        rid = raw.get("rule_id")
        if rid is not None:
            out["rule_id"] = str(rid)
        fp = raw.get("fingerprint")
        if fp is not None:
            out["fingerprint"] = str(fp)
        cond = raw.get("condition")
        concl = raw.get("conclusion")
        out["condition"] = "" if cond is None else str(cond)
        out["conclusion"] = "" if concl is None else str(concl)
        out["confidence"] = cls._safe_rule_float(raw.get("confidence"), 0.5)
        uc = raw.get("usage_count")
        try:
            out["usage_count"] = int(uc) if uc is not None else 0
        except (TypeError, ValueError):
            out["usage_count"] = 0
        c_at = raw.get("created_at")
        if c_at is not None:
            out["created_at"] = c_at.isoformat() if hasattr(c_at, "isoformat") else str(c_at)
        return out

    @classmethod
    def _skill_node_to_dict(cls, node: Any) -> dict[str, Any]:
        if node is None:
            return {}
        try:
            raw = dict(node)
        except Exception:
            raw = getattr(node, "_properties", {}) or {}
        steps_raw = raw.get("steps", "[]")
        try:
            steps = json.loads(steps_raw) if isinstance(steps_raw, str) else list(steps_raw)
        except Exception:
            steps = []
        return {
            "id": str(raw.get("id", "")),
            "name": str(raw.get("name", "")),
            "intent": str(raw.get("intent", "")),
            "steps": steps,
            "success_rate": cls._safe_rule_float(raw.get("success_rate"), 0.0),
            "usage_count": int(raw.get("usage_count", 0)) if raw.get("usage_count") is not None else 0,
            "created_at": str(raw.get("created_at", "")),
        }

    @classmethod
    def _ui_element_node_to_dict(cls, node: Any) -> dict[str, Any]:
        if node is None:
            return {}
        try:
            raw = dict(node)
        except Exception:
            raw = getattr(node, "_properties", {}) or {}
        return {
            "id": str(raw.get("id", "")),
            "text": str(raw.get("text", "")),
            "type": str(raw.get("type", "")),
            "x_ratio": cls._safe_rule_float(raw.get("x_ratio"), 0.0),
            "y_ratio": cls._safe_rule_float(raw.get("y_ratio"), 0.0),
            "context": str(raw.get("context", "")),
            "confidence": cls._safe_rule_float(raw.get("confidence"), 0.0),
            "last_seen": str(raw.get("last_seen", "")),
        }

    @classmethod
    def _action_node_to_dict(cls, node: Any) -> dict[str, Any]:
        if node is None:
            return {}
        try:
            raw = dict(node)
        except Exception:
            raw = getattr(node, "_properties", {}) or {}
        return {
            "id": str(raw.get("id", "")),
            "type": str(raw.get("type", "")),
            "target": str(raw.get("target", "")),
            "success": bool(raw.get("success", False)),
            "timestamp": str(raw.get("timestamp", "")),
        }

    def _ensure_schema(self) -> None:
        if self._use_fallback or not self._driver:
            return
        with self._driver.session() as session:
            # Existing schemas
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (m:Memory) REQUIRE m.memory_id IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (r:Rule) REQUIRE r.rule_id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (r:Rule) ON (r.fingerprint)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (m:Memory) ON (m.memory_type)")

            # Artifact library schema
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (p:Project) REQUIRE p.project_id IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (a:Artifact) REQUIRE a.artifact_id IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (e:Embedding) REQUIRE e.embedding_id IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (cs:ChatSession) REQUIRE cs.session_id IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (rp:Repo) REQUIRE rp.repo_id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (a:Artifact) ON (a.status)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (a:Artifact) ON (a.mime_type)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (p:Project) ON (p.name)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (e:Embedding) ON (e.artifact_id)")

            # Code knowledge graph schema
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (f:CodeFile) REQUIRE f.path IS UNIQUE")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (s:CodeSymbol) REQUIRE s.id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (m:CodeModule) ON (m.name)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (s:CodeSymbol) ON (s.name)")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (sp:SpeakerProfile) REQUIRE sp.speaker_id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (sp:SpeakerProfile) ON (sp.name)")

            session.run("CREATE INDEX IF NOT EXISTS FOR (s:CodeSymbol) ON (s.type)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (f:CodeFile) ON (f.language)")

            # Reasoning graph tier index for efficient tier-based queries
            session.run("CREATE INDEX IF NOT EXISTS FOR (n:ReasoningNode) ON (n.tier)")

            # CU learning memory schema
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (sk:Skill) REQUIRE sk.id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (sk:Skill) ON (sk.fingerprint)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (sk:Skill) ON (sk.intent)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (sk:Skill) ON (sk.success_rate)")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (ui:UIElement) REQUIRE ui.id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (ui:UIElement) ON (ui.fingerprint)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (ui:UIElement) ON (ui.text)")
            session.run("CREATE INDEX IF NOT EXISTS FOR (ui:UIElement) ON (ui.context)")
            session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (act:Action) REQUIRE act.id IS UNIQUE")
            session.run("CREATE INDEX IF NOT EXISTS FOR (act:Action) ON (act.type)")

    @staticmethod
    def _normalize_rule_part(text: str) -> str:
        """Normalize rule text for deterministic dedupe."""
        return " ".join((text or "").lower().strip().split())

    def _rule_fingerprint(self, condition: str, conclusion: str) -> str:
        """Stable fingerprint for (condition, conclusion) rule dedupe."""
        norm_cond = self._normalize_rule_part(condition)
        norm_concl = self._normalize_rule_part(conclusion)
        raw = f"{norm_cond}|||{norm_concl}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    async def store(self, entry: MemoryEntry) -> None:
        if self._use_fallback:
            self._fallback_memories.append(entry.model_dump(mode="json"))
            logger.info("Memory stored (fallback): %s (%s)", entry.memory_id, entry.memory_type.value)
            return

        with self._driver.session() as session:
            session.run(
                """
                MERGE (m:Memory {memory_id: $memory_id})
                SET m.memory_type = $memory_type,
                    m.content = $content,
                    m.graph_reference = $graph_reference,
                    m.user_reference = $user_reference,
                    m.tags = $tags,
                    m.created_at = $created_at
                """,
                memory_id=entry.memory_id,
                memory_type=entry.memory_type.value,
                content=json.dumps(entry.content),
                graph_reference=entry.graph_reference or "",
                user_reference=entry.user_reference or "",
                tags=json.dumps(entry.tags),
                created_at=entry.created_at.isoformat() if isinstance(entry.created_at, datetime) else str(entry.created_at),
            )
        logger.info("Memory stored (Neo4j): %s (%s)", entry.memory_id, entry.memory_type.value)

    async def store_graph(
        self,
        graph: ReasoningGraph,
        user_id: str = "default",
        session_id: str | None = None,
        walls: list[str] | None = None,
    ) -> None:
        content = graph.model_dump(mode="json")
        if session_id:
            content["session_id"] = session_id
        if walls:
            content["walls"] = walls[:10]
        tags = [n.title for n in graph.nodes[:5]]
        if session_id:
            tags.append(f"session:{session_id}")
        if walls:
            for w in walls[:10]:
                tags.append(f"wall:{w}")
        entry = MemoryEntry(
            memory_type=MemoryType.EPISODIC,
            content=content,
            graph_reference=graph.id,
            user_reference=user_id,
            tags=tags,
        )
        await self.store(entry)

        if not self._use_fallback and self._driver:
            self._store_graph_nodes(graph)

    def _store_graph_nodes(self, graph: ReasoningGraph) -> None:
        with self._driver.session() as session:
            for node in graph.nodes:
                session.run(
                    """
                    MERGE (n:ReasoningNode {id: $id})
                    SET n.node_type = $node_type,
                        n.tier = $tier,
                        n.title = $title,
                        n.description = $description,
                        n.confidence = $confidence,
                        n.source = $source,
                        n.attributes = $attributes,
                        n.session_id = $session_id
                    """,
                    id=node.id,
                    node_type=node.node_type.value,
                    tier=node.tier.value if node.tier else "foundational",
                    title=node.title,
                    description=node.description,
                    confidence=node.confidence,
                    source=node.source.value,
                    attributes=json.dumps(node.attributes),
                    session_id=graph.session_id,
                )

            for edge in graph.edges:
                session.run(
                    """
                    MATCH (a:ReasoningNode {id: $source})
                    MATCH (b:ReasoningNode {id: $target})
                    MERGE (a)-[r:REASONING_EDGE {edge_type: $edge_type}]->(b)
                    SET r.weight = $weight
                    """,
                    source=edge.source_node,
                    target=edge.target_node,
                    edge_type=edge.edge_type.value,
                    weight=edge.weight,
                )

    async def store_not_achievable(
        self,
        goal: str,
        reason: str,
        suggestion: str = "",
        session_id: str | None = None,
        user_id: str = "default",
    ) -> None:
        """Store a 'not achievable' entry for a goal (path doesn't exist, etc.)."""
        import hashlib
        goal_hash = hashlib.sha256(goal.lower().strip().encode()).hexdigest()[:12]
        content = {
            "not_achievable": True,
            "goal": goal,
            "reason": reason,
            "suggestion": suggestion,
        }
        tags = ["not_achievable", f"goal:{goal_hash}"]
        if session_id:
            content["session_id"] = session_id
            tags.append(f"session:{session_id}")
        entry = MemoryEntry(
            memory_type=MemoryType.EPISODIC,
            content=content,
            graph_reference="",
            user_reference=user_id,
            tags=tags,
        )
        await self.store(entry)
        logger.info("Not achievable stored: goal=%s reason=%s", goal[:50], reason[:50])

    async def store_rule(self, condition: str, conclusion: str, confidence: float = 0.5) -> str:
        fingerprint = self._rule_fingerprint(condition, conclusion)
        rule_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        if self._use_fallback:
            # Deduplicate fallback rules in-memory.
            for existing in self._fallback_rules:
                existing_fp = existing.get("fingerprint")
                if not existing_fp:
                    existing_fp = self._rule_fingerprint(existing.get("condition", ""), existing.get("conclusion", ""))
                if existing_fp == fingerprint:
                    # Merge: keep best confidence.
                    existing["confidence"] = max(float(existing.get("confidence", 0.0)), float(confidence))
                    existing["fingerprint"] = fingerprint
                    logger.info("Rule deduped (fallback): IF %s THEN %s", condition, conclusion)
                    return existing["rule_id"]

            self._fallback_rules.append({
                "rule_id": rule_id,
                "fingerprint": fingerprint,
                "condition": condition,
                "conclusion": conclusion,
                "confidence": confidence,
                "usage_count": 0,
                "created_at": now,
            })
            logger.info("Rule stored (fallback): IF %s THEN %s", condition, conclusion)
        else:
            # Deduplicate on Neo4j by fingerprint (for rules created after this change).
            with self._driver.session() as session:
                existing = session.run(
                    """
                    MATCH (r:Rule {fingerprint: $fingerprint})
                    RETURN r.rule_id AS rule_id, r.confidence AS confidence
                    ORDER BY r.confidence DESC
                    LIMIT 1
                    """,
                    fingerprint=fingerprint,
                ).single()

                if existing and existing.get("rule_id"):
                    existing_id = existing["rule_id"]
                    session.run(
                        """
                        MATCH (r:Rule {rule_id: $rule_id})
                        SET r.fingerprint = $fingerprint,
                            r.confidence = CASE WHEN r.confidence < $confidence THEN $confidence ELSE r.confidence END
                        """,
                        rule_id=existing_id,
                        fingerprint=fingerprint,
                        confidence=confidence,
                    )
                    logger.info("Rule deduped (Neo4j): IF %s THEN %s", condition, conclusion)
                    return existing_id

                session.run(
                    """
                    MERGE (r:Rule {rule_id: $rule_id})
                    SET r.fingerprint = $fingerprint,
                        r.condition = $condition,
                        r.conclusion = $conclusion,
                        r.confidence = $confidence,
                        r.usage_count = 0,
                        r.created_at = $created_at
                    """,
                    rule_id=rule_id,
                    fingerprint=fingerprint,
                    condition=condition,
                    conclusion=conclusion,
                    confidence=confidence,
                    created_at=now,
                )
            logger.info("Rule stored (Neo4j): IF %s THEN %s (%.2f)", condition, conclusion, confidence)

        # Auto-link to related rules
        await self._link_related_rules(rule_id, condition, conclusion)
        return rule_id

    # ── CU Learning Memory ─────────────────────────────────────────────────────

    def _cu_fingerprint(self, *parts: str) -> str:
        """Stable fingerprint for CU learning memory dedup."""
        raw = "|".join(self._normalize_rule_part(p) for p in parts)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    async def save_ui_element(
        self, text: str, element_type: str, x_ratio: float, y_ratio: float,
        context: str, confidence: float = 0.8,
    ) -> str:
        """Save or update a UI element in memory. Deduplicates by text+type+context."""
        fp = self._cu_fingerprint(text, element_type, context)
        element_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        if self._use_fallback:
            for existing in self._fallback_ui_elements:
                if existing.get("fingerprint") == fp:
                    existing["x_ratio"] = x_ratio
                    existing["y_ratio"] = y_ratio
                    existing["confidence"] = max(existing.get("confidence", 0), confidence)
                    existing["last_seen"] = now
                    return existing["id"]
            self._fallback_ui_elements.append({
                "id": element_id, "fingerprint": fp, "text": text,
                "type": element_type, "x_ratio": x_ratio, "y_ratio": y_ratio,
                "context": context, "confidence": confidence, "last_seen": now,
            })
            return element_id

        with self._driver.session() as session:
            session.run("""
                MERGE (ui:UIElement {fingerprint: $fp})
                ON CREATE SET ui.id = $id, ui.text = $text, ui.type = $type,
                    ui.x_ratio = $x, ui.y_ratio = $y, ui.context = $ctx,
                    ui.confidence = $conf, ui.last_seen = $now
                ON MATCH SET ui.x_ratio = $x, ui.y_ratio = $y,
                    ui.confidence = CASE WHEN ui.confidence < $conf THEN $conf ELSE ui.confidence END,
                    ui.last_seen = $now
            """, fp=fp, id=element_id, text=text, type=element_type,
                x=x_ratio, y=y_ratio, ctx=context, conf=confidence, now=now)
            result = session.run(
                "MATCH (ui:UIElement {fingerprint: $fp}) RETURN ui.id AS id", fp=fp
            ).single()
            actual_id = result["id"] if result else element_id

        logger.info("UIElement saved: '%s' (%s) in '%s'", text[:30], element_type, context[:30])
        return actual_id

    async def save_action(
        self, action_type: str, target: str, success: bool,
        ui_element_id: str | None = None, skill_id: str | None = None,
    ) -> str:
        """Record a CU action execution. Always creates a new node (each execution is distinct)."""
        action_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        if self._use_fallback:
            self._fallback_actions.append({
                "id": action_id, "type": action_type, "target": target,
                "success": success, "timestamp": now,
                "ui_element_id": ui_element_id, "skill_id": skill_id,
            })
            return action_id

        with self._driver.session() as session:
            session.run("""
                CREATE (a:Action {id: $id, type: $type, target: $target,
                    success: $success, timestamp: $now})
            """, id=action_id, type=action_type, target=target,
                success=success, now=now)

            if ui_element_id:
                session.run("""
                    MATCH (a:Action {id: $aid})
                    MATCH (ui:UIElement {id: $uid})
                    MERGE (a)-[:TARGETS]->(ui)
                """, aid=action_id, uid=ui_element_id)

            if skill_id:
                session.run("""
                    MATCH (a:Action {id: $aid})
                    MATCH (sk:Skill {id: $sid})
                    MERGE (a)-[:PART_OF]->(sk)
                """, aid=action_id, sid=skill_id)

        logger.info("Action saved: %s '%s' success=%s", action_type, target[:30], success)
        return action_id

    async def create_skill(
        self, name: str, intent: str, steps: list[str],
        ui_element_ids: list[str] | None = None,
    ) -> str:
        """Create or update a reusable skill from completed action sequences."""
        fp = self._cu_fingerprint(intent)
        skill_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        steps_json = json.dumps(steps)

        if self._use_fallback:
            for existing in self._fallback_skills:
                if existing.get("fingerprint") == fp:
                    existing["steps"] = steps
                    existing["usage_count"] = existing.get("usage_count", 0) + 1
                    return existing["id"]
            self._fallback_skills.append({
                "id": skill_id, "fingerprint": fp, "name": name,
                "intent": self._normalize_rule_part(intent), "steps": steps,
                "success_rate": 1.0, "usage_count": 1, "created_at": now,
            })
            return skill_id

        with self._driver.session() as session:
            existing = session.run(
                "MATCH (sk:Skill {fingerprint: $fp}) RETURN sk.id AS id", fp=fp
            ).single()

            if existing:
                session.run("""
                    MATCH (sk:Skill {fingerprint: $fp})
                    SET sk.steps = $steps, sk.usage_count = sk.usage_count + 1
                """, fp=fp, steps=steps_json)
                actual_id = existing["id"]
                logger.info("Skill updated: '%s' (deduped)", name[:40])
            else:
                session.run("""
                    CREATE (sk:Skill {id: $id, fingerprint: $fp, name: $name,
                        intent: $intent, steps: $steps, success_rate: 1.0,
                        usage_count: 1, created_at: $now})
                """, id=skill_id, fp=fp, name=name,
                    intent=self._normalize_rule_part(intent),
                    steps=steps_json, now=now)
                actual_id = skill_id
                logger.info("Skill created: '%s' (%d steps)", name[:40], len(steps))

            for uid in (ui_element_ids or []):
                session.run("""
                    MATCH (sk:Skill {id: $sid})
                    MATCH (ui:UIElement {id: $uid})
                    MERGE (sk)-[:USES]->(ui)
                """, sid=actual_id, uid=uid)

        return actual_id

    async def update_skill_stats(self, skill_id: str, success: bool) -> None:
        """Update skill success_rate using exponential moving average (alpha=0.3)."""
        alpha = 0.3
        outcome = 1.0 if success else 0.0

        if self._use_fallback:
            for sk in self._fallback_skills:
                if sk["id"] == skill_id:
                    old_rate = sk.get("success_rate", 0.5)
                    sk["success_rate"] = round(alpha * outcome + (1 - alpha) * old_rate, 4)
                    sk["usage_count"] = sk.get("usage_count", 0) + 1
                    return
            return

        with self._driver.session() as session:
            session.run("""
                MATCH (sk:Skill {id: $id})
                SET sk.success_rate = round(($alpha * $outcome + (1.0 - $alpha) * sk.success_rate) * 10000) / 10000,
                    sk.usage_count = sk.usage_count + 1
            """, id=skill_id, alpha=alpha, outcome=outcome)
        logger.info("Skill %s stats updated: success=%s", skill_id[:12], success)

    async def find_relevant_skill(
        self, intent: str, context: str = "", min_success_rate: float = 0.7,
    ) -> dict[str, Any] | None:
        """Find a learned skill matching the given intent with high enough success rate."""
        keywords = [w for w in intent.lower().split() if len(w) > 3][:8]
        if not keywords:
            return None

        if self._use_fallback:
            best = None
            for sk in self._fallback_skills:
                if sk.get("success_rate", 0) < min_success_rate:
                    continue
                sk_intent = sk.get("intent", "")
                if any(kw in sk_intent for kw in keywords):
                    if best is None or sk["success_rate"] > best["success_rate"]:
                        best = sk
            return best

        # Build parameterized WHERE with $kw0, $kw1, ... to avoid Cypher injection
        kw_conditions = " OR ".join(f"sk.intent CONTAINS $kw{i}" for i in range(len(keywords)))
        params: dict[str, Any] = {"min_rate": min_success_rate}
        for i, kw in enumerate(keywords):
            params[f"kw{i}"] = kw

        with self._driver.session() as session:
            result = session.run(f"""
                MATCH (sk:Skill) WHERE ({kw_conditions})
                AND sk.success_rate >= $min_rate
                RETURN sk ORDER BY sk.success_rate DESC, sk.usage_count DESC
                LIMIT 1
            """, **params).single()
            if result:
                return self._skill_node_to_dict(result["sk"])
        return None

    async def find_ui_element(
        self, query: str, context: str = "",
    ) -> list[dict[str, Any]]:
        """Find remembered UI elements matching a text query and context."""
        keywords = [w for w in query.lower().split() if len(w) > 2][:6]
        if not keywords:
            return []

        if self._use_fallback:
            results = []
            for ui in self._fallback_ui_elements:
                text = (ui.get("text") or "").lower()
                ctx = (ui.get("context") or "").lower()
                if any(kw in text or kw in ctx for kw in keywords):
                    results.append(ui)
            return sorted(results, key=lambda u: u.get("confidence", 0), reverse=True)[:5]

        # Parameterized keyword search
        kw_conditions = []
        params: dict[str, Any] = {}
        for i, kw in enumerate(keywords):
            kw_conditions.append(f"(ui.text CONTAINS $kw{i} OR ui.context CONTAINS $kw{i})")
            params[f"kw{i}"] = kw

        with self._driver.session() as session:
            result = session.run(f"""
                MATCH (ui:UIElement) WHERE {" OR ".join(kw_conditions)}
                RETURN ui ORDER BY ui.confidence DESC, ui.last_seen DESC
                LIMIT 5
            """, **params)
            return [self._ui_element_node_to_dict(r["ui"]) for r in result]

    # ── End CU Learning Memory ────────────────────────────────────────────────

    async def dedupe_rules(self, dry_run: bool = False) -> dict[str, Any]:
        """Remove duplicate Rule nodes by normalized (condition, conclusion).

        Keeps the rule with highest confidence per fingerprint, then deletes the rest.
        """
        if self._use_fallback:
            # Fallback dedupe.
            groups: dict[str, dict[str, Any]] = {}
            original = len(self._fallback_rules)
            for r in self._fallback_rules:
                fp = r.get("fingerprint")
                if not fp:
                    fp = self._rule_fingerprint(r.get("condition", ""), r.get("conclusion", ""))

                cur = groups.get(fp)
                if cur is None:
                    groups[fp] = r
                    groups[fp]["fingerprint"] = fp
                else:
                    cur_conf = float(cur.get("confidence", 0.0))
                    r_conf = float(r.get("confidence", 0.0))
                    if r_conf > cur_conf:
                        groups[fp] = r
                        groups[fp]["fingerprint"] = fp

            kept = list(groups.values())
            deleted = original - len(kept)
            if not dry_run:
                self._fallback_rules = kept
            return {
                "success": True,
                "dry_run": dry_run,
                "original_count": original,
                "unique_count": len(kept),
                "deleted_count": deleted,
            }

        if not self._driver:
            return {"success": False, "error": "Neo4j driver not initialized"}

        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (r:Rule)
                RETURN r.rule_id AS rule_id,
                       r.condition AS condition,
                       r.conclusion AS conclusion,
                       r.confidence AS confidence,
                       r.created_at AS created_at
                """
            )
            rules = []
            for record in result:
                rules.append({
                    "rule_id": record.get("rule_id"),
                    "condition": record.get("condition") or "",
                    "conclusion": record.get("conclusion") or "",
                    "confidence": record.get("confidence") if record.get("confidence") is not None else 0.0,
                    "created_at": record.get("created_at") or "",
                })

        original = len(rules)
        groups: dict[str, list[dict[str, Any]]] = {}
        for r in rules:
            fp = self._rule_fingerprint(r["condition"], r["conclusion"])
            r["fingerprint"] = fp
            groups.setdefault(fp, []).append(r)

        # Choose best per fingerprint: highest confidence, tie-breaker: earliest created_at.
        kept: list[dict[str, Any]] = []
        ids_to_delete: list[str] = []
        for fp, group in groups.items():
            def sort_key(x: dict[str, Any]) -> tuple[float, str]:
                # Higher confidence first; if confidence ties, earliest created_at first.
                conf = float(x.get("confidence", 0.0))
                created_at = str(x.get("created_at") or "9999-01-01T00:00:00+00:00")
                return (-conf, created_at)

            best = sorted(group, key=sort_key)[0]
            kept.append(best)
            for r in group:
                if r.get("rule_id") != best.get("rule_id"):
                    if r.get("rule_id"):
                        ids_to_delete.append(r["rule_id"])

        if not dry_run and ids_to_delete:
            with self._driver.session() as session:
                # Set fingerprint on kept rules (so future store_rule calls dedupe quickly).
                session.run(
                    """
                    UNWIND $keeps AS item
                    MATCH (r:Rule {rule_id: item.rule_id})
                    SET r.fingerprint = item.fingerprint
                    """,
                    keeps=[{"rule_id": r["rule_id"], "fingerprint": r["fingerprint"]} for r in kept if r.get("rule_id")],
                )
                session.run(
                    """
                    MATCH (r:Rule)
                    WHERE r.rule_id IN $ids
                    DETACH DELETE r
                    """,
                    ids=ids_to_delete,
                )

        return {
            "success": True,
            "dry_run": dry_run,
            "original_count": original,
            "unique_count": len(kept),
            "deleted_count": len(ids_to_delete),
        }

    async def _link_related_rules(self, rule_id: str, condition: str, conclusion: str) -> None:
        """Create edges between rules that share concepts (condition↔conclusion overlap)."""
        all_rules = await self.retrieve_rules()
        # Extract significant words (>3 chars) from this rule
        new_words = set(
            w.lower() for w in (condition + " " + conclusion).split()
            if len(w) > 3 and w.lower() not in ("then", "when", "that", "this", "with", "from", "have", "must", "should", "will", "does", "been")
        )
        if not new_words:
            return

        for existing in all_rules:
            if existing.get("rule_id") == rule_id:
                continue
            existing_words = set(
                w.lower() for w in (existing.get("condition", "") + " " + existing.get("conclusion", "")).split()
                if len(w) > 3 and w.lower() not in ("then", "when", "that", "this", "with", "from", "have", "must", "should", "will", "does", "been")
            )
            overlap = new_words & existing_words
            if len(overlap) >= 2:
                # Link: existing rule's conclusion feeds into new rule's condition (or vice versa)
                edge_type = "SUPPORTS"
                # If new rule's condition overlaps with existing conclusion → DEPENDS_ON
                cond_words = set(w.lower() for w in condition.split() if len(w) > 3)
                concl_words = set(w.lower() for w in existing.get("conclusion", "").split() if len(w) > 3)
                if cond_words & concl_words:
                    edge_type = "DEPENDS_ON"
                await self._store_rule_edge(existing.get("rule_id", ""), rule_id, edge_type, list(overlap))

    async def _store_rule_edge(self, source_rule_id: str, target_rule_id: str, edge_type: str, shared_concepts: list[str]) -> None:
        """Store an edge between two rules."""
        if self._use_fallback:
            if not hasattr(self, "_fallback_rule_edges"):
                self._fallback_rule_edges: list[dict[str, Any]] = []
            self._fallback_rule_edges.append({
                "source": source_rule_id,
                "target": target_rule_id,
                "edge_type": edge_type,
                "shared_concepts": shared_concepts,
            })
            return

        with self._driver.session() as session:
            session.run(
                """
                MATCH (a:Rule {rule_id: $source})
                MATCH (b:Rule {rule_id: $target})
                MERGE (a)-[e:RULE_EDGE {edge_type: $edge_type}]->(b)
                SET e.shared_concepts = $shared_concepts
                """,
                source=source_rule_id,
                target=target_rule_id,
                edge_type=edge_type,
                shared_concepts=json.dumps(shared_concepts),
            )

    async def retrieve_rules_graph(self) -> dict[str, Any]:
        """Return rules as a graph with nodes and edges for visualization."""
        all_rules = await self.retrieve_rules()
        nodes = []
        for r in all_rules:
            nodes.append({
                "id": r.get("rule_id", ""),
                "condition": r.get("condition", ""),
                "conclusion": r.get("conclusion", ""),
                "confidence": r.get("confidence", 0.5),
                "created_at": r.get("created_at", ""),
            })

        edges: list[dict[str, Any]] = []
        if self._use_fallback:
            edges = getattr(self, "_fallback_rule_edges", [])
        elif self._driver:
            with self._driver.session() as session:
                result = session.run(
                    """
                    MATCH (a:Rule)-[e:RULE_EDGE]->(b:Rule)
                    RETURN a.rule_id AS source, b.rule_id AS target,
                           e.edge_type AS edge_type, e.shared_concepts AS shared_concepts
                    """
                )
                for record in result:
                    shared = record.get("shared_concepts", "[]")
                    if isinstance(shared, str):
                        try:
                            shared = json.loads(shared)
                        except Exception:
                            shared = []
                    edges.append({
                        "source": record["source"],
                        "target": record["target"],
                        "edge_type": record["edge_type"],
                        "shared_concepts": shared,
                    })

        return {"nodes": nodes, "edges": edges}

    async def retrieve(self, query: str, limit: int = 10, session_id: str | None = None) -> list[MemoryEntry]:
        if self._use_fallback:
            results = []
            for m in self._fallback_memories:
                if query.lower() in json.dumps(m).lower():
                    if session_id:
                        content = m.get("content", {})
                        tags = m.get("tags", [])
                        if session_id not in str(content) and f"session:{session_id}" not in tags:
                            continue
                    results.append(MemoryEntry(**m))
                    if len(results) >= limit:
                        break
            return results

        params: dict[str, Any] = {"q": query, "limit": limit}
        where_extra = ""
        if session_id:
            where_extra = " AND (m.content CONTAINS $session_id OR m.tags CONTAINS $session_tag)"
            params["session_id"] = session_id
            params["session_tag"] = f"session:{session_id}"

        with self._driver.session() as session:
            result = session.run(
                f"""
                MATCH (m:Memory)
                WHERE m.content CONTAINS $q OR m.tags CONTAINS $q{where_extra}
                RETURN m
                ORDER BY m.created_at DESC
                LIMIT $limit
                """,
                **params,
            )
            entries = []
            for record in result:
                node = record["m"]
                entries.append(MemoryEntry(
                    memory_id=node["memory_id"],
                    memory_type=MemoryType(node["memory_type"]),
                    content=json.loads(node["content"]),
                    graph_reference=node.get("graph_reference", ""),
                    user_reference=node.get("user_reference", ""),
                    tags=json.loads(node.get("tags", "[]")),
                    created_at=node.get("created_at", ""),
                ))
            return entries

    async def retrieve_nodes_by_tier(
        self,
        tier: str,
        session_id: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Retrieve ReasoningNode entries filtered by graph tier (foundational / active)."""
        if self._use_fallback:
            return []

        params: dict[str, Any] = {"tier": tier, "limit": limit}
        session_filter = ""
        if session_id:
            session_filter = " AND n.session_id = $session_id"
            params["session_id"] = session_id

        with self._driver.session() as session:
            result = session.run(
                f"""
                MATCH (n:ReasoningNode)
                WHERE COALESCE(n.tier, 'foundational') = $tier{session_filter}
                RETURN n
                ORDER BY n.confidence DESC
                LIMIT $limit
                """,
                **params,
            )
            nodes = []
            for record in result:
                node = dict(record["n"])
                # Parse attributes back from JSON string if needed
                attrs = node.get("attributes", "{}")
                if isinstance(attrs, str):
                    try:
                        node["attributes"] = json.loads(attrs)
                    except Exception:
                        pass
                nodes.append(node)
            return nodes

    async def set_pending_teaching(self, session_id: str, payload: dict[str, Any]) -> None:
        """Store a pending teaching flow for a session (clarifying Q follow-up)."""
        if self._use_fallback:
            self._fallback_pending_teaching[session_id] = payload
            return

        # Persist as a semantic Memory entry. We keep the shape flexible in `payload`,
        # and rely on `type=teaching_pending` + `session_id` for retrieval.
        entry = MemoryEntry(
            memory_type=MemoryType.SEMANTIC,
            content={
                "type": "teaching_pending",
                "session_id": session_id,
                **payload,
            },
            graph_reference=session_id,
            tags=["teaching_pending", f"session:{session_id}"],
        )
        await self.store(entry)

    async def get_pending_teaching(self, session_id: str) -> dict[str, Any] | None:
        """Return pending teaching payload for a session, if any."""
        if self._use_fallback:
            return self._fallback_pending_teaching.get(session_id)

        if not self._driver:
            return None

        # Find most recent "teaching_pending" memory for this session.
        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (m:Memory)
                WHERE m.memory_type = $mtype
                  AND m.content CONTAINS $type_marker
                  AND m.content CONTAINS $session_id
                RETURN m
                ORDER BY m.created_at DESC
                LIMIT 1
                """,
                mtype=MemoryType.SEMANTIC.value,
                type_marker='"type": "teaching_pending"',
                session_id=session_id,
            )
            record = result.single()
            if not record:
                return None
            node = record["m"]
            try:
                content = json.loads(node["content"])
            except Exception:
                return None
            if isinstance(content, dict) and content.get("type") == "teaching_pending":
                return content
            return None

    async def clear_pending_teaching(self, session_id: str) -> None:
        """Clear pending teaching state for a session."""
        if self._use_fallback:
            self._fallback_pending_teaching.pop(session_id, None)
            return

        if not self._driver:
            return

        with self._driver.session() as session:
            session.run(
                """
                MATCH (m:Memory)
                WHERE m.memory_type = $mtype
                  AND m.content CONTAINS $type_marker
                  AND m.content CONTAINS $session_id
                DETACH DELETE m
                """,
                mtype=MemoryType.SEMANTIC.value,
                type_marker='"type": "teaching_pending"',
                session_id=session_id,
            )

    async def set_pending_self_teaching(self, self_teaching_id: str, payload: dict[str, Any]) -> None:
        """Store pending self-teaching workflow state for a given self_teaching_id."""
        if self._use_fallback:
            self._fallback_pending_self_teaching[self_teaching_id] = payload
            return

        if not self._driver:
            return

        entry = MemoryEntry(
            memory_type=MemoryType.SEMANTIC,
            content={
                "type": "self_teaching_pending",
                "self_teaching_id": self_teaching_id,
                **payload,
            },
            graph_reference=self_teaching_id,
            tags=["self_teaching_pending", f"self_teaching_id:{self_teaching_id}"],
        )
        await self.store(entry)

    async def get_pending_self_teaching(self, self_teaching_id: str) -> dict[str, Any] | None:
        """Return pending self-teaching payload for a self_teaching_id, if any."""
        if self._use_fallback:
            return self._fallback_pending_self_teaching.get(self_teaching_id)

        if not self._driver:
            return None

        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (m:Memory)
                WHERE m.memory_type = $mtype
                  AND m.content CONTAINS $type_marker
                  AND m.content CONTAINS $self_teaching_id
                RETURN m
                ORDER BY m.created_at DESC
                LIMIT 1
                """,
                mtype=MemoryType.SEMANTIC.value,
                type_marker='"type": "self_teaching_pending"',
                self_teaching_id=self_teaching_id,
            )
            record = result.single()
            if not record:
                return None

            node = record["m"]
            try:
                content = json.loads(node["content"])
            except Exception:
                return None

            if isinstance(content, dict) and content.get("type") == "self_teaching_pending":
                content.pop("type", None)
                return content

            return None

    async def clear_pending_self_teaching(self, self_teaching_id: str) -> None:
        """Clear pending self-teaching state for a self_teaching_id."""
        if self._use_fallback:
            self._fallback_pending_self_teaching.pop(self_teaching_id, None)
            return

        if not self._driver:
            return

        with self._driver.session() as session:
            session.run(
                """
                MATCH (m:Memory)
                WHERE m.memory_type = $mtype
                  AND m.content CONTAINS $type_marker
                  AND m.content CONTAINS $self_teaching_id
                DETACH DELETE m
                """,
                mtype=MemoryType.SEMANTIC.value,
                type_marker='"type": "self_teaching_pending"',
                self_teaching_id=self_teaching_id,
            )

    async def retrieve_rules(self, keywords: list[str] | None = None) -> list[dict[str, Any]]:
        if self._use_fallback:
            if not keywords:
                return self._fallback_rules
            return [
                r
                for r in self._fallback_rules
                if any(
                    kw.lower() in (r.get("condition") or "").lower()
                    or kw.lower() in (r.get("conclusion") or "").lower()
                    for kw in keywords
                )
            ]

        with self._driver.session() as session:
            if keywords:
                where_clause = " OR ".join(
                    [f"r.condition CONTAINS '{kw}' OR r.conclusion CONTAINS '{kw}'" for kw in keywords]
                )
                result = session.run(
                    f"MATCH (r:Rule) WHERE {where_clause} RETURN r ORDER BY r.confidence DESC"
                )
            else:
                result = session.run("MATCH (r:Rule) RETURN r ORDER BY r.confidence DESC")

            return [self._rule_node_to_dict(record["r"]) for record in result]

    async def query_by_type(self, memory_type: MemoryType, limit: int = 20) -> list[MemoryEntry]:
        if self._use_fallback:
            return [
                MemoryEntry(**m) for m in self._fallback_memories
                if m.get("memory_type") == memory_type.value
            ][:limit]

        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (m:Memory {memory_type: $mtype})
                RETURN m
                ORDER BY m.created_at DESC
                LIMIT $limit
                """,
                mtype=memory_type.value,
                limit=limit,
            )
            return [
                MemoryEntry(
                    memory_id=record["m"]["memory_id"],
                    memory_type=MemoryType(record["m"]["memory_type"]),
                    content=json.loads(record["m"]["content"]),
                    graph_reference=record["m"].get("graph_reference", ""),
                    user_reference=record["m"].get("user_reference", ""),
                    tags=json.loads(record["m"].get("tags", "[]")),
                    created_at=record["m"].get("created_at", ""),
                )
                for record in result
            ]

    async def delete_rule(self, rule_id: str) -> None:
        """Delete a single rule by ID."""
        if self._use_fallback:
            self._fallback_rules = [r for r in self._fallback_rules if r.get("rule_id") != rule_id]
            logger.info("Rule deleted (fallback): %s", rule_id)
            return

        with self._driver.session() as session:
            session.run("MATCH (r:Rule {rule_id: $rule_id}) DETACH DELETE r", rule_id=rule_id)
        logger.info("Rule deleted (Neo4j): %s", rule_id)

    async def update_rule(
        self,
        rule_id: str,
        condition: str | None = None,
        conclusion: str | None = None,
        confidence: float | None = None,
    ) -> None:
        """Update fields on an existing rule."""
        if self._use_fallback:
            for r in self._fallback_rules:
                if r.get("rule_id") == rule_id:
                    if condition is not None:
                        r["condition"] = condition
                    if conclusion is not None:
                        r["conclusion"] = conclusion
                    if confidence is not None:
                        r["confidence"] = confidence
            logger.info("Rule updated (fallback): %s", rule_id)
            return

        set_clauses = []
        params: dict[str, Any] = {"rule_id": rule_id}
        if condition is not None:
            set_clauses.append("r.condition = $condition")
            params["condition"] = condition
        if conclusion is not None:
            set_clauses.append("r.conclusion = $conclusion")
            params["conclusion"] = conclusion
        if confidence is not None:
            set_clauses.append("r.confidence = $confidence")
            params["confidence"] = confidence

        if set_clauses:
            with self._driver.session() as session:
                session.run(
                    f"MATCH (r:Rule {{rule_id: $rule_id}}) SET {', '.join(set_clauses)}",
                    **params,
                )
        logger.info("Rule updated (Neo4j): %s", rule_id)

    async def snapshot_rules(self, session_id: str) -> dict[str, Any]:
        """Create a snapshot of all current rules before a self-teaching session.

        Returns the snapshot with an ID so it can be restored later if needed.
        """
        all_rules = await self.retrieve_rules()
        snapshot_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        snapshot = {
            "snapshot_id": snapshot_id,
            "session_id": session_id,
            "created_at": now,
            "rules": all_rules,
            "rule_count": len(all_rules),
        }

        # Store as a semantic memory entry for retrieval
        entry = MemoryEntry(
            memory_type=MemoryType.SEMANTIC,
            content={
                "type": "rules_snapshot",
                **snapshot,
            },
            graph_reference=session_id,
            tags=["rules_snapshot", f"session:{session_id}"],
        )
        await self.store(entry)
        logger.info("Rules snapshot created: %s (%d rules)", snapshot_id, len(all_rules))
        return snapshot

    async def restore_rules_snapshot(self, snapshot_id: str) -> dict[str, Any]:
        """Restore rules from a snapshot, replacing current rules."""
        # Find the snapshot
        entries = await self.retrieve(snapshot_id, limit=1)
        if not entries:
            return {"success": False, "error": "Snapshot not found"}

        content = entries[0].content
        if not isinstance(content, dict) or content.get("type") != "rules_snapshot":
            return {"success": False, "error": "Invalid snapshot"}

        snapshot_rules = content.get("rules", [])

        # Clear current rules and restore from snapshot
        if not self._use_fallback and self._driver:
            with self._driver.session() as session:
                session.run("MATCH (r:Rule) DETACH DELETE r")
                for rule in snapshot_rules:
                    session.run(
                        """
                        MERGE (r:Rule {rule_id: $rule_id})
                        SET r.condition = $condition,
                            r.conclusion = $conclusion,
                            r.confidence = $confidence,
                            r.usage_count = $usage_count,
                            r.created_at = $created_at
                        """,
                        rule_id=rule.get("rule_id", str(uuid.uuid4())),
                        condition=rule.get("condition", ""),
                        conclusion=rule.get("conclusion", ""),
                        confidence=rule.get("confidence", 0.5),
                        usage_count=rule.get("usage_count", 0),
                        created_at=rule.get("created_at", datetime.now(timezone.utc).isoformat()),
                    )
        else:
            self._fallback_rules = list(snapshot_rules)

        logger.info("Rules restored from snapshot %s (%d rules)", snapshot_id, len(snapshot_rules))
        return {"success": True, "restored_count": len(snapshot_rules)}

    async def apply_feedback(
        self,
        session_id: str,
        node_id: str,
        feedback_type: str,
        comment: str,
    ) -> None:
        logger.info("Feedback received: session=%s, node=%s, type=%s", session_id, node_id, feedback_type)

        if feedback_type == "correction" and comment:
            await self.store_rule(
                condition=f"session context: {session_id}",
                conclusion=comment,
                confidence=0.8,
            )

        entry = MemoryEntry(
            memory_type=MemoryType.EPISODIC,
            content={
                "type": "feedback",
                "session_id": session_id,
                "node_id": node_id,
                "feedback_type": feedback_type,
                "comment": comment,
            },
            graph_reference=session_id,
            tags=["feedback", feedback_type],
        )
        await self.store(entry)

    # ==========================================================================
    # CODE KNOWLEDGE GRAPH QUERIES
    # ==========================================================================

    async def search_code_symbols(self, query: str, symbol_type: str | None = None, limit: int = 10, path_prefixes: list[str] | None = None) -> list[dict[str, Any]]:
        """Search for code symbols by name in the code knowledge graph.

        Args:
            query: Search query (symbol name, file path, etc.)
            symbol_type: Optional filter by type (function, class, interface, etc.)
            limit: Maximum results to return
            path_prefixes: Optional list of path prefixes to scope results (e.g. ['services/code_indexer', 'apps/oasis-ui-react'])

        Returns:
            List of symbol information dictionaries
        """
        if self._use_fallback:
            return []

        type_clause = " AND s.type = $stype" if symbol_type else ""
        path_clause = ""
        if path_prefixes:
            # Build an OR clause: file_path STARTS WITH prefix1 OR file_path STARTS WITH prefix2 ...
            path_conditions = " OR ".join(
                f"coalesce(s.file_path, '') STARTS WITH $pp{i}"
                for i in range(len(path_prefixes))
            )
            path_clause = f" AND ({path_conditions})"

        params: dict[str, Any] = {"query": query, "limit": limit}
        if symbol_type:
            params["stype"] = symbol_type
        if path_prefixes:
            for i, pp in enumerate(path_prefixes):
                params[f"pp{i}"] = pp

        with self._driver.session() as session:
            result = session.run(
                f"""
                MATCH (s:CodeSymbol)
                WHERE (s.name CONTAINS $query OR coalesce(s.file_path, '') CONTAINS $query){type_clause}{path_clause}
                RETURN s.name AS name, s.type AS type, s.signature AS signature,
                       coalesce(s.file_path, '') AS file_path, s.line_start AS line_start,
                       s.docstring AS docstring, s.is_exported AS is_exported
                ORDER BY s.name
                LIMIT $limit
                """,
                **params,
            )

            symbols = []
            for record in result:
                symbols.append({
                    "name": record["name"],
                    "type": record["type"],
                    "signature": record["signature"],
                    "file_path": record["file_path"],
                    "line_start": record["line_start"],
                    "docstring": record["docstring"],
                    "is_exported": record["is_exported"],
                })

            return symbols

    async def get_symbol_references(self, symbol_id: str) -> list[dict[str, Any]]:
        """Get all references to a symbol.

        Args:
            symbol_id: Symbol ID (format: file_path:name:line_start)

        Returns:
            List of references with context
        """
        if self._use_fallback:
            return []

        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (source:CodeSymbol)-[:CALLS|REFERENCES]->(target:CodeSymbol {id: $id})
                RETURN source.name AS name, target.name AS referenced_name,
                       target.file_path AS file_path, target.line_start AS line_start
                LIMIT 50
                """,
                id=symbol_id,
            )

            references = []
            for record in result:
                references.append({
                    "name": record["name"],
                    "referenced_name": record["referenced_name"],
                    "file_path": record["file_path"],
                    "line_start": record["line_start"],
                })

            return references

    async def get_component_hierarchy(self, root_name: str) -> list[dict[str, Any]]:
        """Get React/component hierarchy starting from root.

        Args:
            root_name: Name of root component

        Returns:
            List of components in hierarchy
        """
        if self._use_fallback:
            return []

        with self._driver.session() as session:
            # Find root symbol
            result = session.run(
                """
                MATCH (s:CodeSymbol)
                WHERE s.name = $name AND s.type IN ['function', 'class']
                RETURN s
                LIMIT 1
                """,
                name=root_name,
            )
            record = result.single()
            if not record:
                return []

            root_sym = record["s"]
            resolved_root_name = root_sym["name"]
            root_fp = root_sym.get("file_path") or ""

            # Find children (symbols called by root)
            children_result = session.run(
                """
                MATCH (s:CodeSymbol {name: $name})-[:CALLS]->(child:CodeSymbol)
                WHERE child.type IN ['function', 'class']
                RETURN child.name AS name, child.file_path AS file_path, child.line_start AS line_start
                LIMIT 20
                """,
                name=resolved_root_name,
            )

            hierarchy = [{"name": resolved_root_name, "file_path": root_fp, "line_start": root_sym.get("line_start", 0)}]
            for child_rec in children_result:
                hierarchy.append({
                    "name": child_rec["name"],
                    "file_path": child_rec["file_path"],
                    "line_start": child_rec["line_start"],
                })

            return hierarchy

    async def get_imports_for_file(self, file_path: str) -> list[dict[str, Any]]:
        """Get imports for a specific file.

        Args:
            file_path: Path to file

        Returns:
            List of imported modules
        """
        if self._use_fallback:
            return []

        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (f:CodeFile {path: $path})-[i:IMPORTS]->(m:CodeModule)
                RETURN m.name AS name, i.imported_names AS imported_names,
                       i.is_default AS is_default, i.is_namespace AS is_namespace
                """,
                path=file_path,
            )

            imports = []
            for record in result:
                raw_names = record["imported_names"]
                if isinstance(raw_names, str):
                    try:
                        parsed = json.loads(raw_names)
                        raw_names = parsed if isinstance(parsed, list) else []
                    except (json.JSONDecodeError, TypeError):
                        raw_names = []
                imports.append({
                    "name": record["name"],
                    "imported_names": raw_names,
                    "is_default": record["is_default"],
                    "is_namespace": record["is_namespace"],
                })

            return imports

    # ── Artifact Library: Project CRUD ──────────────────────────────────

    async def create_project(self, name: str, description: str = "", project_path: str = "") -> dict[str, Any]:
        project_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        data = {"project_id": project_id, "name": name, "description": description,
                "project_path": project_path, "created_at": now, "updated_at": now}
        if self._use_fallback:
            if not hasattr(self, "_fallback_projects"):
                self._fallback_projects: list[dict[str, Any]] = []
            self._fallback_projects.append(data)
            return data
        with self._driver.session() as session:
            session.run(
                """
                CREATE (p:Project {project_id: $project_id, name: $name, description: $description,
                        project_path: $project_path, created_at: $created_at, updated_at: $updated_at})
                """, **data,
            )
        return data

    async def list_projects(self) -> list[dict[str, Any]]:
        if self._use_fallback:
            return getattr(self, "_fallback_projects", [])
        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (p:Project)
                OPTIONAL MATCH (p)-[:HAS_ARTIFACT]->(a:Artifact)
                OPTIONAL MATCH (p)-[:HAS_CHAT]->(c:ChatSession)
                OPTIONAL MATCH (p)-[:HAS_REPO]->(r:Repo)
                RETURN p, count(DISTINCT a) AS artifact_count,
                       count(DISTINCT c) AS chat_count,
                       count(DISTINCT r) AS repo_count
                ORDER BY p.created_at DESC
                """
            )
            projects = []
            for record in result:
                node = record["p"]
                projects.append({
                    "project_id": node["project_id"], "name": node["name"],
                    "description": node.get("description", ""),
                    "project_path": node.get("project_path", ""),
                    "created_at": node.get("created_at", ""), "updated_at": node.get("updated_at", ""),
                    "artifact_count": record["artifact_count"],
                    "chat_count": record["chat_count"],
                    "repo_count": record["repo_count"],
                })
            return projects

    async def get_project(self, project_id: str) -> dict[str, Any] | None:
        if self._use_fallback:
            for p in getattr(self, "_fallback_projects", []):
                if p["project_id"] == project_id:
                    return p
            return None
        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (p:Project {project_id: $pid})
                OPTIONAL MATCH (p)-[:HAS_ARTIFACT]->(a:Artifact)
                OPTIONAL MATCH (p)-[:HAS_CHAT]->(c:ChatSession)
                OPTIONAL MATCH (p)-[:HAS_REPO]->(r:Repo)
                RETURN p, collect(DISTINCT a) AS artifacts,
                       collect(DISTINCT c) AS chats,
                       collect(DISTINCT r) AS repos
                """, pid=project_id,
            ).single()
            if not result or not result["p"]:
                return None
            node = result["p"]
            return {
                "project_id": node["project_id"], "name": node["name"],
                "description": node.get("description", ""),
                "project_path": node.get("project_path", ""),
                "created_at": node.get("created_at", ""), "updated_at": node.get("updated_at", ""),
                "artifacts": [dict(a) for a in result["artifacts"] if a],
                "chats": [dict(c) for c in result["chats"] if c],
                "repos": [dict(r) for r in result["repos"] if r],
            }

    async def update_project(self, project_id: str, name: str | None = None, description: str | None = None, project_path: str | None = None) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        if self._use_fallback:
            for p in getattr(self, "_fallback_projects", []):
                if p["project_id"] == project_id:
                    if name is not None:
                        p["name"] = name
                    if description is not None:
                        p["description"] = description
                    if project_path is not None:
                        p["project_path"] = project_path
                    p["updated_at"] = now
                    return True
            return False
        with self._driver.session() as session:
            sets = ["p.updated_at = $now"]
            params: dict[str, Any] = {"pid": project_id, "now": now}
            if name is not None:
                sets.append("p.name = $name")
                params["name"] = name
            if description is not None:
                sets.append("p.description = $description")
                params["description"] = description
            if project_path is not None:
                sets.append("p.project_path = $project_path")
                params["project_path"] = project_path
            result = session.run(f"MATCH (p:Project {{project_id: $pid}}) SET {', '.join(sets)} RETURN p", **params)
            return result.single() is not None

    async def delete_project(self, project_id: str) -> bool:
        if self._use_fallback:
            projects = getattr(self, "_fallback_projects", [])
            before = len(projects)
            self._fallback_projects = [p for p in projects if p["project_id"] != project_id]
            return len(self._fallback_projects) < before
        with self._driver.session() as session:
            result = session.run(
                "MATCH (p:Project {project_id: $pid}) DETACH DELETE p RETURN count(p) AS deleted",
                pid=project_id,
            ).single()
            return (result["deleted"] if result else 0) > 0

    # ── Artifact Library: Artifact CRUD ──────────────────────────────────

    async def create_artifact(self, *, name: str, mime_type: str, file_path: str,
                              file_size: int, source_type: str = "upload",
                              source_url: str | None = None, language: str | None = None) -> dict[str, Any]:
        artifact_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        data = {
            "artifact_id": artifact_id, "name": name, "mime_type": mime_type,
            "file_path": file_path, "file_size": file_size,
            "source_type": source_type, "source_url": source_url or "",
            "status": "pending", "transcript": "", "language": language or "",
            "created_at": now, "updated_at": now,
        }
        if self._use_fallback:
            if not hasattr(self, "_fallback_artifacts"):
                self._fallback_artifacts: list[dict[str, Any]] = []
            self._fallback_artifacts.append(data)
            return data
        with self._driver.session() as session:
            session.run(
                """
                CREATE (a:Artifact {
                    artifact_id: $artifact_id, name: $name, mime_type: $mime_type,
                    file_path: $file_path, file_size: $file_size,
                    source_type: $source_type, source_url: $source_url,
                    status: $status, transcript: $transcript, language: $language,
                    created_at: $created_at, updated_at: $updated_at
                })
                """, **data,
            )
        return data

    async def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        if self._use_fallback:
            for a in getattr(self, "_fallback_artifacts", []):
                if a["artifact_id"] == artifact_id:
                    return a
            return None
        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (a:Artifact {artifact_id: $aid})
                OPTIONAL MATCH (p:Project)-[:HAS_ARTIFACT]->(a)
                RETURN a, collect(p.project_id) AS project_ids
                """, aid=artifact_id,
            ).single()
            if not result or not result["a"]:
                return None
            node = dict(result["a"])
            node["projects"] = [pid for pid in result["project_ids"] if pid]
            return node

    async def list_artifacts(self, project_id: str | None = None) -> list[dict[str, Any]]:
        if self._use_fallback:
            return getattr(self, "_fallback_artifacts", [])
        with self._driver.session() as session:
            if project_id:
                result = session.run(
                    """
                    MATCH (p:Project {project_id: $pid})-[:HAS_ARTIFACT]->(a:Artifact)
                    RETURN a ORDER BY a.created_at DESC
                    """, pid=project_id,
                )
            else:
                result = session.run("MATCH (a:Artifact) RETURN a ORDER BY a.created_at DESC")
            return [dict(record["a"]) for record in result]

    async def update_artifact(self, artifact_id: str, **kwargs: Any) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        if self._use_fallback:
            for a in getattr(self, "_fallback_artifacts", []):
                if a["artifact_id"] == artifact_id:
                    a.update(kwargs)
                    a["updated_at"] = now
                    return True
            return False
        allowed = {"status", "transcript", "language", "name", "mime_type", "summary"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return False
        with self._driver.session() as session:
            sets = ", ".join(f"a.{k} = ${k}" for k in updates)
            updates["aid"] = artifact_id
            updates["now"] = now
            result = session.run(
                f"MATCH (a:Artifact {{artifact_id: $aid}}) SET {sets}, a.updated_at = $now RETURN a",
                **updates,
            )
            return result.single() is not None

    async def delete_artifact(self, artifact_id: str) -> bool:
        if self._use_fallback:
            artifacts = getattr(self, "_fallback_artifacts", [])
            before = len(artifacts)
            self._fallback_artifacts = [a for a in artifacts if a["artifact_id"] != artifact_id]
            return len(self._fallback_artifacts) < before
        with self._driver.session() as session:
            # Delete related Embedding nodes first, then the Artifact itself
            session.run(
                "MATCH (a:Artifact {artifact_id: $aid})-[:HAS_EMBEDDING]->(e:Embedding) DETACH DELETE e",
                aid=artifact_id,
            )
            result = session.run(
                "MATCH (a:Artifact {artifact_id: $aid}) DETACH DELETE a RETURN count(a) AS deleted",
                aid=artifact_id,
            ).single()
            return (result["deleted"] if result else 0) > 0

    # ── Artifact Library: Linking ────────────────────────────────────────

    async def link_artifact_to_project(self, project_id: str, artifact_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid}), (a:Artifact {artifact_id: $aid})
                MERGE (p)-[:HAS_ARTIFACT]->(a)
                """, pid=project_id, aid=artifact_id,
            )
            return True

    async def unlink_artifact_from_project(self, project_id: str, artifact_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid})-[r:HAS_ARTIFACT]->(a:Artifact {artifact_id: $aid})
                DELETE r
                """, pid=project_id, aid=artifact_id,
            )
            return True

    async def create_chat_session_node(self, session_id: str, label: str = "") -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        data = {"session_id": session_id, "label": label, "created_at": now}
        if self._use_fallback:
            return data
        with self._driver.session() as session:
            session.run(
                "MERGE (cs:ChatSession {session_id: $session_id}) SET cs.label = $label, cs.created_at = $created_at",
                **data,
            )
        return data

    async def link_chat_to_project(self, project_id: str, session_id: str) -> bool:
        if self._use_fallback:
            return True
        await self.create_chat_session_node(session_id)
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid}), (cs:ChatSession {session_id: $sid})
                MERGE (p)-[:HAS_CHAT]->(cs)
                """, pid=project_id, sid=session_id,
            )
            return True

    async def unlink_chat_from_project(self, project_id: str, session_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid})-[r:HAS_CHAT]->(cs:ChatSession {session_id: $sid})
                DELETE r
                """, pid=project_id, sid=session_id,
            )
            return True

    async def create_repo(self, git_url: str, project_path: str = "", name: str = "") -> dict[str, Any]:
        repo_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        data = {"repo_id": repo_id, "git_url": git_url, "project_path": project_path, "name": name or git_url.split("/")[-1], "created_at": now}
        if self._use_fallback:
            return data
        with self._driver.session() as session:
            session.run(
                "CREATE (r:Repo {repo_id: $repo_id, git_url: $git_url, project_path: $project_path, name: $name, created_at: $created_at})",
                **data,
            )
        return data

    async def link_repo_to_project(self, project_id: str, repo_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid}), (r:Repo {repo_id: $rid})
                MERGE (p)-[:HAS_REPO]->(r)
                """, pid=project_id, rid=repo_id,
            )
            return True

    async def unlink_repo_from_project(self, project_id: str, repo_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (p:Project {project_id: $pid})-[r:HAS_REPO]->(rp:Repo {repo_id: $rid})
                DELETE r
                """, pid=project_id, rid=repo_id,
            )
            return True

    # ── Artifact Library: Embeddings ─────────────────────────────────────

    async def store_embedding(self, artifact_id: str, chunk_index: int, chunk_text: str,
                              vector: list[float], model: str) -> str:
        embedding_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        if self._use_fallback:
            return embedding_id
        with self._driver.session() as session:
            session.run(
                """
                MATCH (a:Artifact {artifact_id: $aid})
                CREATE (e:Embedding {
                    embedding_id: $eid, artifact_id: $aid, chunk_index: $idx,
                    chunk_text: $text, vector: $vector, model: $model, created_at: $now
                })
                CREATE (a)-[:HAS_EMBEDDING]->(e)
                """,
                aid=artifact_id, eid=embedding_id, idx=chunk_index,
                text=chunk_text, vector=vector, model=model, now=now,
            )
        return embedding_id

    async def search_embeddings(self, query_vector: list[float], limit: int = 10,
                                project_id: str | None = None) -> list[dict[str, Any]]:
        """Cosine similarity search over Embedding nodes."""
        if self._use_fallback:
            return []
        with self._driver.session() as session:
            if project_id:
                result = session.run(
                    """
                    MATCH (p:Project {project_id: $pid})-[:HAS_ARTIFACT]->(a:Artifact)-[:HAS_EMBEDDING]->(e:Embedding)
                    WITH e, a,
                         reduce(dot = 0.0, i IN range(0, size(e.vector)-1) |
                             dot + e.vector[i] * $qv[i]) AS dot_product,
                         reduce(n1 = 0.0, i IN range(0, size(e.vector)-1) |
                             n1 + e.vector[i] * e.vector[i]) AS norm1,
                         reduce(n2 = 0.0, i IN range(0, size($qv)-1) |
                             n2 + $qv[i] * $qv[i]) AS norm2
                    WITH e, a, dot_product / (sqrt(norm1) * sqrt(norm2) + 1e-10) AS similarity
                    ORDER BY similarity DESC
                    LIMIT $limit
                    RETURN e.chunk_text AS chunk_text, e.chunk_index AS chunk_index,
                           e.artifact_id AS artifact_id, a.name AS artifact_name,
                           similarity
                    """, pid=project_id, qv=query_vector, limit=limit,
                )
            else:
                result = session.run(
                    """
                    MATCH (a:Artifact)-[:HAS_EMBEDDING]->(e:Embedding)
                    WITH e, a,
                         reduce(dot = 0.0, i IN range(0, size(e.vector)-1) |
                             dot + e.vector[i] * $qv[i]) AS dot_product,
                         reduce(n1 = 0.0, i IN range(0, size(e.vector)-1) |
                             n1 + e.vector[i] * e.vector[i]) AS norm1,
                         reduce(n2 = 0.0, i IN range(0, size($qv)-1) |
                             n2 + $qv[i] * $qv[i]) AS norm2
                    WITH e, a, dot_product / (sqrt(norm1) * sqrt(norm2) + 1e-10) AS similarity
                    ORDER BY similarity DESC
                    LIMIT $limit
                    RETURN e.chunk_text AS chunk_text, e.chunk_index AS chunk_index,
                           e.artifact_id AS artifact_id, a.name AS artifact_name,
                           similarity
                    """, qv=query_vector, limit=limit,
                )
            return [dict(record) for record in result]

    # ── Artifact Library: Project-scoped rules ───────────────────────────

    async def scope_rule_to_project(self, rule_id: str, project_id: str) -> bool:
        if self._use_fallback:
            return True
        with self._driver.session() as session:
            session.run(
                """
                MATCH (r:Rule {rule_id: $rid}), (p:Project {project_id: $pid})
                MERGE (r)-[:SCOPED_TO]->(p)
                """, rid=rule_id, pid=project_id,
            )
            return True

    async def retrieve_rules_for_project(self, project_id: str, keywords: list[str] | None = None) -> list[dict[str, Any]]:
        """Return global rules (no SCOPED_TO) + rules scoped to this project."""
        if self._use_fallback:
            return getattr(self, "_fallback_rules", [])
        with self._driver.session() as session:
            result = session.run(
                """
                MATCH (r:Rule)
                WHERE NOT (r)-[:SCOPED_TO]->(:Project)
                   OR (r)-[:SCOPED_TO]->(:Project {project_id: $pid})
                RETURN r
                ORDER BY r.confidence DESC
                """, pid=project_id,
            )
            rules = []
            for record in result:
                rules.append(self._rule_node_to_dict(record["r"]))
            if keywords:
                kw_lower = [k.lower() for k in keywords]
                rules = [
                    r for r in rules
                    if any(
                        kw in r.get("condition", "").lower() or kw in r.get("conclusion", "").lower()
                        for kw in kw_lower
                    )
                ]
            return rules

    # ── Artifact Library: Chat sessions for project ──────────────────────

    async def get_project_chat_sessions(self, project_id: str) -> list[str]:
        """Return session_ids linked to a project."""
        if self._use_fallback:
            return []
        with self._driver.session() as session:
            result = session.run(
                "MATCH (p:Project {project_id: $pid})-[:HAS_CHAT]->(cs:ChatSession) RETURN cs.session_id AS sid",
                pid=project_id,
            )
            return [record["sid"] for record in result if record["sid"]]

    # ── Speaker Profiles ──────────────────────────────────────────────────

    async def create_speaker_profile(self, *, name: str, embedding: list[float],
                                     source_artifact_id: str | None = None) -> dict[str, Any]:
        speaker_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        data = {
            "speaker_id": speaker_id,
            "name": name,
            "embedding": embedding,
            "source_artifact_id": source_artifact_id or "",
            "sample_count": 1,
            "created_at": now,
            "updated_at": now,
        }
        if self._use_fallback:
            if not hasattr(self, "_fallback_speakers"):
                self._fallback_speakers: list[dict[str, Any]] = []
            self._fallback_speakers.append(data)
            return data
        with self._driver.session() as session:
            session.run(
                """
                CREATE (sp:SpeakerProfile {
                    speaker_id: $speaker_id, name: $name, embedding: $embedding,
                    source_artifact_id: $source_artifact_id, sample_count: $sample_count,
                    created_at: $created_at, updated_at: $updated_at
                })
                """, **data,
            )
        return data

    async def list_speaker_profiles(self) -> list[dict[str, Any]]:
        if self._use_fallback:
            return getattr(self, "_fallback_speakers", [])
        with self._driver.session() as session:
            result = session.run("MATCH (sp:SpeakerProfile) RETURN sp ORDER BY sp.name")
            return [dict(record["sp"]) for record in result]

    async def get_speaker_profile(self, speaker_id: str) -> dict[str, Any] | None:
        if self._use_fallback:
            for sp in getattr(self, "_fallback_speakers", []):
                if sp["speaker_id"] == speaker_id:
                    return sp
            return None
        with self._driver.session() as session:
            result = session.run(
                "MATCH (sp:SpeakerProfile {speaker_id: $sid}) RETURN sp",
                sid=speaker_id,
            ).single()
            if not result or not result["sp"]:
                return None
            return dict(result["sp"])

    async def update_speaker_profile(self, speaker_id: str, **kwargs: Any) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        if self._use_fallback:
            for sp in getattr(self, "_fallback_speakers", []):
                if sp["speaker_id"] == speaker_id:
                    sp.update({k: v for k, v in kwargs.items() if v is not None})
                    sp["updated_at"] = now
                    return True
            return False
        allowed = {"name", "embedding", "sample_count", "source_artifact_id"}
        updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
        if not updates:
            return False
        with self._driver.session() as session:
            sets = ", ".join(f"sp.{k} = ${k}" for k in updates)
            updates["sid"] = speaker_id
            updates["now"] = now
            result = session.run(
                f"MATCH (sp:SpeakerProfile {{speaker_id: $sid}}) SET {sets}, sp.updated_at = $now RETURN sp",
                **updates,
            )
            return result.single() is not None

    async def delete_speaker_profile(self, speaker_id: str) -> bool:
        if self._use_fallback:
            speakers = getattr(self, "_fallback_speakers", [])
            before = len(speakers)
            self._fallback_speakers = [sp for sp in speakers if sp["speaker_id"] != speaker_id]
            return len(self._fallback_speakers) < before
        with self._driver.session() as session:
            result = session.run(
                "MATCH (sp:SpeakerProfile {speaker_id: $sid}) DETACH DELETE sp RETURN count(sp) AS deleted",
                sid=speaker_id,
            ).single()
            return (result["deleted"] if result else 0) > 0

    async def search_speaker_by_embedding(self, query_embedding: list[float],
                                          threshold: float = 0.65) -> list[dict[str, Any]]:
        """Find speaker profiles whose embedding is similar to query_embedding (cosine similarity)."""
        import math as _math

        profiles = await self.list_speaker_profiles()
        query = query_embedding
        q_norm = _math.sqrt(sum(x * x for x in query))
        if q_norm == 0:
            return []

        results = []
        for sp in profiles:
            emb = sp.get("embedding", [])
            if not emb or len(emb) != len(query):
                continue
            dot = sum(a * b for a, b in zip(query, emb))
            e_norm = _math.sqrt(sum(x * x for x in emb))
            if e_norm == 0:
                continue
            similarity = dot / (q_norm * e_norm)
            if similarity >= threshold:
                results.append({**sp, "similarity": round(similarity, 4)})

        results.sort(key=lambda r: r["similarity"], reverse=True)
        return results

    def close(self) -> None:
        if self._driver:
            self._driver.close()
