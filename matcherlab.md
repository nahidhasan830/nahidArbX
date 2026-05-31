# Matcher Lab - Current State and Forward Plan

This document replaces the older greenfield roadmap.

The matcher stack in this repo is no longer at the "design it from scratch" stage. The exact-kickoff funnel, deterministic scorer, grounded residual review, canonical cluster writes, diagnostics, and scheduler wiring already exist. The right plan now is:

> **Keep the current exact-kickoff and hard-blocker guarantees, fix the real correctness gaps, then decide how far grounded DeepSeek should be allowed to auto-resolve ambiguous pairs.**

---

## 1) Product goal

Matcher Lab should maximize true cross-provider fixture resolution **without introducing bad merges**.

That still means:

1. **Exact kickoff remains mandatory.** No fuzzy time windows.
2. **Deterministic blockers stay first.** Same-provider, sport, gender, youth/tier, and kickoff mismatches stay hard.
3. **Grounded LLM review is for ambiguity, not fundamentals.**
4. **Canonical events are cluster-aware.** One real fixture should converge into one cluster.
5. **Every automated decision stays auditable.**

Human-label calibration is out of scope.

---

## 2) What exists today

### Runtime and surfaces

Relevant code paths:

- Candidate generation: `lib/event-matcher/candidates.ts`
- Scoring: `lib/event-matcher/scoring.ts`
- Policy routing: `lib/event-matcher/policy.ts`
- Grounded residual review: `lib/event-matcher/deepseek.ts`
- Matcher run orchestration: `lib/event-matcher/run.ts`
- Merge planning and canonical writes: `lib/event-matcher/repository.ts`
- Snapshot capture: `lib/event-matcher/snapshots.ts`
- Manual review/list API: `app/api/matcher-lab/route.ts`
- Streaming run API: `app/api/matcher-lab/run-stream/route.ts`
- Stats API: `app/api/matcher-lab/stats/route.ts`
- Scheduler hook: `lib/background/fetcher.ts`
- Main UI: `components/matcher-lab/MatcherLab.tsx`

Core matcher tables already exist in Postgres:

- `provider_event_snapshots`
- `matcher_candidates`
- `matcher_decisions`
- `canonical_events`
- `canonical_event_members`
- `matcher_impact_daily`
- `event_matcher_scheduler_settings`

### Current behavior by subsystem

#### A. Candidate funnel

Already implemented:

- exact parsed kickoff equality is required before a pair can proceed
- same-provider rows are skipped
- hard blockers include sport mismatch, gender mismatch, youth/tier mismatch, and kickoff mismatch
- candidate admission is split into:
  - `hard_admit`
  - `llm_admit`
- candidate rows store:
  - `candidateKey`
  - `shapeFingerprint`
  - scoring version
  - grounding version
  - text-anchor diagnostics
  - admission reason metadata

This means the older roadmap item "add hard-admit and LLM-admit" is already done.

#### B. Deterministic scoring and routing

Already implemented:

- same-orientation and swapped-orientation team similarity
- competition similarity
- provider reliability weighting
- alias signal
- metadata hint signal
- optional embedding lift
- deterministic routing to:
  - `auto_merge`
  - `auto_reject`
  - grounded residual review
  - `human_review`

The scorer already treats exact kickoff as binary and carries `kickoffExact` diagnostics.

#### C. Grounded residual review

Already implemented:

- ambiguous residual candidates go through `reviewResidualWithDeepSeek`
- grounded review returns structured evidence including:
  - decision
  - confidence
  - reasoning
  - canonical event guess
  - confirmed facts
  - uncertainties
  - sources
  - search queries used
  - model
  - diagnostics
- grounded outcomes are mapped back into matcher policy via `policyFromDeepSeek`

This is real code, not just a plan.

#### D. Canonical cluster resolution

Already implemented:

- merge planning distinguishes:
  - create cluster
  - attach A to B
  - attach B to A
  - noop
  - conflict
- `applyCanonicalMerge` writes canonical events and members transactionally
- canonical membership is uniqueness-protected in the schema
- cluster conflicts are converted to `human_review`

So the repo is no longer pair-only in the old sense. It already has cluster-aware behavior.

#### E. Rescoring and replay behavior

Already implemented in a lightweight form:

- candidate rows store a `shapeFingerprint`
- previously-seen candidates are skipped only when the shape fingerprint is unchanged
- if normalized text or relevant metadata changes, the pair can be re-scored because it no longer matches the stored shape
- manual reruns can target selected decision IDs

This is already enough to support targeted replay without rebuilding the whole architecture.

#### F. UI, stats, and scheduler

Already implemented:

- Matcher Lab has three practical views:
  - exception/review queue
  - canonical clusters
  - diagnostics
- the list API supports filters for:
  - decision
  - stage
  - confidence band
  - provider pair
  - reason code
  - competition
  - kickoff date
  - LLM decision
  - grounding status
  - cluster state
- stats API returns:
  - config
  - impact rollups
  - decision counts
  - review count
  - grounding reliability
  - canonical clusters
- scheduler checks reliability before using DeepSeek and can degrade to non-DeepSeek runs

So the old roadmap item "split the UI into exception queue, clusters, diagnostics" is also already done.

---

## 3) Current non-goals

These still should not be built:

- no fuzzy kickoff window matching
- no human-label matcher calibration workflow
- no run-history product beyond what the current tables already provide
- no settlement-side usage of matcher LLM output
- no heavyweight orchestration that does not improve match quality

---

## 4) What is stale in the old roadmap

The old document treated these as future milestones, but they are already present in code:

- exact-kickoff candidate generation with weaker-text rescue
- `hard_admit` vs `llm_admit`
- deterministic auto-merge / auto-reject / residual routing
- grounded DeepSeek review with structured evidence
- cluster-aware canonical merge planning
- shape-fingerprint-based replay behavior
- exception queue + clusters + diagnostics UI
- scheduler reliability gating

The next plan should focus on **gaps and hardening**, not re-describing already-built phases as upcoming work.

---

## 5) Real gaps and gotchas

These are the issues that still matter.

### 5.1 Grounded review is DeepSeek-only by design today

The grounded matcher path now treats DeepSeek as the only active provider path. The old ignored `llmProvider` hint was removed instead of pretending provider selection exists.

Impact:

- the code is honest about the model path it uses
- adding provider selection later should be treated as a product/architecture change, not a wiring cleanup

### 5.2 Grounded review can auto-merge sourced SAME decisions

`deepseekAutoMergeEnabled` defaults to `true`.

Impact:

- grounded review already runs
- positive grounded `SAME` results can become automatic merges when confidence, source, and contradiction gates pass
- DeepSeek is a resolver for sourced one-way evidence, not a blind guesser

### 5.3 DeepSeek review volume is not capped per run

There is no active `deepseekReviewLimit`.

Impact:

- ambiguous batches continue through grounded review as long as DeepSeek is enabled and reliability is healthy
- historical `grounded_review_cap_reached` rows can still appear until rerun, but new runs should not create them
- the human queue should reflect real uncertainty, disabled review, degraded review, or merge conflicts

### 5.4 Canonical merge writes are uniqueness-safe but not yet concurrency-graceful

`applyCanonicalMerge` re-checks membership inside a transaction, which is good, but the create/attach flow still depends on optimistic reads before inserts.

Impact:

- uniqueness constraints protect against silent corruption
- concurrent runs can still fail noisily instead of cleanly degrading into retry, noop, or conflict

### 5.5 Contradiction detection is still heuristic

Grounded contradiction handling relies partly on text-pattern heuristics instead of a clean structured contradiction signal.

Impact:

- some true conflicts may be missed
- some harmless wording may be escalated unnecessarily

### 5.6 Config and state-model drift was reduced

This pass removed the confirmed drift:

- `candidateLlmAdmitCompetitionFloor` was removed because candidate admission does not use it
- `recommend_merge` and `recommend_reject` were removed from runtime/UI/API types because the active matcher emits `auto_merge`, `auto_reject`, or `human_review`
- active policy thresholds now have config/env fields, including the grounded `DIFFERENT` auto-reject confidence

Impact:

- the state model is easier to reason about
- future drift should be treated as a bug, not a roadmap item

## 6) Replacement plan

This is the plan that should replace the old phase list.

### Milestone 1 - Align docs, config, and active states

Goal: make the matcher easy to reason about again.

Status: completed in the current pass.

Delivered:

- update docs to describe what is already built
- remove or clearly mark legacy roadmap items
- remove `recommend_merge` / `recommend_reject` from shared types and UI metadata
- remove unused config fields and expose active matcher thresholds through config/env
- remove the unused calibration-note surface

Success looks like:

- no roadmap item claims unfinished work that already exists
- no config field implies behavior that does not exist
- no UI state implies a routing path that the runner never emits

### Milestone 2 - Fix correctness-level matcher bugs

Goal: eliminate the places where code behavior diverges from intended behavior.

Status: completed for provider drift, hidden thresholds, and grounded-review skip semantics. Canonical concurrency hardening remains deferred to Milestone 4.

Delivered:

- remove the dead provider-selection option from the grounded matcher path
- move residual auto-reject thresholds and similar matcher literals into explicit config/constants
- tighten residual decision handling so config is the single source of truth for auto-apply thresholds
- emit explicit row-level grounded-review skip reasons:
  - `grounded_review_disabled`
  - `grounded_review_degraded`
- store stable `groundedReview` evidence metadata for reviewed and skipped residual-review paths

Success looks like:

- grounded review uses the DeepSeek path the code claims to use
- thresholds are not split between config and hidden literals
- disabled or degraded review rows are distinguishable from attempted-but-failed `deepseek_unavailable`

### Milestone 3 - Decide DeepSeek posture explicitly

Goal: keep grounded review as a real resolver when sourced evidence is one-way and non-conflicting.

Active mode: resolver mode. Grounded `SAME` and `DIFFERENT` decisions can auto-apply when thresholds and source rules are satisfied.

Deliver:

- explicit decision that `deepseekAutoMergeEnabled` is production-enabled with strict source and contradiction gates
- matching docs, thresholds, and operator messaging
- continued monitoring of disabled, degraded, unavailable, no-source, and contradictory-evidence reasons

Success looks like:

- the product story matches the config story
- operators can tell whether DeepSeek is assistive or authoritative in the current environment

### Milestone 4 - Harden canonical writes for concurrent runs

Goal: keep cluster state correct even under overlapping scheduler/manual activity.

Deliver:

- make the merge path robust to concurrent create/attach races
- prefer retry, noop, or explicit conflict over transaction failure from uniqueness collisions
- ensure manual approve-merge uses the same hardened path as automatic merges

Success looks like:

- overlapping runs do not produce noisy avoidable failures
- canonical graph integrity stays protected without operator cleanup

### Milestone 5 - Tighten grounded evidence semantics

Goal: make review decisions easier to trust.

Deliver:

- replace or reduce text-regex contradiction detection with more structured evidence checks
- distinguish these cases in stored evidence and UI:
  - no source
  - contradictory source
  - provider/grounding failure
  - timeout/unavailable
- attempted-but-failed DeepSeek review
- keep current structured evidence format, but make failure reasons cleaner

Success looks like:

- `human_review` means a specific failure mode, not a vague bucket
- diagnostics reflect the real cause of fallback

### Milestone 6 - Clean up the review surface after logic hardening

Goal: make the UI reflect actual matcher semantics.

Deliver:

- keep dead filter states and display labels removed when they are not emitted anymore
- surface whether a row was:
  - deterministically resolved
  - grounded and auto-applied
  - grounded but held for review
  - skipped from grounded review because of run cap or degraded health
- preserve existing cluster and diagnostics views

Success looks like:

- the queue tells operators why each row is present
- the UI does not pretend historical/legacy states are active when they are not

---

## 7) Recommended implementation order

1. **Milestone 3 - Decide DeepSeek posture explicitly**
2. **Milestone 4 - Harden canonical writes for concurrent runs**
3. **Milestone 5 - Tighten grounded evidence semantics**
4. **Milestone 6 - Clean up the review surface**

Milestones 1 and 2 are now mostly complete. The main deferred correctness hardening is canonical merge concurrency.

---

## 8) Suggested next milestone

### Next pass

Deliver:

- keep DeepSeek auto-resolve limited to sourced, one-way, non-conflicting SAME evidence
- harden canonical merge writes for concurrent scheduler/manual runs
- improve contradiction semantics beyond regex-style evidence checks

Why first:

The matcher is now more honest and explainable. The remaining high-value work is policy posture and canonical write hardening, not another redesign.

---

## 9) Final acceptance questions

Judge Matcher Lab by these questions:

- Are exact-kickoff true matches becoming candidates?
- Are hard blockers still preventing dangerous merges?
- Is grounded review being used where deterministic evidence is insufficient?
- Is the current environment explicit about whether DeepSeek is advisory or authoritative?
- Do concurrent runs preserve canonical integrity cleanly?
- Is human review limited to real ambiguity and operational fallback, rather than stale docs or silent caps?
