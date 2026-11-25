"""Knowledge packs: a versioned JSON export of one project's own rules.

A pack is what a person takes out of one project and brings into another (or keeps as
a copy). It holds the rules scoped to that project, never global rules or another
project's. The api-gateway names the project; this module never reads a project from
the pack itself, so importing a pack only writes into the project it was asked to.

Format (schema_version 1):

    {
      "schema_version": 1,
      "kind": "knowledge_pack",
      "metadata": {"name": ..., "scope": "project", "exported_at": ...,
                   "counts": {"rule": n, "skill": 0}},
      "items": [
        {"type": "rule", "visibility": "private", "condition": ..., "conclusion": ...,
         "confidence": 0.7},
      ],
    }

Skill items ({"type": "skill", "name": ..., "guidance": ...}) are part of the format and
are checked on import, but this memory service has no per-project skills to put them in,
so they are reported as skipped. `visibility` (private / team / public) is recorded for
later sharing; it defaults to private. Ids and project ids are left out so a pack can be
passed on without naming anyone.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = 1
PACK_KIND = "knowledge_pack"
VISIBILITIES = ("private", "team", "public")
DEFAULT_VISIBILITY = "private"
MAX_ITEMS = 2000

SKILL_NAME_MAX = 120
SKILL_DESCRIPTION_MAX = 500
SKILL_GUIDANCE_MAX = 4000
SKILL_KEYWORDS_MAX = 30
RULE_TEXT_MAX = 2000

SKILLS_UNSUPPORTED = "skills are not stored per project on this server"


class PackError(ValueError):
    """The pack as a whole cannot be read (wrong version, not a pack) or has nowhere to go."""


def _norm(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def _rule_item(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "rule",
        "visibility": DEFAULT_VISIBILITY,
        "condition": rule.get("condition") or "",
        "conclusion": rule.get("conclusion") or "",
        "confidence": float(rule.get("confidence") or 0.5),
    }


async def export_pack(memory: Any, *, project_id: str | None, name: str = "") -> dict[str, Any]:
    """A project's own rules (never global ones) as a pack."""
    if not project_id:
        raise PackError("export needs a project")
    items = [_rule_item(rule) for rule in await memory.project_own_rules(project_id)]
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": PACK_KIND,
        "metadata": {
            "name": name or "Project knowledge",
            "scope": "project",
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "counts": {"rule": len(items), "skill": 0},
        },
        "items": items,
    }


def check_pack(pack: Any) -> list[Any]:
    """The pack's items, or PackError when the pack itself is unreadable."""
    if not isinstance(pack, dict):
        raise PackError("a knowledge pack is a JSON object")
    version = pack.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise PackError("schema_version is missing")
    if version > SCHEMA_VERSION:
        raise PackError(f"schema_version {version} is newer than this server reads ({SCHEMA_VERSION})")
    if version < 1:
        raise PackError(f"schema_version {version} is not a known version")
    if pack.get("kind") not in (None, PACK_KIND):
        raise PackError(f"not a knowledge pack (kind {pack.get('kind')!r})")
    items = pack.get("items")
    if not isinstance(items, list):
        raise PackError("items must be a list")
    if len(items) > MAX_ITEMS:
        raise PackError(f"a pack holds at most {MAX_ITEMS} items")
    return items


def _label(item: Any) -> str:
    if not isinstance(item, dict):
        return "(not an object)"
    if item.get("type") == "skill":
        return str(item.get("name") or "")[:120]
    return f"IF {str(item.get('condition') or '')[:60]} THEN {str(item.get('conclusion') or '')[:60]}"


def _item_problem(item: Any) -> str | None:
    if not isinstance(item, dict):
        return "not an object"
    visibility = item.get("visibility", DEFAULT_VISIBILITY)
    if visibility not in VISIBILITIES:
        return f"unknown visibility {visibility!r}"
    kind = item.get("type")
    if kind == "rule":
        cond, concl = item.get("condition"), item.get("conclusion")
        if not isinstance(cond, str) or not isinstance(concl, str) or not concl.strip():
            return "a rule needs condition and conclusion text"
        if len(cond) > RULE_TEXT_MAX or len(concl) > RULE_TEXT_MAX:
            return "rule text is too long"
        conf = item.get("confidence", 0.5)
        if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not 0 <= conf <= 1:
            return "confidence must be a number from 0 to 1"
        return None
    if kind == "skill":
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > SKILL_NAME_MAX:
            return "a skill needs a name (at most 120 characters)"
        for field, limit in (("description", SKILL_DESCRIPTION_MAX), ("guidance", SKILL_GUIDANCE_MAX)):
            val = item.get(field, "")
            if not isinstance(val, str) or len(val) > limit:
                return f"{field} must be text of at most {limit} characters"
        if not (item.get("guidance") or "").strip() and not (item.get("description") or "").strip():
            return "a skill needs guidance or a description"
        keywords = item.get("keywords", [])
        if not isinstance(keywords, list) or len(keywords) > SKILL_KEYWORDS_MAX or not all(isinstance(k, str) for k in keywords):
            return f"keywords must be a list of at most {SKILL_KEYWORDS_MAX} words"
        return None
    return f"unknown item type {kind!r}"


async def import_pack(memory: Any, pack: Any, *, project_id: str | None) -> dict[str, Any]:
    """Merge a pack's rules into one project.

    A rule already in the project (same wording), already stored as a global rule, or
    repeated inside the pack is skipped. Returns what was added and what was skipped,
    with the reason.
    """
    items = check_pack(pack)
    if not project_id:
        raise PackError("import needs a project")
    if await memory.get_project(project_id) is None:
        raise PackError(f"unknown project {project_id!r}")

    rule_keys = {(_norm(r.get("condition")), _norm(r.get("conclusion"))) for r in await memory.project_own_rules(project_id)}
    added: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    def skip(item: Any, reason: str) -> None:
        kind = item.get("type") if isinstance(item, dict) and isinstance(item.get("type"), str) else "unknown"
        skipped.append({"type": kind, "label": _label(item), "reason": reason})

    for item in items:
        problem = _item_problem(item)
        if problem:
            skip(item, problem)
            continue
        if item["type"] == "skill":
            skip(item, SKILLS_UNSUPPORTED)
            continue
        cond = item["condition"].strip() or "General applicability"
        concl = item["conclusion"].strip()
        key = (_norm(cond), _norm(concl))
        if key in rule_keys:
            skip(item, "already there")
            continue
        existing = await memory.find_rule(cond, concl)
        if existing is not None and not existing.get("project_ids"):
            # Scoping a global rule to one project would take it away from every other one.
            skip(item, "already there as a global rule")
            rule_keys.add(key)
            continue
        rule_id = await memory.store_rule(cond, concl, float(item.get("confidence", 0.5)))
        await memory.scope_rule_to_project(rule_id, project_id)
        rule_keys.add(key)
        added.append({"type": "rule", "label": _label(item)})

    return {
        "schema_version": SCHEMA_VERSION,
        "added": added,
        "skipped": skipped,
        "counts": {"added": len(added), "skipped": len(skipped)},
    }
