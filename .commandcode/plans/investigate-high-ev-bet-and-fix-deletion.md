# Investigate High EV Bet & Fix Deletion Cascade

## Part 1: Diagnose the Extreme EV Bet

### Step 1: Find the outlier

Query the DB to find the bet with anomalously high EV:

```sql
SELECT id, "eventId", "familyId", "atomId",
       "sharpProvider", "sharpOdds", "sharpTrueProb",
       "softProvider", "softOdds", "softCommissionPct",
       ((("softOdds" - 1) * (1 - "softCommissionPct" / 100) + 1) * "sharpTrueProb" - 1) * 100 as ev_pct,
       "firstSeenAt", "lastSeenAt", "tickCount", "oddsMovement"
FROM bets
ORDER BY ev_pct DESC
LIMIT 5;
```

This uses the same EV formula from `lib/atoms/value-detector.ts` `detectValueForAtom()` (commission-adjust soft odds, multiply by trueProb, convert to %).

### Step 2: Inspect raw provider odds for that bet

The odds store lives in **`lib/atoms/store.ts`** which writes to the atoms table. For the specific `eventId`/`familyId`/`atomId`:

- Write a diagnostic script that calls `getAllOddsForAtom()` for the suspect bet's atom and dumps all provider odds records with timestamps
- Check the `oddsMovement` JSONB column on the bet row — it contains per-provider line movement snapshots at detection time

### Step 3: Replay the value detection for that atom

The core logic is in **`lib/atoms/value-detector.ts`** `detectValueForAtom()`. Key things to verify:

1. **Sharp odds staleness**: Was the Pinnacle snapshot > 180s old? (MAX_VALUE_ODDS_AGE_MS gate)
2. **Soft odds staleness**: Were the soft provider odds > 90s old?
3. **Commission adjustment**: `1 + (rawSoftOdds - 1) * (1 - commissionPct / 100)` — correct for the provider?
4. **Devig result**: In `lib/atoms/vig-removal.ts`, the 4-method composite picks the most conservative (highest) true probability
5. **Provider classification**: Check `lib/providers/registry.ts` — proper classification and commission?

### Step 4: Most likely root causes (by likelihood)

| # | Cause | How to verify |
|---|-------|---------------|
| 1 | **Stale Pinnacle odds** not caught by the 180s gate | Check sharp odds timestamp vs bet's `firstSeenAt` |
| 2 | **Commission mismatch** — provider has wrong commission% | Verify in `lib/providers/registry.ts` |
| 3 | **Atom mismatch** — comparing odds from different outcomes | Check atom IDs match exactly across providers |
| 4 | **Odds scale error** — provider returning 10x actual odds | Check raw odds against known book odds |
| 5 | **Devig artifact** — wide Pinnacle spreads producing nonsense devig | Check `lib/atoms/vig-removal.ts` output |

Create diagnostic script: `scripts/diagnose-high-ev-bet.ts` that takes a bet ID and dumps all provider odds, devig output, and full value detection trace.

---

## Part 2: Fix Deletion Cascade

The current `deleteBet()` in **`lib/db/repositories/bets.ts`** (line 999-1004) does a single `db.delete(bets)` with no cascade.

### What needs cascading:

1. **`mlTrainingExamples`** — `sourceBetId` column (text, no FK). Orphaned examples pollute training data.
2. **`autoPlacerLog`** — `betId` column (text, no FK). Orphaned logs pollute history.
3. **Python sidecar** — Both `services/optimizer/` and `services/ai-search/` are stateless (read DB on demand). The optimizer reads from `mlTrainingExamples`. **No Python-side cleanup needed** as long as we cascade to `mlTrainingExamples`.

### Change: `lib/db/repositories/bets.ts` — `deleteBet()`

Replace the single delete with a transaction:

```typescript
export async function deleteBet(betId: string): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    // 1. Delete auto-placer log entries
    await tx.delete(autoPlacerLog).where(eq(autoPlacerLog.betId, betId));

    // 2. Delete ML training examples referencing this bet
    await tx.delete(mlTrainingExamples).where(eq(mlTrainingExamples.sourceBetId, betId));

    // 3. Delete the bet itself
    const deleted = await tx
      .delete(bets)
      .where(eq(bets.id, betId))
      .returning({ id: bets.id });

    return deleted.length > 0;
  });

  return result;
}
```

Import `autoPlacerLog` and `mlTrainingExamples` from `lib/db/schema.ts`.

### No changes needed to:

- **`lib/betting/ninewickets/reconciler.ts`** and **`lib/betting/velki/reconciler.ts`** — they call `deleteBet()` for orphaned pending placements; cascading deletes on training examples / auto-placer logs are no-ops
- **`purge-ml-optimization-data.ts`** — bulk cleanup tool, no conflict

---

## Part 3: Preventive Measures (optional, separate task)

1. **Tighter staleness**: Reduce `MAX_VALUE_ODDS_AGE_MS` from 180s to 120s in `lib/shared/constants.ts`
2. **Explicit EV cap**: Add `MAX_EV_PCT = 50` in constants, reject in `detectValueForAtom()` before the ML layer
3. **Odds range validation**: Reject odds outside [1.01, 1001.00] in the atoms store
4. **Log outlier warnings**: Log when EV% > 30% for operator visibility

---

## Verification

1. Run `scripts/diagnose-high-ev-bet.ts` with the suspect bet ID → confirm root cause
2. Delete the bet from UI → verify `mlTrainingExamples` and `autoPlacerLog` rows are gone
3. Run `npm run build` + `npm run lint` after changes
4. Re-run diagnostic → confirm no orphaned rows
