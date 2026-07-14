---
name: bets-needs-review-settlement
description: Project-scoped NahidArbX workflow for clearing Bets History Needs Review settlement rows. Use when the user asks to process pending bets with settle_attempts > 0, randomly sample five events at a time from the bets table, replay them through the source-only settlement pipeline, diagnose unresolved or failed stages, and implement generalized settlement/waterfall fixes without team- or fixture-specific rules.
---

# Bets Needs Review Settlement

## Purpose

Reduce Bets History > Needs Review by repeatedly sampling five unresolved events, tracing each through the shared settlement pipeline, and hardening the pipeline only with generalized fixes.

Needs Review means rows in `bets` where `outcome = 'pending'` and `settle_attempts > 0`. Work at the event level first because many bets can share one `event_id`.

## Operating Rules

- Work in the repository root.
- Read `AGENTS.md`, `CLAUDE.md` settlement notes, and the relevant files below before changing behavior.
- Settlement is source-only: cache, ESPN, SofaScore, API-Football. Do not add automated settlement AI.
- Google AI Mode links are only human verification aids. Never feed them into backend settlement or auto-apply outcomes.
- Do not write team-, fixture-, provider-event-, league-, or one-off allowlists.
- Do not manually override outcomes as the fix. Manual outcomes are only for genuinely ambiguous cases after diagnosis.
- Do not weaken evidence requirements to make one sampled event pass. Fix normalization, source lookup, stats requirements, market support, or retry behavior in a way that helps similar future events.
- Diagnose without applying outcomes first. Apply outcomes only after a generalized code fix or a fresh source replay produces deterministic non-pending proposals.
- After code changes, run focused settlement tests, then `npm run build` and `npm run lint`.
- Clean up temporary scripts or artifacts before finishing.

## Relevant Files

- Pipeline entry: `lib/settle/settle-batch.ts`
- Waterfall: `lib/settle/waterfall.ts`
- Pure market settlement: `lib/settle/settle-bet.ts`
- Outcome writer: `lib/settle/apply-outcomes.ts`
- Scheduler and retry backoff: `lib/settle/auto-settler.ts`, `lib/settle/scheduler.ts`
- Source adapters: `lib/settle/sources/espn.ts`, `lib/settle/sources/sofascore.ts`, `lib/settle/sources/api-football.ts`
- Team alias support: `lib/settle/aliases.ts`, `lib/db/repositories/entities.ts`
- Bets repository/filter: `lib/db/repositories/bets.ts`
- Operator API: `app/api/bets-history/settle/route.ts`
- Types: `lib/settle/types.ts`, `lib/bets-history/types.ts`
- Tests: `lib/settle/*.test.ts`, `tests/unit/settle/*.test.ts`

## Batch Loop

Repeat until the Needs Review event queue is empty or the remaining events have documented human-only reasons.

1. Count and sample five random distinct events from the queue.
   - Prefer read-only Postgres for sampling:
     ```sql
     SELECT event_id, COUNT(*) AS pending_bets
     FROM bets
     WHERE outcome = 'pending' AND settle_attempts > 0
     GROUP BY event_id
     ORDER BY random()
     LIMIT 5;
     ```
   - Then load all pending Needs Review bet IDs for those events:
     ```sql
     SELECT id, event_id, home_team, away_team, competition, event_start_time,
            market_type, atom_id, family_id, family_line, time_scope,
            settle_attempts, last_settle_attempt_at, settled_by_source
     FROM bets
     WHERE outcome = 'pending'
       AND settle_attempts > 0
       AND event_id = ANY($1)
     ORDER BY event_start_time DESC, event_id, market_type, atom_id;
     ```

2. Replay the batch through the active pipeline.
   - Use `settleBatch(ids, { bypassCache: true })` for operator-style diagnosis.
   - Also compare `bypassCache: false` when investigating stale or incomplete Tier 0 cache behavior.
   - Do not call `applySettlementOutcomes` during initial diagnosis.

3. Trace every stage for each event.
   - Input shape: teams, competition, kickoff, provider/event ID pattern, market types, time scope, required data.
   - Alias pre-resolution: whether `preResolveTeams` found useful canonical names.
   - Tier 0 cache: hit/miss, score completeness, HT/corners/bookings availability, stale or insufficient data.
   - ESPN: search/admission, candidate match confidence, status, FT/HT/stat data returned.
   - SofaScore: direct/proxy access, candidate match confidence, status, FT/HT/stat data returned.
   - API-Football: quota state, lookup/admission, candidate match confidence, status, FT/HT/stat data returned.
   - Waterfall acceptance: whether confidence reached `MIN_ACCEPT_CONFIDENCE`, whether `hasRequiredData` passed, and which event IDs stayed unresolved.
   - Pure settlement: call or inspect `settleBet(row, score)` for each bet. Separate score-resolution failures from unsupported market/unknown atom/missing-line failures.

4. Record the stop reason in a compact table.
   - Use categories such as: source lookup miss, low-confidence source match, incomplete cached score, missing HT data, missing corner stats, missing booking stats, API quota/backoff, source transport failure, terminal postponed/abandoned state, unsupported market, unknown atom, line parsing bug, settlement math bug, or legitimate ambiguity.
   - Note why the case is obvious enough to fix, or why it must remain human review.

5. Implement only generalized fixes.
   - Add or improve broad normalization for team names, competitions, punctuation, accents, abbreviations, reserve/youth/women markers, or transliteration-like variants.
   - Improve source candidate lookup/ranking when independent signals agree: kickoff, team orientation, competition, source status, and confidence.
   - Improve required-data handling so cached/source scores with missing HT/corners/bookings do not block a richer downstream tier.
   - Add deterministic market support in `settle-bet.ts` only when the market can be settled from trusted score/stat fields.
   - Adjust thresholds only with negative tests that protect near-miss fixtures and same-kickoff lookalikes.
   - Keep genuine source disagreement, absent official scores, unclear abandonment/postponement, and unavailable required stats in Needs Review.

6. Verify and apply.
   - Add focused regression tests using synthetic or anonymized fixtures that capture the failure shape, not production team-specific facts.
   - Re-run the sampled batch after the fix.
   - If proposals are non-pending and deterministic, apply through the existing writer path (`applySettlementOutcomes` or the app's normal settle/apply flow), never direct SQL outcome updates.
   - Re-count the queue and continue with another random five events.

## Useful Replay Snippets

Use temporary scratch scripts only when needed, and delete them before finishing. The core pattern is:

```ts
import { ensureDbReady } from "@/lib/db/client";
import { settleBatch } from "@/lib/settle/settle-batch";

await ensureDbReady();
const ids = [
  // pending Needs Review bet IDs from the sampled events
];
console.dir(await settleBatch(ids, { bypassCache: true }), { depth: null });
```

When Next is running, the operator endpoint is useful for a quick proposal replay:

```sh
curl -sS 'http://localhost:3000/api/bets-history/settle' \
  -H 'content-type: application/json' \
  --data '{"ids":["BET_ID"],"bypassCache":true}'
```

## Expected Deliverable

Report:

- Queue before/after counts and each five-event batch sampled.
- A diagnosis table with event shape, affected bet count, stop stage, stop reason, and action taken.
- Generalized code changes, if any.
- Tests proving the fixed shape now resolves and similar ambiguous cases still stay pending.
- Final verification: focused tests, `npm run build`, and `npm run lint`.
