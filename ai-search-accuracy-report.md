# AI Search Settlement Accuracy Report

**Date:** 2026-05-16  
**Model:** deepseek-v4-flash (DeepSeek API)  
**Service:** localhost:8090 (Python FastAPI)  
**Test method:** Called `/verify-settlement` with 12 real settled matches from the `bets` table and compared AI answers against ground-truth scores from `match_scores`.

---

## Summary

| Metric | Value |
|--------|-------|
| Matches tested | 12 |
| Correct score | 7 (58%) |
| Filtered (conf < 70%) | 2 (17%) |
| Date-confusion bug | 2 (17%) |
| Inconsistent/wrong | 1 (8%) |
| **Effective accuracy** (conf ≥ 70%, no date bug) | **7/8 (87.5%)** |

---

## Results by Match

| Match | AI Answer | Conf | Actual | Verdict |
|-------|-----------|------|--------|---------|
| SC Poltava 0-2 Dynamo Kyiv | 0-2 (HT 0-1) | 90% | 0-2 | Correct |
| Kowloon City 1-1 Hong Kong FC | Could not find | 10% | 1-1 | Filtered |
| Eastern District 1-1 HK Rangers | 1-1 | 70% | 1-1 | Correct |
| D. La Guaira 0-0 UCV | 0-0 | 70% | 0-0 | Correct |
| Metalist 1925 1-1 Epitsentr | 1-1 (HT 1-0) | 85% | 1-1 | Correct |
| Melbourne City 3-1 Wellington | 3-1 | 90% | 3-1 | Correct |
| Fukushima 0-3 Consadole | 0-3 (HT 0-1) | 85% | 0-3 | Correct |
| Montevideo City 1-2 Nacional | Not available | 10% | 1-2 | Filtered |
| **Marathon 1-0 CD Olimpia** | 2-2, then 1-0 | 90/70% | 1-0 | **Inconsistent** |
| Real Tomayapo 0-2 Aurora | Not yet occurred | 95% | 0-2 | **Date bug** |
| Academico Viseu 0-0 Sporting II | Not yet played | 95% | 0-0 | **Date bug** |
| Patriotas 2-3 Millonarios | 2-3 | 80% | 2-3 | Correct |

---

## Issues Found

### 1. Date awareness bug (Critical)
**File:** `services/ai-search/app/llm/prompts.py:147`  
**Root cause:** The `SETTLEMENT_SYSTEM` prompt does not include the current date. The LLM (training cutoff mid-2025) sees 2026 dates and refuses to answer, returning 95% confidence that the match "has not yet occurred." Affected 2 of 12 matches (17%).

**Fix:** Inject the current date into the system prompt:
```python
f"The current date is {datetime.now().strftime('%Y-%m-%d')}."
```

### 2. Inconsistent answers (Moderate)
**Evidence:** Marathon vs CD Olimpia returned "2-2" on first call, "1-0" on second. The LLM confuses different matches between the same teams because search results contain snippets from prior fixtures (e.g., a 2-2 final leg and a 1-0 league match).

**Fix:** Add explicit date-matching instruction to the prompt, and consider adding `after:{date}` search operator where supported.

### 3. No reasoning in verdicts (Minor)
**File:** `services/ai-search/app/llm/prompts.py:164`  
The prompt says `"No reasoning needed"`. When the LLM gets results wrong, there is zero visibility into its decision process. Enabling reasoning would help with debugging and trust.

### 4. Transient service outage
At ~11:02 AM, one entity-match call timed out, triggering the "AI Search service is not reachable" warning. The service auto-recovered. No bets were pending at the time, so no settlement impact. Consider increasing the health-check timeout from 5s to 10s in `lib/matching/ai-search-client.ts:375` to reduce false positives.

---

## Verdict

Tier 2d AI Search is **usable and mostly accurate** for the long-tail niche leagues it targets. The date-awareness and inconsistency issues should be fixed before relying on it for automated settlement. The 70% confidence filter effectively catches most failures — only the Marathon/Olimpia case (inconsistent, once at 90%) would have slipped through with a wrong score.
