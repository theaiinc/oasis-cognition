#!/usr/bin/env python3
"""Oasis Cognition Integration Tests — comprehensive endpoint testing."""

import json, sys, time, urllib.request, urllib.error, traceback

BASE = "http://localhost:8000"
PASS = 0
FAIL = 0
SKIP = 0

def test(name, method="GET", path="/", body=None, expect_status=None):
    global PASS, FAIL, SKIP
    url = f"{BASE}{path}"
    try:
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method)
        if body:
            req.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req, timeout=10)
        status = resp.status
        body_text = resp.read().decode()
        if expect_status and status != expect_status:
            print(f"  FAIL {name} — expected {expect_status}, got {status}: {body_text[:200]}")
            FAIL += 1
        else:
            print(f"  PASS {name} — HTTP {status}")
            PASS += 1
        return json.loads(body_text) if body_text.startswith("{") else body_text
    except urllib.error.HTTPError as e:
        status = e.code
        body_text = e.read().decode()[:200]
        if expect_status and status == expect_status:
            print(f"  PASS {name} — HTTP {status} (expected)")
            PASS += 1
            return body_text
        else:
            print(f"  FAIL {name} — HTTP {status}: {body_text}")
            FAIL += 1
            return None
    except Exception as e:
        print(f"  FAIL {name} — {type(e).__name__}: {e}")
        FAIL += 1
        return None

print("=" * 60)
print("Oasis Cognition — Integration Test Suite")
print("=" * 60)

# ── Core health ──
print("\n--- Core Health & Info ---")
test("health", "GET", "/api/v1/health")
test("models list", "GET", "/api/v1/models")
test("models lookup", "GET", "/api/v1/models/lookup?model=gemma")
test("pricing", "GET", "/api/v1/pricing")

# ── Session ──
print("\n--- Session ---")
test("session config GET", "GET", "/api/v1/session/config")
test("session config POST", "POST", "/api/v1/session/config", {
    "provider": "openai",
    "model": "google/gemma-4-12b-qat",
    "maxTokens": 4096
})
test("sessions active", "GET", "/api/v1/sessions/active")
test("session usage", "GET", "/api/v1/session/usage?session_id=test-session-1")

# ── Agent Profiles ──
print("\n--- Agent Profiles ---")
test("agent-profiles list", "GET", "/api/v1/agent-profiles")
result = test("agent-profiles create", "POST", "/api/v1/agent-profiles", {
    "name": "test-profile",
    "agent_type": "internal",
    "provider": "openai",
    "model": "gemma-4-12b"
})
if isinstance(result, dict) and result.get("id"):
    profile_id = result["id"]
    test("agent-profiles get", "GET", f"/api/v1/agent-profiles/{profile_id}")
    test("agent-profiles patch", "PATCH", f"/api/v1/agent-profiles/{profile_id}", {"name": "updated-profile"})
    test("agent-profiles delete", "DELETE", f"/api/v1/agent-profiles/{profile_id}")

# ── Project Roles ──
print("\n--- Project Roles ---")
result = test("project-roles create", "POST", "/api/v1/project-roles", {
    "project_id": "test-project",
    "kind": "developer",
    "name": "developer",
    "description": "Test role",
    "permissions": ["read", "write"]
})
test("project-roles list", "GET", "/api/v1/project-roles?project_id=test-project")

# ── Memory ──
print("\n--- Memory ---")
test("memory query", "GET", "/api/v1/memory/query?q=test")
test("memory rules", "GET", "/api/v1/memory/rules")

# ── History ──
print("\n--- History ---")
test("history sessions", "GET", "/api/v1/history/sessions")
test("history messages", "GET", "/api/v1/history/messages?sessionId=test")

# ── Timeline / Events ──
print("\n--- Events ---")
test("events timeline", "GET", "/api/v1/events/timeline?limit=5")

# ── Missions ──
print("\n--- Missions ---")
test("missions list", "GET", "/api/v1/missions")

# ── Workflows ──
print("\n--- Workflows ---")
test("workflows list", "GET", "/api/v1/workflows")
test("workflows node-catalog", "GET", "/api/v1/workflows/node-catalog")

# ── Projects ──
print("\n--- Projects ---")
result = test("projects create", "POST", "/api/v1/projects", {"name": "test-project"})
if isinstance(result, dict) and result.get("project_id"):
    pid = result["project_id"]
    test("projects get", "GET", f"/api/v1/projects/{pid}")
    test("projects chats", "POST", f"/api/v1/projects/{pid}/chats", {"session_id": "test-session", "message": "Hello, world!"})

# ── Feedback ──
print("\n--- Feedback ---")
test("feedback submit", "POST", "/api/v1/feedback", {
    "type": "thumbs_up",
    "messageId": "test-msg-1"
})

# ── Artifacts ──
print("\n--- Artifacts ---")
test("artifacts list", "GET", "/api/v1/artifacts")
test("artifacts search", "GET", "/api/v1/artifacts/search?q=test")

# ── Web Search ──
print("\n--- Web Search ---")
test("web search", "GET", "/api/v1/web-search?q=hello")

# ── Files ──
print("\n--- Files ---")
test("files list", "GET", "/api/v1/files?path=.")
test("files text", "GET", "/api/v1/files/text?path=README.md")

# ── Pricing ──
print("\n--- Pricing ---")
test("pricing refresh", "POST", "/api/v1/pricing/refresh")

# ── Welfare ──
print("\n--- Welfare ---")
test("session budget", "POST", "/api/v1/session/budget", {"session_id": "test-session-1", "budgetUsd": 10.0})
test("session usage reset", "POST", "/api/v1/session/usage/reset", {"session_id": "test-session-1"})

print("=" * 60)
print(f"Results: {PASS} passed, {FAIL} failed, {SKIP} skipped")
print("=" * 60)

# Return exit code
sys.exit(0 if FAIL == 0 else 1)
