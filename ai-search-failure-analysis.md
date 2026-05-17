# AI Search Settlement — Failed Cases Deep Dive

**Date:** 2026-05-16 | **Model:** deepseek-v4-flash | **12 matches tested, 5 failures**

---

## Failure #1: Marathon vs CD Olimpia (Honduras) — Inconsistent Hallucination

**Query sent to `/verify-settlement`:**
```json
{
  "event": {
    "home_team": "Marathon",
    "away_team": "CD Olimpia",
    "competition": "Honduras - Liga Nacional",
    "start_time": "2026-05-16T02:15:00Z"
  },
  "question": "What was the final score of the football match Marathon vs CD Olimpia in Honduras - Liga Nacional on 2026-05-16?"
}
```

**Ground truth (from api-football):** `1-0` (Marathon won)

**Three calls, three different answers:**

| Call | Answer | Confidence | Correct? |
|------|--------|-----------|----------|
| 1 | "2-2" | **90%** | ✗ WRONG, would have passed filter |
| 2 | "1-0 to Marathon" | 70% | ✓ Correct |
| 3 | "No verified result available" | 10% | — Filtered out |

**Root cause:** The search results contain scores from **four different matches** between the same teams:

| Source | Score found | Actual match |
|--------|-------------|--------------|
| AS USA (as.com) | "2-2" | Final ida (different competition phase) |
| La Prensa | "Olimpia 2-0 Marathon" | Jornada 2 triangulares (different date) |
| Deportes TVC | "Marathon 1-0 Olimpia" | **The correct May 16 match** |
| ESPN (espn.com) | "Olimpia 1-0 Marathon" | January 7, 2026 match |

The LLM sees all these scores mixed in search snippets. Its system prompt (`prompts.py:147`) has no instruction to verify the specific date. It randomly picks one — on call #1 it chose the 2-2 from a different competition phase at **90% confidence**.

This is the only failure that **would have slipped through** the 70% confidence filter with a wrong score.

---

## Failure #2: Kowloon City vs Hong Kong FC (Hong Kong) — Zero-Confidence Hallucination

**Query sent to `/verify-settlement`:**
```json
{
  "event": {
    "home_team": "Kowloon City",
    "away_team": "Hong Kong FC",
    "competition": "Hong Kong - Premier League",
    "start_time": "2026-05-16T07:00:00Z"
  },
  "question": "What was the final score of the football match Kowloon City vs Hong Kong FC in Hong Kong - Premier League on 2026-05-16?"
}
```

**Ground truth:** `1-1` (draw)

| Call | Answer | Confidence | Correct? |
|------|--------|-----------|----------|
| 1 | "Could not find the final score" | 10% | — Filtered (but truthful) |
| 2 | "Kowloon City 2-1 Hong Kong FC, HT 0-0" | **0%** | ✗ Wrong, but caught by filter |

**Root cause:** Every single search result (19 sources) was a **pre-match page** — Flashscore said "live score starts on...", Sofascore said "is going head to head starting on...", Xscores said "Get live scores..." None of the 19 web sources contained the actual final score because Hong Kong league results don't propagate well to the open web. The LLM had zero evidence but was forced to give an answer by the JSON schema. On call #2 it invented "2-1" out of nothing — but importantly set confidence to 0, so the filter caught it.

---

## Failure #3: Montevideo City Torque vs Nacional (Uruguay) — Date Awareness Bug

**Query sent to `/verify-settlement`:**
```json
{
  "event": {
    "home_team": "Montevideo City Torque",
    "away_team": "Nacional de Football",
    "competition": "Uruguay - Primera Division",
    "start_time": "2026-05-15T23:00:00Z"
  },
  "question": "What was the final score of the football match Montevideo City Torque vs Nacional de Football in Uruguay - Primera Division on 2026-05-15?"
}
```

**Ground truth:** `1-2` (Nacional won)

| Call | Answer | Confidence | Correct? |
|------|--------|-----------|----------|
| 1 | "No verified final score found" | 10% | — Filtered |
| 2 | "The match has not been played yet as the date is in the future" | **90%** | ✗ Date hallucination |

**Root cause:** The `SETTLEMENT_SYSTEM` prompt at `services/ai-search/app/llm/prompts.py:147` does **not** tell the LLM what the current date is. The LLM's training data cutoff is ~mid-2025, so it believes the current date is sometime in 2025. When it sees `2026-05-15`, it concludes the match hasn't happened yet. The search results should have corrected this (Fox Sports says "game played on May 15, 2026" with "box score"), but the LLM overrides the evidence with its internal date knowledge.

The search results also included one source (thesportsdb.com) that still said "Status: Not Started" (outdated cache), which reinforced the AI's wrong belief.

---

## Failure #4: Real Tomayapo vs Aurora (Bolivia) — Intermittent Date Bug

**Query sent to `/verify-settlement`:**
```json
{
  "event": {
    "home_team": "Real Tomayapo",
    "away_team": "Aurora",
    "competition": "Bolivia - Primera Division",
    "start_time": "2026-05-16T00:00:00Z"
  },
  "question": "What was the final score of the football match Real Tomayapo vs Aurora in Bolivia - Primera Division on 2026-05-16?"
}
```

**Ground truth:** `0-2` (Aurora won)

| Call | Answer | Confidence | Correct? |
|------|--------|-----------|----------|
| 1 | "Has not yet occurred (current date is 2025-04-09)" | 95% | ✗ Date hallucination |
| 2 | "0-2 (Aurora wins)" | **95%** | ✓ Correct |

**Root cause:** Same date awareness bug as #3, but **intermittent**. The search evidence contained the score — a Flashscore URL whose HTML title was `"TOM 0-2 AUR | Tomayapo v Aurora 16/05/2026, Lineups - Flashscore.com"`. On call #1 the LLM ignored this evidence because it was fixated on "2026 = future." On call #2 the same LLM, same temperature (0.0), saw the same evidence and correctly extracted 0-2. This is **non-deterministic behavior** even at temperature=0 with `json_object` response format.

---

## Failure #5: Academico de Viseu vs Sporting Lisbon II (Portugal) — Evidence Override Bug

**Query sent to `/verify-settlement`:**
```json
{
  "event": {
    "home_team": "Academico de Viseu",
    "away_team": "Sporting Lisbon II",
    "competition": "Portugal - Liga 2",
    "start_time": "2026-05-16T10:00:00Z"
  },
  "question": "What was the final score of the football match Academico de Viseu vs Sporting Lisbon II in Portugal - Liga 2 on 2026-05-16?"
}
```

**Ground truth:** `0-0` (draw)

| Call | Answer | Confidence | Correct? |
|------|--------|-----------|----------|
| 1 | "Match not yet played (scheduled for 16 May 2026)" | 95% | ✗ Date hallucination |
| 2 (with hint) | "No reliable score found" | 20% | — Filtered |
| 3 | "Match not yet played" | 95% | ✗ Date hallucination |

**Root cause:** The search evidence **did contain the match result** — a Portuguese news article (ojogo.pt) titled:

> *"Académico de Viseu vence Sporting B e sobe ao segundo lugar da II Liga"*
> Snippet: *"...os visitantes igualaram...por Cihan Kahraman (14), e consumaram o triunfo através de João Guilherme (70)..."*

This is a post-match report confirming the game was played and Académico won. But the LLM fixated on Sofascore's cached language ("will play the next match on May 16, 2026, 10:00 AM") and a boilerplate page saying "Status Not Started." It weighed the cached pre-match page more heavily than the actual post-match news article, and overrode both with its internal date bias.

---

## Root Cause Summary

| Issue | Severity | Affected failures | Fix location |
|-------|----------|-------------------|-------------|
| **No current date in system prompt** | Critical | #3, #4, #5 | `prompts.py:147` — inject `f"Today's date is {date.today()}"` |
| **Multiple matches between same teams** | Critical | #1 | `prompts.py:152` — add "Verify the score matches the exact date provided. Ignore results from other dates." |
| **Non-deterministic responses at temp=0** | High | #1, #4 | DeepSeek API behavior — may need `seed` param or accept as inherent |
| **Stale/cached web pages** | Medium | #2, #5 | Search query should include `after:{date}` to filter; or scrape the page content (already done for score domains) |
| **No reasoning in verdict** | Medium | All | `prompts.py:164` — remove "No reasoning needed" to enable debugging |

## What Saved Us (What Worked)

- The 70% confidence **filter correctly caught** Kowloon City (0-10%), Montevideo (10%), and Marathon call #3 (10%).
- The **only failure that slipped through** with high confidence was Marathon call #1 (90% → wrong score 2-2), which is a race condition caused by multiple matches between the same teams.
- Overall, **7/8 matches with conf ≥ 70% and no date bug were correct** (87.5%).
