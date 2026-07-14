---
name: matcher-lab-auto-resolve
description: Project-scoped NahidArbX workflow for investigating Matcher Lab Needs Review or human_review rows, replaying selected fixtures through the event matcher pipeline, identifying the exact auto-resolution failure stage, and implementing generalized matcher fixes so obvious cross-provider football fixtures auto-resolve while genuinely ambiguous DeepSeek/search/Vertex-grounded cases stay for manual review. Use when the user asks why Matcher Lab items failed to auto-resolve, wants Needs Review rows reduced, asks to simulate matcher decisions, or asks for non-fixture-specific matcher hardening.
---

# Matcher Lab Auto Resolve

## Purpose

Investigate Matcher Lab > Needs Review rows end to end, explain why each candidate stopped short of auto-resolution, and patch the matcher mechanism only when the fix generalizes beyond the specific team or fixture.

Keep the product posture from `matcherlab.md`: exact kickoff and hard blockers remain mandatory, grounded review helps ambiguity, and obvious matches should not stay unresolved.

## Operating Rules

- Work in the repository root.
- Read `AGENTS.md`, `CLAUDE.md` Entity Resolution, and `matcherlab.md` before changing matcher behavior.
- Never add team-, provider-event-, fixture-, or competition-specific allowlists.
- Never weaken hard blockers: same-provider, sport, gender, youth/tier, kickoff mismatch, canonical cluster conflict.
- Do not introduce fuzzy kickoff windows.
- Do not manually mark rows resolved as the solution. Manual decisions are only acceptable for cases where evidence genuinely stays ambiguous.
- Prefer code-level replay and unit tests over browser automation. UI verification is manual in this repo.
- After code changes, always run `npm run build` and `npm run lint`; run focused matcher tests too.

## Relevant Files

- Candidate generation: `lib/event-matcher/candidates.ts`
- Scoring: `lib/event-matcher/scoring.ts`
- Policy routing: `lib/event-matcher/policy.ts`
- Grounded DeepSeek review: `lib/event-matcher/deepseek.ts`
- Run orchestration: `lib/event-matcher/run.ts`
- Canonical writes and decision readers: `lib/event-matcher/repository.ts`
- Types/config: `lib/event-matcher/types.ts`, `lib/event-matcher/config.ts`
- API/UI: `app/api/matcher-lab/route.ts`, `components/matcher-lab/MatcherLab.tsx`
- Tests: `tests/unit/event-matcher/*.test.ts`
- Accuracy matrix: `tests/unit/event-matcher/accuracy-matrix.test.ts`

## Investigation Workflow

1. Load the current review queue.
   - Prefer the app API when Next is running:
     `curl 'http://localhost:3000/api/matcher-lab?decision=human_review&limit=100'`
   - Or use read-only Postgres via MCP/query tools. Query the latest decision per candidate from `matcher_decisions`, joining `matcher_candidates` and `provider_event_snapshots`.

2. Sample rows by failure shape, not by team name.
   - Group by `reasonCode`, `decisionStage`, `providerA/providerB`, `sourceStage`, `groundedDecision`, confidence band, and score diagnostics.
   - Pick representatives from each group, plus any row that looks obvious to a human.

3. Reconstruct the pipeline trace for each representative.
   - Candidate admission: was the pair generated? Check `hardBlockers`, `reasons`, `sourceStage`, `shapeFingerprint`.
   - Scoring: inspect `scoreBreakdown` for team orientation, weaker aligned team slot, competition, metadata, alias, embedding, combined, and `kickoffExact`.
   - Policy: call or reason through `decideCandidate`.
   - Grounded review: if `decisionStage === "deepseek"`, inspect `groundedDecision`, `groundedConfidence`, source evidence, contradiction/no-source diagnostics, and `policyFromDeepSeek`.
   - Canonical merge: if policy said merge but final stayed review, inspect `planCanonicalMerge` and cluster conflict handling.

4. Identify the exact stop reason.
   - Candidate funnel miss: exact-kickoff row never admitted or was skipped as stale/current shape.
   - Deterministic gate miss: obvious same fixture failed team/competition/metadata thresholds.
   - Grounding policy miss: DeepSeek returned sourced SAME but policy refused auto-merge.
   - Evidence-quality hold: no source, contradictory source, material team/time/competition uncertainty, or source alias conflict.
   - Canonical conflict: both snapshots already belong to incompatible clusters or provider collision would occur.

5. Decide the fix class.
   - Mechanism bug: implement a generalized change in candidates/scoring/policy/deepseek/repository.
   - Config threshold issue: expose or adjust a generalized threshold only with tests covering false-positive risk.
   - Data/normalization issue: improve generic normalization, alias/metadata extraction, or embedding input construction.
   - Legitimate ambiguity: leave as `human_review` and report the reason plainly.

## Replay Techniques

- For selected live rows, `POST /api/matcher-lab` with `{"action":"run","decisionIds":["..."],"useDeepSeek":true}` replays selected decisions through the active matcher and applies merges. Use this only when mutation is intended.
- For safer diagnosis, write or extend unit tests that build `ProviderEventSnapshot` objects and exercise `generateCandidates`, `scoreCandidate`, `decideCandidate`, `reviewResidualWithDeepSeek` mocks, `policyFromDeepSeek`, or `runEventMatcher`.
- If a row was skipped because the old `shapeFingerprint` still matches, inspect whether scoring/grounding version changes are needed so generalized behavior replays previously stuck rows.
- Keep test fixtures synthetic or anonymized around the pattern. Do not encode a production team pair as a special case.

## Generalized Fix Patterns

- Improve token normalization only for broad classes: suffixes, abbreviations, accents, punctuation, legal entity markers, reserve/youth markers, women/gender markers, transliteration-like variants.
- Lift scoring only when independent signals agree: exact kickoff, no hard blockers, same orientation or explicitly grounded swapped orientation, strong team similarity/alias/embedding, and plausible competition.
- Allow DeepSeek auto-merge only for sourced one-way SAME evidence with no material contradiction, no source-alias conflict, and no material uncertainty.
- Keep `human_review` when DeepSeek/Search/Vertex has strong reasons: no usable source, conflicting sources, separate-fixture evidence, material kickoff/timezone concern, youth/gender/team-variant concern, or canonical cluster conflict.
- When changing thresholds, protect the downside with negative tests for near-miss fixtures at the same kickoff.

## Expected Deliverable

Produce:

- A short diagnosis table: row/shape, stop stage, reason code, why it was obvious or why it should stay manual.
- A generalized code change, if warranted.
- Focused regression tests proving obvious fixtures now auto-resolve and ambiguous lookalikes still do not.
- Verification results: focused matcher tests, then `npm run build` and `npm run lint`.
