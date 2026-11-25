"""Knowledge packs: a project's own rules, exported to versioned JSON and imported into
another project without duplicates, never touching global rules."""

import copy

import pytest
from fastapi.testclient import TestClient

from packages.shared_utils.config import Settings
from services.memory_service.knowledge_pack import (
    SCHEMA_VERSION, SKILLS_UNSUPPORTED, PackError, check_pack, export_pack, import_pack,
)
from services.memory_service.service import MemoryService


@pytest.fixture
def memory_svc():
    return MemoryService(Settings(neo4j_uri="bolt://localhost:99999"))  # in-memory fallback


@pytest.fixture
def client(memory_svc, monkeypatch):
    from services.memory_service import main

    monkeypatch.setattr(main, "memory", memory_svc)
    return TestClient(main.app)


async def _project(m: MemoryService, name: str) -> str:
    return (await m.create_project(name))["project_id"]


async def _rule(m: MemoryService, cond: str, concl: str, conf: float, project_id: str | None = None) -> str:
    rid = await m.store_rule(cond, concl, conf)
    if project_id:
        await m.scope_rule_to_project(rid, project_id)
    return rid


async def _seed(m: MemoryService) -> dict[str, str]:
    p = {name: await _project(m, name) for name in ("a", "b", "c")}
    await _rule(m, "editing a migration", "run the migration tests first", 0.8, p["a"])
    await _rule(m, "deploying the api", "tag the release before deploying", 0.6, p["a"])
    await _rule(m, "using git", "never force-push a shared branch", 0.9)
    await _rule(m, "styling the site", "use the design tokens file", 0.7, p["b"])
    return p


def _content(pack):
    return sorted(i["conclusion"] for i in pack["items"])


@pytest.mark.asyncio
async def test_project_export_holds_only_that_projects_rules(memory_svc):
    p = await _seed(memory_svc)
    pack = await export_pack(memory_svc, project_id=p["a"])
    assert pack["schema_version"] == SCHEMA_VERSION and pack["kind"] == "knowledge_pack"
    assert pack["metadata"]["scope"] == "project"
    assert pack["metadata"]["counts"] == {"rule": 2, "skill": 0}
    assert _content(pack) == ["run the migration tests first", "tag the release before deploying"]
    flat = repr(pack)
    for absent in ("force-push", "design tokens", p["a"], "rule_id", "fingerprint"):
        assert absent not in flat
    assert {i["visibility"] for i in pack["items"]} == {"private"}
    with pytest.raises(PackError):
        await export_pack(memory_svc, project_id=None)


@pytest.mark.asyncio
async def test_round_trip_into_another_project(memory_svc):
    p = await _seed(memory_svc)
    pack = await export_pack(memory_svc, project_id=p["a"])
    report = await import_pack(memory_svc, copy.deepcopy(pack), project_id=p["c"])
    assert report["counts"] == {"added": 2, "skipped": 0}
    again = await export_pack(memory_svc, project_id=p["c"])
    assert sorted(again["items"], key=repr) == sorted(pack["items"], key=repr)
    # Still in project a too.
    assert len(await memory_svc.project_own_rules(p["a"])) == 2


@pytest.mark.asyncio
async def test_importing_twice_adds_nothing_the_second_time(memory_svc):
    p = await _seed(memory_svc)
    pack = await export_pack(memory_svc, project_id=p["a"])
    await import_pack(memory_svc, pack, project_id=p["c"])
    second = await import_pack(memory_svc, pack, project_id=p["c"])
    assert second["counts"] == {"added": 0, "skipped": 2}
    assert {s["reason"] for s in second["skipped"]} == {"already there"}
    assert (await import_pack(memory_svc, pack, project_id=p["a"]))["counts"]["added"] == 0
    assert len(await memory_svc.project_own_rules(p["a"])) == 2


@pytest.mark.asyncio
async def test_a_global_rule_stays_global(memory_svc):
    p = await _seed(memory_svc)
    pack = {"schema_version": 1, "items": [
        {"type": "rule", "condition": "Using  git", "conclusion": "Never force-push a shared branch"},
    ]}
    report = await import_pack(memory_svc, pack, project_id=p["c"])
    assert report["counts"] == {"added": 0, "skipped": 1}
    assert report["skipped"][0]["reason"] == "already there as a global rule"
    assert await memory_svc.project_own_rules(p["c"]) == []
    found = await memory_svc.find_rule("using git", "never force-push a shared branch")
    assert found is not None and found["project_ids"] == []


@pytest.mark.asyncio
async def test_repeats_inside_a_pack_and_skills_are_skipped(memory_svc):
    pid = await _project(memory_svc, "x")
    pack = {
        "schema_version": 1,
        "items": [
            {"type": "rule", "condition": "Editing  a migration", "conclusion": "Run the migration tests FIRST"},
            {"type": "rule", "condition": "editing a migration", "conclusion": "run the migration tests first"},
            {"type": "skill", "name": "Tone", "guidance": "x"},
        ],
    }
    report = await import_pack(memory_svc, pack, project_id=pid)
    assert [a["type"] for a in report["added"]] == ["rule"]
    reasons = [s["reason"] for s in report["skipped"]]
    assert reasons == ["already there", SKILLS_UNSUPPORTED]


@pytest.mark.asyncio
async def test_bad_items_are_reported_not_stored(memory_svc):
    pid = await _project(memory_svc, "x")
    pack = {
        "schema_version": 1,
        "items": [
            {"type": "rule", "condition": "a", "conclusion": ""},
            {"type": "rule", "condition": "a", "conclusion": "b", "confidence": 7},
            {"type": "rule", "condition": "a", "conclusion": "b", "visibility": "everyone"},
            {"type": "skill", "name": "", "guidance": "x"},
            {"type": "workflow", "name": "W"},
            "not an object",
            {"type": "rule", "condition": "c", "conclusion": "d", "visibility": "team"},
        ],
    }
    report = await import_pack(memory_svc, pack, project_id=pid)
    assert [a["label"] for a in report["added"]] == ["IF c THEN d"]
    assert report["counts"]["skipped"] == 6
    assert len(await memory_svc.project_own_rules(pid)) == 1


@pytest.mark.asyncio
async def test_import_needs_a_known_project(memory_svc):
    pack = {"schema_version": 1, "items": []}
    with pytest.raises(PackError):
        await import_pack(memory_svc, pack, project_id=None)
    with pytest.raises(PackError):
        await import_pack(memory_svc, pack, project_id="no-such-project")


def test_schema_version_is_checked():
    for bad in (None, [], {"items": []}, {"schema_version": "1", "items": []},
                {"schema_version": SCHEMA_VERSION + 1, "items": []}, {"schema_version": 0, "items": []},
                {"schema_version": 1, "items": {}}, {"schema_version": 1, "kind": "workflow", "items": []},
                {"schema_version": True, "items": []}):
        with pytest.raises(PackError):
            check_pack(bad)
    assert check_pack({"schema_version": 1, "items": []}) == []


def test_endpoints(client, memory_svc):
    import asyncio

    p = asyncio.run(_seed(memory_svc))
    res = client.get("/internal/memory/knowledge-packs/export", params={"project_id": p["a"]})
    assert res.status_code == 200 and res.json()["metadata"]["counts"] == {"rule": 2, "skill": 0}
    assert client.get("/internal/memory/knowledge-packs/export").status_code == 400

    res = client.post("/internal/memory/knowledge-packs/import", json={"pack": res.json(), "project_id": p["c"]})
    assert res.status_code == 200 and res.json()["counts"] == {"added": 2, "skipped": 0}
    res = client.post("/internal/memory/knowledge-packs/import",
                      json={"pack": {"schema_version": 99, "items": []}, "project_id": p["c"]})
    assert res.status_code == 400 and "newer" in res.json()["detail"]
