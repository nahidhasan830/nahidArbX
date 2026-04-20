# In-Play — disabled, reserved for future product

This document records **why in-play value detection is currently disabled**, **what was changed on 2026-04-19** to enforce pre-match-only behaviour, and **what it would take to re-introduce in-play** as a separate product later.

## TL;DR

- The value-bet detector is now **pre-match only**. Events whose kickoff has already passed are excluded from odds fetching, value detection, and atoms-store refresh.
- **Settlement is unaffected.** Score polling for bets placed pre-match but currently playing continues to run (BC poller + Pinnacle WS). This is necessary to resolve outcomes.
- In-play was accidentally on for several weeks due to a missing kickoff filter between fixtures-matching and odds-fetching. 84% of rows in the `value_bets` table at cleanup time were in-play pollution (detected after kickoff), producing phantom edges from snapshot-timing mismatches between Pinnacle and NineWickets.

## Why in-play was disabled

The existing architecture is **fundamentally pre-match**:

- **60-second sync cadence.** Fine for pre-match (lines move over minutes/hours). Fatal for in-play (lines move every second with goals, red cards, time decay).
- **Token-captured Pinnacle feed (~1 hr validity), cached across cycles.** A 30-second-old sharp line is useless during live play.
- **No suspended/active state tracking at the atom level.** Pre-match doesn't need it. In-play requires it constantly (lines suspend on VAR checks, goals, etc.).
- **Pinnacle snapshot age not measured per-bet.** `sharpOddsAgeMs` was hard-coded to `null` until the 2026-04-19 fix. Without age, we couldn't reject stale-sharp EV computations — a necessary gate for in-play.

Running in-play on this architecture meant: every "edge" detected during live play was almost always just a timing mismatch between two feeds updating at different rates. Not edge, noise. A single 1-row diagnostic run on 2026-04-19 showed mean EV 25%, max EV 1117%, and a z-score of −6.37 — a statistically-extreme "we're not winning anywhere near as often as our EV claims we should" signal that confirmed the phantom-edge diagnosis.

## What changed (2026-04-19)

### Code

All changes are tagged with comments referencing this file.

- **[`lib/background/fetcher.ts`](lib/background/fetcher.ts)** — authoritative pre-match gate at the fixtures-to-odds boundary. `syncFixturesOnly()` now returns only matched events whose kickoff is still in the future (with a +5 min grace so closing-line capture has a window to succeed for events that kick off between sync cycles). Score polling and score-event-mapping registration happen _before_ this filter so settlement still sees all tracked matches.
- **[`lib/background/fetcher.ts`](lib/background/fetcher.ts)** — defense-in-depth pre-match filter at value-detection entry. Redundant with the gate above for the normal sync loop, but protects any future caller (scripts, alternate entry points) that might feed a raw event list into `detectAllValueBetsIncremental`.
- **[`lib/atoms/value-detector.ts`](lib/atoms/value-detector.ts)** — `sharpOddsAgeMs` is now computed at detection time from the sharp provider's odds-store timestamp. New rows in `value_bets` will carry real latency data; rows written before 2026-04-19 have it as `null`.
- **[`lib/db/repositories/value-bets.ts`](lib/db/repositories/value-bets.ts)** — persists the new `sharpOddsAgeMs` (was hard-coded to `null`).
- **[`lib/backtest/metrics.ts`](lib/backtest/metrics.ts)** — CLV now computed at entry price (`softOddsFirst / pinnacleClose − 1`) rather than at `softOddsMax`. The `max`-based CLV metrics were structurally inflated and didn't reflect realised edge. See the commit for the propagation through strategy-executions, AnalysisDialog, ExecutionsDialog.

### Preserved for settlement

- **BC score poller** (`lib/scores/bc-poller.ts` + `startBCScorePollingForLiveEvents` in `lib/background/fetcher.ts`). Continues to poll every 10s for matches within ±3 h of kickoff. Purpose: capture live scores for settlement of bets placed pre-match. Renamed comments to clarify this is settlement support, not in-play detection.
- **Pinnacle WS score streaming** (`lib/scores/*`). Unchanged. Primary settlement source.
- **Multi-source score store + `liveScore` API field** (`lib/scores/multi-source-store.ts`, `app/api/dashboard/route.ts:350-371`, `components/spreadsheet/*.tsx`). Display of current scores for pre-match bets whose matches are now being played. Purely informational / settlement progress; not a betting workflow.
- **Closing-line capture** (`lib/background/closing-capture.ts`). Fires ±5 min around kickoff, reads from the atoms store. This is pre-match boundary data — the final sharp reference price — not in-play capture.
- **BetConstruct adapter's `liveInfo` field** (`lib/adapters/betconstruct/index.ts`). Currently unused by the pre-match pipeline (it's dead payload at the event-adapter level — UI reads live scores from a different path, the multi-source score store). Left intact on the assumption it may be useful for the in-play product later.

## Residual in-play data in the DB

Rows in `value_bets` persisted before 2026-04-19 may have `firstSeenAt >= eventStartTime` — these were detected in-play under the bug. Going forward, new rows cannot have this property.

**To clean up historical in-play rows:**

```sql
-- Identify
SELECT COUNT(*) FROM value_bets WHERE first_seen_at >= event_start_time;

-- Delete (review first; no rollback)
DELETE FROM value_bets WHERE first_seen_at >= event_start_time;
```

Alternatively, the UI's backtest view can filter them out live without mutating the DB — add a filter `firstSeenAt < eventStartTime` to exclude pre-fix pollution from aggregate metrics.

## Considered and rejected (for now)

### "Refresh button at placement solves staleness"

**Argument raised:** the value-bet modal has a Refresh button. If the user clicks refresh right before placing, they see fresh odds. Stale-detection then becomes harmless — phantoms visibly evaporate on refresh and the user simply doesn't place.

**Why it's a partial fix, not a complete one:**

- **Measurement is still broken.** Every detection writes `softOddsFirst` into the DB as the notional entry price. Backtest ROI and CLV compute off that. If 80% of in-play detections are phantoms that evaporate on refresh, the DB accumulates 80% noise regardless of what the user does at placement — so we can never tell if in-play has real edge.
- **Attention tax.** With in-play re-enabled, most flagged bets would be phantoms. The UI becomes a pile of dead leads even if the user never actually places on one.
- **Race between refresh and place.** Gap of 3–10 seconds between refresh and click. In live play that's enough to re-evaporate.
- **Detection itself uses stale data.** Refresh helps after a bet is shown; it doesn't help detect bets against the real-time sharp line.

**Conclusion:** refresh is a legitimate safety net at placement, but detection and measurement both need fresh inputs independently. Keeping this section so future-us doesn't re-litigate.

## Pre-existing suspended-state bugs (to fix regardless of in-play plans)

Investigation on 2026-04-19 found our suspended-state handling is incomplete. These bugs affect **pre-match too** — lines can suspend briefly pre-match during news / lineup changes / heavy action — so they're worth fixing whether or not in-play ever comes back.

| Provider                   | Detects suspended?                                                                                                                               | Propagates to atoms store?                                                                                                                              | Notes                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinnacle** (sharp)       | Yes — `status != "OPEN"` in raw response ([lib/atoms/mappings/pinnacle.ts:574-580](lib/atoms/mappings/pinnacle.ts#L574-L580))                    | **Hard-skipped** (not stored at all)                                                                                                                    | Safe behaviour. Per-atom `suspended` metadata could help debug, but correctness-wise this is fine.                                                            |
| **NineWickets Sportsbook** | Yes — `apiSiteStatus != "OPEN"` ([lib/atoms/adapters/ninewickets-sportsbook.ts:181-183](lib/atoms/adapters/ninewickets-sportsbook.ts#L181-L183)) | Yes, `suspended: true` flag set                                                                                                                         | Working correctly. Reference implementation.                                                                                                                  |
| **NineWickets Exchange**   | **No detection at all** ([lib/atoms/adapters/ninewickets-exchange.ts:65-100](lib/atoms/adapters/ninewickets-exchange.ts#L65-L100))               | —                                                                                                                                                       | **BUG.** Exchange API almost certainly exposes a suspension signal (empty `availableToBack`, size=0, or a market status field). Needs investigation + wiring. |
| **BetConstruct**           | Event-level `is_blocked` detected in the event adapter ([lib/adapters/betconstruct/index.ts:59](lib/adapters/betconstruct/index.ts#L59))         | **No** — flag never plumbed into `extractBetConstructOdds` ([lib/atoms/mappings/betconstruct.ts:460-505](lib/atoms/mappings/betconstruct.ts#L460-L505)) | **BUG.** When a BC match is suspended, we still extract frozen odds and treat them as fresh.                                                                  |

**The value detector DOES check `suspended` correctly** ([lib/atoms/value-detector.ts:254](lib/atoms/value-detector.ts#L254), [:491](lib/atoms/value-detector.ts#L491)) — so once the above two bugs are fixed, the whole chain works.

**Fix estimates:**

1. BetConstruct: plumb `is_blocked` from `transformGame` through to `extractBetConstructOdds`, set `suspended: true` on every entry when the game is blocked. ~1 hour.
2. NineWickets Exchange: log a sample response from a suspended market, identify the signal, wire it up. ~1–2 hours.
3. Optional — Pinnacle debug log: emit a log line when an atom is hard-skipped due to `status != "OPEN"`, so we can quantify how often it happens. ~15 min.

These go in `lib/atoms/**` and don't require touching the kickoff gate or re-enabling in-play. Safe to do at any time.

## What re-enabling in-play would require

Treat this as a **separate product**. The pre-match detector and in-play detector should not share the same code paths, because they have incompatible requirements.

### Architectural requirements

1. **Push-based Pinnacle feed.** The current token-captured polling (`lib/auth/token-manager.ts`) will not cut it. Need a WebSocket or streaming feed that emits odds updates as Pinnacle changes them, not on a 60-s poll. Investigate whether Pinnacle's WS (already used for scores) also exposes odds, or whether a separate vendor-side feed is required.
2. **Sub-second-synchronised snapshots.** Two feeds must be captured and compared within the same event-time window (say ±500 ms). Any comparison across a 5+ second gap is unsafe during live play. This likely means a capture timestamp per atom per provider at fetch time and an aggressive freshness gate in the detector.
3. **Atom-level suspended/active tracking.** NineWickets and Pinnacle both suspend lines during VAR, goal reviews, red cards. The detector must drop any atom currently suspended on either side. Requires the odds store to carry a `suspended: boolean` per atom.
4. **Latency gate.** The detector must reject any candidate where sharp or soft snapshot age exceeds a small threshold (probably 2–3 seconds). `sharpOddsAgeMs` — now populated — is the foundation for this.
5. **State-change tracking.** Price movements during play are often triggered by observable match events (goal, red card, 75th-minute mark). The system should know when the last such event occurred and either drop bets placed in a narrow window after it or weight them differently.

### Scope notes

- **Markets that survive in-play.** 1x2 reprices quickly; totals less so. Asian handicaps are volatile. Start by supporting a narrow set of markets (Over/Under total goals, maybe Next Team to Score) where price dynamics are tractable.
- **Stake sizing.** In-play bets have higher variance and less time for the price to settle before the market closes. Kelly fraction should be smaller (⅛ Kelly, not ¼).
- **CLV doesn't translate.** Closing-line value is defined at kickoff; in-play has no equivalent anchor. Need a different quality metric — probably post-hoc comparison against Pinnacle's price N minutes later.
- **Settlement is unchanged.** Same score feeds, same settler waterfall. No additional work there.

### Where to start (if/when resuming)

1. **Build the separate detector module.** Do NOT modify `lib/atoms/value-detector.ts` — fork it into `lib/atoms/in-play-detector.ts`. Different freshness gates, different stake sizing, different output shape (probably `value_bets_in_play` table distinct from `value_bets`).
2. **Prove the feed is tractable** before writing detection logic. Log Pinnacle odds updates at millisecond resolution for 10 live matches. If updates arrive on a reliable <1-second cadence, in-play may be viable; if updates are bursty (large gaps punctuated by catch-up bursts), it's not.
3. **Run a measurement-only period.** Detect bets but don't persist them to the betting table. Compare detected EVs against the actual next-N-minute Pinnacle price to confirm the "edge" is real and not a capture-order artefact.
4. **Only then** wire up persistence, settlement, and UI.

## Contacts / decision log

- **2026-04-18**: phantom-edge symptoms observed in `/backtest` — mean EV 25%, win rate 0% on small sample, CLV uncomputable. Deep-dive with Google AI identified latency + mapping suspects.
- **2026-04-19**: root-cause investigation found (a) `sharpOddsAgeMs` always null, (b) no kickoff filter anywhere in pipeline, (c) BC adapter surfacing live events. Pre-match gate shipped same day.
- **2026-04-19 (later)**: revisited the in-play question after observing that 84% of historical detections were in-play. Considered the "refresh button covers staleness" argument — rejected as incomplete (see "Considered and rejected" section above). Investigation of suspended-state handling found 2 live bugs (BetConstruct, NineWickets Exchange) worth fixing for pre-match regardless. Final call: stay pre-match-only. Revisit in-play only after we have 1,000+ decided pre-match rows to judge real edge on.
- **Decision**: in-play is deferred indefinitely — resumes only after the pre-match system is demonstrably profitable and the above architectural work is planned.
