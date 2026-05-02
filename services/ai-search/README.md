# ai-search

Search-grounded AI inference module for NahidArbX.

Combines **4 web search APIs** (Brave, Tavily, Serper, DuckDuckGo) with
**Gemma 4 26B** running locally via Ollama to produce search-grounded
verdicts for entity resolution, settlement verification, and ad-hoc queries.

## Prerequisites

1. **Ollama** — `brew install ollama` then `ollama pull gemma4:27b`
2. **API keys** (all free tiers):
   - `BRAVE_SEARCH_API_KEY` — [brave.com/search/api](https://brave.com/search/api/)
   - `TAVILY_API_KEY` — [tavily.com](https://tavily.com) (1,000/mo, no CC)
   - `SERPER_API_KEY` — [serper.dev](https://serper.dev) (2,500 one-time, no CC)

## Quick start

```bash
# Install dependencies
cd services/ai-search
pip install -e .

# Start Ollama (if not already running)
ollama serve &

# Run the service
uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
```

## Endpoints

| Path | Method | Purpose |
|:-----|:-------|:--------|
| `GET /healthz` | — | Ollama status + provider quotas |
| `POST /search` | Raw search | `{ query }` → search results |
| `POST /grounded-query` | Search + LLM | `{ question }` → grounded answer |
| `POST /entity-match` | Event matching | `{ event_a, event_b }` → verdict |
| `POST /verify-settlement` | Score check | `{ event, question }` → answer |
| `GET /stats` | Metrics | Per-provider usage and health |

## Architecture

```
SearchRouter (load-balanced, priority failover)
  ├── Brave Search API (primary)
  ├── Tavily API (primary)
  ├── Serper.dev API (secondary)
  └── DuckDuckGo scraper (fallback)
       │
       ▼
  GemmaEngine (Ollama, localhost:11434)
  Gemma 4 26B MoE — native function calling + 256K context
       │
       ▼
  GroundedAI (orchestrator)
  search → evidence → LLM → structured verdict + citations
```

## Cost

**$0/month** — all search APIs on free tiers, LLM runs locally.
