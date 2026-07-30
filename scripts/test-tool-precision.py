#!/usr/bin/env python3
"""
Tool Precision Test Suite — runs all tool tests and reports failures.
Usage: python3 scripts/test-tool-precision.py
"""
import json, sys, os, uuid, time, re
import requests as sync_requests
from typing import Any

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
PASS = 0
FAIL = 0
FAILURES: list[tuple[str, str]] = []  # (name, detail)
ALL_RESULTS: list[dict] = []
GREEN = "\033[32m"; RED = "\033[31m"; BOLD = "\033[1m"; RESET = "\033[0m"

def green(s):    print(f"{GREEN}{s}{RESET}")
def red(s):      print(f"{RED}{s}{RESET}")
def bold(s):     print(f"{BOLD}{s}{RESET}")

def send_interaction(msg: str, session_id: str = "", timeout: int = 300) -> dict:
    if not session_id:
        session_id = f"tool-test-{uuid.uuid4().hex[:8]}"
    payload = {"user_message": msg, "session_id": session_id, "context": {}}
    try:
        resp = sync_requests.post(f"{BASE_URL}/api/v1/interaction", json=payload,
                                   timeout=timeout, stream=True)
        resp.raise_for_status()
    except Exception as e:
        return {"_error": str(e)[:200], "response": ""}

    final = None
    error_msg = None
    try:
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.strip(): continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("_oasis_keepalive"): continue
            if ev.get("_oasis_error"):
                error_msg = str(ev.get("body", ev))
                continue
            final = ev
    except Exception as e:
        if not final: return {"_error": f"Stream error: {e}", "response": ""}
    finally:
        resp.close()
    if error_msg and not final:
        return {"_error": error_msg, "response": ""}
    if not final:
        return {"_error": "No response from server", "response": ""}
    return dict(final)

def check(name: str, result: dict, expected: str, require_tools: bool = False):
    global PASS, FAIL
    resp_text = result.get("response") or result.get("_error") or ""
    route = result.get("route", "?")
    if result.get("_error") and not result.get("response"):
        FAIL += 1
        red(f"  ✗ {name}")
        red(f"    Expected: {expected}")
        red(f"    Error: {result['_error'][:200]}")
        FAILURES.append((name, result.get("_error", "")[:200]))
        return
    if re.search(expected, resp_text, re.IGNORECASE):
        PASS += 1
        green(f"  ✓ {name}  [{route}]")
    else:
        FAIL += 1
        red(f"  ✗ {name}  [{route}]")
        red(f"    Expected: {expected}")
        red(f"    Response: {resp_text[:200]}")
        FAILURES.append((name, resp_text[:200]))

def run_test(name: str, message: str, expected: str, require_tools: bool = False,
             timeout: int = 300) -> dict:
    bold(f"\n{'='*60}")
    bold(f"[{name}]")
    bold(f"{'='*60}")
    print(f"  Message: {message[:100]}...")
    sys.stdout.flush()
    start = time.time()
    result = send_interaction(message, timeout=timeout)
    elapsed = time.time() - start
    print(f"  Elapsed: {elapsed:.1f}s")
    check(name, result, expected, require_tools=require_tools)
    return result

# ═══ TESTS ══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    bold("\n" + "=" * 60)
    bold("Tool Precision Test Suite (2B: google/gemma-4-e2b)")
    bold("=" * 60)

    # ── GROUP 1: Tool-Executor (Docker) ──────────────────────────────────────
    
    run_test("1-read_file",
        "Read the first 20 lines of apps/api-gateway/src/app.module.ts. Return the raw imports.",
        r"import|module|@Module",
        timeout=300)

    run_test("2-grep",
        "Search the codebase for all files that mention 'ThinkingOverlay'. List each file path.",
        r"ThinkingOverlay|\.tsx|\.ts",
        timeout=300)

    run_test("3-list_dir",
        "List the contents of apps/api-gateway/src directory. Tell me what subdirectories exist.",
        r"interaction|controller|module|service|coordinator",
        timeout=300)

    run_test("4-find_files",
        "Find all files matching *.spec.ts in the project. How many are there?",
        r"\.spec\.ts|spec|test",
        timeout=300)

    run_test("5-browse_url",
        "Fetch the content at http://example.com and summarize what the page is about.",
        r"Example|Domain|HTML|page",
        timeout=300)

    # ── GROUP 2: Dev-Agent (Host) ────────────────────────────────────────────

    run_test("6-create_worktree",
        "Create a new git worktree named test-suite-tool-1 for making code changes.",
        r"worktree.*created|created.*worktree|test.*tool",
        timeout=300)

    run_test("7-bash",
        "Run the shell command 'echo TEST_PRECISION_OK' and tell me the output.",
        r"TEST_PRECISION_OK",
        timeout=300)

    # ── GROUP 3: Complex route with tool_use correction ──────────────────────

    run_test("8-complex-to-tooluse",
        "I want to add a dark mode toggle button in the header of the Oasis UI React app. Outline the approach, files to modify, and steps.",
        r"dark.?mode|toggle|header|approach|file|plan",
        timeout=300)

    # ── GROUP 4: Multi-step exploration ──────────────────────────────────────

    run_test("9-multi-step-explore",
        "Look at the top-level directory and find package.json at the root. Read it and tell me what tech stack this project uses.",
        r"Node|pnpm|workspace|TypeScript|React|Python|FastAPI|framework",
        timeout=300)

    run_test("10-targeted-read",
        "Find and read apps/oasis-ui-react/src/App.tsx lines 1-50. Tell me about the state variables and main app structure.",
        r"state|useState|component|App|provider|import",
        timeout=300)

    # ═══ SUMMARY ══════════════════════════════════════════════════════════════
    total = PASS + FAIL
    bold(f"\n{'='*60}")
    if FAIL == 0:
        green(f"ALL {total} TESTS PASSED ✓")
    else:
        bold(f"RESULTS: {PASS} passed, {FAIL} failed out of {total} tests")
        for n, d in FAILURES:
            red(f"  FAIL: {n} — {d[:100]}")
    bold(f"{'='*60}")
    print()
    sys.exit(0 if FAIL == 0 else 1)
