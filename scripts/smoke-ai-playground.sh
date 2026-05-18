#!/usr/bin/env bash
# Smoke test the AI playground via /api/ai-search endpoints.
# Usage: bash scripts/smoke-ai-playground.sh [--web|--noweb] "Question"

set -u

BASE="${BASE:-http://localhost:3000}"
PROVIDER="${PROVIDER:-deepseek}"
MODEL="${MODEL:-deepseek-v4-flash}"
SEARCH_PROVIDER="${SEARCH_PROVIDER:-}"

USE_WEB=1
case "${1:-}" in
  --web)   USE_WEB=1; shift ;;
  --noweb) USE_WEB=0; shift ;;
esac

QUERY="${1:-Today Premier League fixtures}"
echo "Q: $QUERY"
echo "   provider=$PROVIDER model=$MODEL web=$USE_WEB search=${SEARCH_PROVIDER:-auto}"

start_ms=$(($(date +%s%N)/1000000))
ctx_json="null"

if [[ $USE_WEB -eq 1 ]]; then
  if [[ -n "$SEARCH_PROVIDER" ]]; then
    body=$(jq -n --arg q "$QUERY" --arg sp "$SEARCH_PROVIDER" \
      '{query: $q, providers: [$sp], max_results: 10}')
  else
    body=$(jq -n --arg q "$QUERY" \
      '{query: $q, max_results: 10}')
  fi
  search=$(curl -s -X POST "$BASE/api/ai-search/search" \
    -H 'Content-Type: application/json' -d "$body")
  provider_used=$(echo "$search" | jq -r '.providerUsed // "?"')
  result_count=$(echo "$search" | jq -r '.results | length // 0')
  echo "   search: provider=$provider_used results=$result_count"
  results=$(echo "$search" | jq -c '.results // []')
  ctx_json=$(jq -n --argjson r "$results" '{web_search_results: $r}')
fi

body=$(jq -n \
  --arg q "$QUERY" \
  --argjson c "$ctx_json" \
  --arg provider "$PROVIDER" \
  --arg model "$MODEL" \
  '{question: $q, context: $c, skip_search: true, provider: $provider, model: $model, service: "Playground"}')

grounded=$(curl -s -X POST "$BASE/api/ai-search/grounded-query" \
  -H 'Content-Type: application/json' -d "$body")

end_ms=$(($(date +%s%N)/1000000))
elapsed=$((end_ms - start_ms))

answer=$(echo "$grounded" | jq -r '.answer // .error // "-"')
reasoning=$(echo "$grounded" | jq -r '.reasoning // ""' | head -c 240)
sources=$(echo "$grounded" | jq -r '.sources | length // 0')
model_used=$(echo "$grounded" | jq -r '.model // "?"')

echo "   latency=${elapsed}ms model=$model_used sources=$sources"
echo "   ----"
echo "$answer" | head -c 1800
printf '\n   ----\n'
if [[ -n "$reasoning" ]]; then
  printf '   reasoning: %s\n' "$reasoning"
fi
echo
