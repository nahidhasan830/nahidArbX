#!/bin/bash
# Rigorous AI Search Provider Benchmark with Real Queries

echo "============================================================"
echo "AI SEARCH PROVIDER BENCHMARK - Real Football Queries"
echo "============================================================"
echo ""
echo "Today's date: $(date +%Y-%m-%d)"
echo ""

# Test queries with verifiable results
QUERIES=(
  "Real Madrid vs Barcelona El Clasico date time 2024"
  "Manchester United vs Liverpool Premier League score today"
  "IPL 2024 points table standings"
  "NBA Finals 2024 game 4 score"
  "Champions League final 2024 date stadium"
)

echo "Testing 5 specific queries across each provider..."
echo ""

# Extract results from a response
extract_results() {
    echo "$1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
results = d.get("results", [])
provider = d.get("provider_used", "unknown")
print(f"Provider: {provider}")
print(f"Results count: {len(results)}")
for i, r in enumerate(results[:3], 1):
    title = r.get("title", "")[:60]
    print(f"  {i}. {title}")
'
}

echo ">>> Testing ALL queries with DEFAULT (no provider specified) <<<"
for q in "${QUERIES[@]}"; do
    echo "Query: $q"
    result=$(curl -s -X POST http://localhost:8090/search \
        -H "Content-Type: application/json" \
        -d "{\"query\":\"$q\",\"max_results\":3}")
    extract_results "$result"
    echo ""
    sleep 0.3
done

echo "============================================================"
echo "SAMPLE SEARCH RESULTS (detailed view)"
echo "============================================================"
echo ""
echo "Query: 'Real Madrid vs Barcelona El Clasico date time 2024'"
curl -s -X POST http://localhost:8090/search \
    -H "Content-Type: application/json" \
    -d '{"query":"Real Madrid vs Barcelona El Clasico date time 2024","max_results":5}' | python3 -m json.tool 2>/dev/null | head -50