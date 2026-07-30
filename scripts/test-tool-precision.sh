#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tool Precision Test — DIRECT API TESTS (no LLM pipeline, fast & precise)
# Tests each tool endpoint directly, then spot-checks the LLM pipeline.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${1:-http://localhost:8000}"
TEXEC="http://localhost:8007"
DAGENT="http://localhost:8008"
PASS=0; FAIL=0; RESULTS=()

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
bold()  { printf "\033[1m%s\033[0m\n" "$1"; }

check() {
    local name="$1" expected="$2" actual="$3"
    if echo "$actual" | grep -qiE "$expected"; then
        PASS=$((PASS+1)); green "  ✓ $name"; RESULTS+=("PASS:$name")
    else
        FAIL=$((FAIL+1)); red "  ✗ $name"; RESULTS+=("FAIL:$name")
        red "    Expected: $expected"
        red "    Got: ${actual:0:200}"
    fi
}

post_json() {
    curl -s --max-time 30 -X POST "$1" -H "Content-Type: application/json" -d "$2"
}

bold "======================================"
bold "DIRECT TOOL API TESTS"
bold "======================================"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# GROUP 1: TOOL-EXECUTOR (Docker) — read_file, grep, list_dir, find_files
# ═══════════════════════════════════════════════════════════════════════════

bold "[1] read_file"
R=$(post_json "$TEXEC/internal/tool/execute" \
  '{"tool":"read_file","path":"/workspace/apps/api-gateway/src/app.module.ts","start_line":1,"end_line":20}')
check "read_file returns content" "import|Module|Nest" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "read_file success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[2] grep"
R=$(post_json "$TEXEC/internal/tool/execute" \
  '{"tool":"grep","pattern":"ThinkingOverlay","path":"/workspace"}')
check "grep finds matches" "ThinkingOverlay|\.tsx|\.ts" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "grep success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[3] list_dir"
R=$(post_json "$TEXEC/internal/tool/execute" \
  '{"tool":"list_dir","path":"/workspace/apps/api-gateway/src"}')
check "list_dir shows subdirs" "interaction|controller|module|service|coordinator" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "list_dir success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[4] find_files"
R=$(post_json "$TEXEC/internal/tool/execute" \
  '{"tool":"find_files","pattern":"*.spec.ts","path":"/workspace"}')
check "find_files finds spec files" "\.spec\.ts" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "find_files success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[5] browse_url"
R=$(post_json "$TEXEC/internal/tool/execute" \
  '{"tool":"browse_url","url":"http://example.com"}')
check "browse_url fetches page" "Example|Domain|HTML" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "browse_url success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

# ═══════════════════════════════════════════════════════════════════════════
# GROUP 2: DEV-AGENT (Host) — worktree, file, bash tools
# ═══════════════════════════════════════════════════════════════════════════

bold "[6] create_worktree"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  '{"tool":"create_worktree","name":"direct-test-1"}')
check "create_worktree" "worktree.*created|created.*worktree|true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d))" 2>/dev/null)"
WT_ID=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('worktree_id',''))" 2>/dev/null)
echo "  Worktree ID: $WT_ID"

bold "[7] write_file"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"write_file\",\"worktree_id\":\"$WT_ID\",\"path\":\"direct-test.md\",\"content\":\"# Direct Test\\nContent created by direct API test.\"}")
check "write_file" "wrote|Wrote|success|true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d))" 2>/dev/null)"

bold "[8] read_worktree_file"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"read_worktree_file\",\"worktree_id\":\"$WT_ID\",\"path\":\"direct-test.md\"}")
check "read_worktree_file" "Direct Test|direct-test" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "read_worktree_file success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[9] edit_file"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"edit_file\",\"worktree_id\":\"$WT_ID\",\"path\":\"direct-test.md\",\"old_string\":\"Direct Test\",\"new_string\":\"Edited Test\"}")
check "edit_file" "edited|replacements|success|true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d))" 2>/dev/null)"

# Verify edit worked
R_CHECK=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"read_worktree_file\",\"worktree_id\":\"$WT_ID\",\"path\":\"direct-test.md\"}")
check "edit_file verified" "Edited Test" "$(echo "$R_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"

bold "[10] get_diff"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"get_diff\",\"worktree_id\":\"$WT_ID\"}")
check "get_diff shows changes" "diff|changed|direct-test|new file" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "get_diff success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[11] bash"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  '{"tool":"bash","command":"echo DIRECT_API_TEST_OK"}')
check "bash echo" "DIRECT_API_TEST_OK" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"
check "bash success=true" "true" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[12] apply_patch (create then apply)"
# First create a file to patch
post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"write_file\",\"worktree_id\":\"$WT_ID\",\"path\":\"patch-test.md\",\"content\":\"line1\\nline2\\nline3\"}" > /dev/null 2>&1
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  "{\"tool\":\"apply_patch\",\"worktree_id\":\"$WT_ID\",\"patch\":\"--- a/patch-test.md\\n+++ b/patch-test.md\\n@@ -1,3 +1,4 @@\\n line1\\n+inserted\\n line2\\n line3\"}")
check "apply_patch" "applied|success|true|summary" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d))" 2>/dev/null)"

# ═══════════════════════════════════════════════════════════════════════════
# GROUP 3: NEGATIVE TESTS (error handling)
# ═══════════════════════════════════════════════════════════════════════════

bold "[13] read_file missing path"
R=$(post_json "$TEXEC/internal/tool/execute" '{"tool":"read_file"}')
check "missing path error" "path|required|missing|error" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output','')+str(d.get('success','')))" 2>/dev/null)"
check "missing path success=false" "false" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success','')))" 2>/dev/null)"

bold "[14] unknown tool"
R=$(post_json "$DAGENT/internal/dev-agent/execute" '{"tool":"unknown_tool_xyz"}')
check "unknown tool error" "unknown|Unknown|error" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output',''))" 2>/dev/null)"

bold "[15] write_file missing worktree"
R=$(post_json "$DAGENT/internal/dev-agent/execute" \
  '{"tool":"write_file","path":"test.md","content":"content"}')
check "missing worktree_id error" "missing|Missing|worktree_id" "$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('output','')+str(d.get('success','')))" 2>/dev/null)"

# ═══════════════════════════════════════════════════════════════════════════
# GROUP 4: LLM PIPELINE SPOT-CHECK (single quick test)
# ═══════════════════════════════════════════════════════════════════════════

bold "[16] Full pipeline — read_file via LLM"
R=$(curl -s --max-time 300 -X POST "$BASE/api/v1/interaction" \
  -H "Content-Type: application/json" \
  -d '{"user_message":"Read the file apps/api-gateway/src/app.module.ts first 10 lines and tell me what the first import is.","session_id":"pipeline-spot","context":{}}' 2>&1)
FINAL=$(echo "$R" | python3 -c "
import sys,json
final=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: ev=json.loads(line)
    except: continue
    if ev.get('_oasis_keepalive'): continue
    if ev.get('_oasis_error'): continue
    final=ev
if final: print('ROUTE:',final.get('route','?'),'| RESP:',str(final.get('response',''))[:200])
else: print('No response')
" 2>/dev/null)
check "pipeline: route=tool_use" "tool_use" "$FINAL"
check "pipeline: has response" "import|Module|Nest" "$FINAL"

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
TOTAL=$((PASS+FAIL))
bold "======================================"
if [ $FAIL -eq 0 ]; then
    green "ALL $TOTAL TESTS PASSED ✓"
else
    bold "RESULTS: $PASS passed, $FAIL failed out of $TOTAL"
    for r in "${RESULTS[@]}"; do
        case "$r" in PASS:*) green "  $r" ;; *) red "  $r" ;; esac
    done
fi
bold "======================================"
exit $FAIL
