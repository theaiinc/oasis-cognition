#!/bin/bash
# Test the full interaction pipeline

API_URL="${1:-http://localhost:8000}"

echo "=== Testing Oasis Cognition Interaction ==="
echo "API: $API_URL"
echo ""

# Health check
echo "--- Health Check ---"
curl -s "$API_URL/api/v1/health" | python3 -m json.tool 2>/dev/null || echo "Gateway not ready"
echo ""

# Test interaction
echo "--- POST /api/v1/interaction ---"
echo "Input: My API becomes slow when traffic reaches 2000 users"
echo ""

RAW=$(curl -s -X POST "$API_URL/api/v1/interaction" \
  -H "Content-Type: application/json" \
  -d '{"user_message": "My API becomes slow when traffic reaches 2000 users"}')

# Gateway streams NDJSON (keepalives + final JSON); extract last payload line
RESPONSE=$(echo "$RAW" | python3 -c "
import sys, json
last = None
for line in sys.stdin:
    s = line.strip()
    if not s: continue
    try: o = json.loads(s)
    except json.JSONDecodeError: continue
    if o.get('_oasis_keepalive'): continue
    if o.get('_oasis_error'): print(json.dumps(o)); sys.exit(1)
    last = o
print(json.dumps(last) if last else '{}')
")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# Extract session_id for feedback test
SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

if [ -n "$SESSION_ID" ]; then
    echo "--- POST /api/v1/feedback ---"
    curl -s -X POST "$API_URL/api/v1/feedback" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\", \"feedback_type\": \"confirmation\", \"comment\": \"Good analysis\"}" \
      | python3 -m json.tool 2>/dev/null
    echo ""
fi

# Test memory query
echo "--- GET /api/v1/memory/query ---"
curl -s "$API_URL/api/v1/memory/query?q=latency&limit=5" | python3 -m json.tool 2>/dev/null
echo ""

echo "=== Tests complete ==="
