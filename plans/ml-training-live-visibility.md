# Robust ML Training Pipeline with Live Visibility + User Controls

**Date**: 2026-05-18
**Status**: Executed with corrections (6 tasks, implementation complete)
**Root Cause**: Blocking shell trigger + zero Python heartbeat writes + slow poller = stuck training invisible to users for up to 45 minutes.

---

## Root Cause Analysis

The current training system has three compounding failures:

1. **Shell blocks with `--wait`** — `cloud-train.sh` calls `gcloud run jobs execute --wait`, blocking the entire HTTP request for ~20 min with zero feedback to the caller.
2. **Python never writes intermediate status** — `job.py` / `trainer.py` have zero DB writes during the 4-stage pipeline (HPO → holdout → CPCV → final fit). If the job crashes, `status` stays `training` forever.
3. **Poller is too slow** — 60s polling interval, 45 min stuck timeout. A failed job lingers for almost an hour before being marked failed.

**Evidence**: 5 failed models in the DB, all with *"Training timed out — Cloud Run Job may have exited without updating the database."* Current training (`cloud-training-1779040096444`) has been `training` for ~32 min with 0 samples. This message means Python exited without ever writing a terminal status — not a GCP timeout.

---

## 6-Task Implementation Plan

### Task 1 — Schema: add training stage columns to `ml_models`

**File**: `lib/db/schema.ts`

Add 4 columns to the `mlModels` table:

| Column | Type | Purpose |
|--------|------|---------|
| `trainingStage` | `text` | One of: `loading`, `hpo`, `holdout`, `cpcv`, `final`, `gate`, `export`, `complete`, `failed`, `rejected`, `cancelled` |
| `progressMessage` | `text` | Human-readable: *"Running HPO trial 23/50"*, *"Running CPCV fold 3/10"*, etc. |
| `lastHeartbeatAt` | `timestamp` | Python writes this at each stage boundary. Used for precise stuck detection. |
| `estimatedTimeRemainingMs` | `integer` | Python estimates remaining time after each stage. Displayed in UI. |

Then run:
```bash
npm run db:generate && npm run db:migrate
```

**Why first**: All downstream components (Python writes, poller, API, UI) depend on these columns.

---

### Task 2 — Python: heartbeat writes in `job.py` + `trainer.py`

**Files**: `services/optimizer/app/job.py`, `services/optimizer/app/trainer.py`

Add a `_write_progress()` helper in `job.py`:
```python
def _write_progress(session, model_id: str, stage: str, message: str, estimated_ms: int = 0):
    session.execute(text("""
        UPDATE ml_models
        SET training_stage=:stage, progress_message=:msg,
            last_heartbeat_at=now(), estimated_time_remaining_ms=:eta
        WHERE id=:model_id
    """), {"stage": stage, "msg": message, "model_id": model_id, "eta": estimated_ms})
    session.commit()
```

Call it at these 9 boundaries:

| # | Call site | `stage` | `message` | `eta` |
|---|-----------|---------|-----------|-------|
| 1 | After `loader.load()` succeeds | `loading` | `"Loading dataset: {n} samples, {f} features"` | 5000 |
| 2 | Each HPO trial (every 10 trials) | `hpo` | `"HPO trial {i}/50 — AUC {auc:.4f}"` | 300000 |
| 3 | After HPO complete | `hpo` | `"HPO complete — best AUC {auc:.4f}"` | 20000 |
| 4 | After outer holdout eval | `holdout` | `"Holdout AUC: {auc:.4f} ({pct}%)"` | 60000 |
| 5 | Each CPCV fold (every 2 folds) | `cpcv` | `"CPCV fold {i}/10 — Sharpe {sh:.3f}"` | 120000 |
| 6 | After CPCV complete | `cpcv` | `"CPCV complete — Sharpe {sh:.3f}, CV win rate {wr:.1f}%"` | 30000 |
| 7 | During final fit | `final` | `"Fitting final model on {n} samples"` | 10000 |
| 8 | After gate decision | `gate` | `"Gate approved" / "Gate rejected: {reason}"` | 0 |
| 9 | After export | `export` | `"Exported to gs://nahidarbx-ml/models/v{n}.onnx"` | 0 |

Also write on failure in `except` blocks:
```python
_write_progress(session, model_id, "failed", f"Crashed: {e}", 0)
```

**Why second**: This is the core fix — without Python heartbeat writes, nothing else has anything to show.

---

### Task 3 — Shell: async trigger with status monitoring

**File**: `scripts/cloud-train.sh`

Current broken code:
```bash
# BLOCKS for ~20 min with zero feedback
gcloud run jobs execute "$JOB_NAME" --wait
```

Replace with async trigger + wait loop:
```bash
# Step 1: Trigger (returns immediately)
gcloud run jobs run "$JOB_NAME" --quiet --region "$REGION" 2>&1
JOB_EXEC_NAME=$(echo $RESULT | grep -oP 'jobs/[^\s]+' || echo "$JOB_NAME")
echo "Job triggered: $JOB_EXEC_NAME"

# Step 2: Poll for completion (with real-time status)
POLL_INTERVAL=10
MAX_WAIT=1800  # 30 min max
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(gcloud run jobs describe "$JOB_EXEC_NAME" --region "$REGION" --format=value(lastAttempt.status) 2>/dev/null)
  echo "[$ELAPSED s] Status: $STATUS"
  [ "$STATUS" == "Succeeded" ] && echo "✓ Training job complete" && exit 0
  [ "$STATUS" == "Failed" ] && echo "✗ Training job failed" && exit 1
  sleep $POLL_INTERVAL
done
echo "✗ Training timed out after $MAX_WAIT s"
exit 1
```

This gives live status feedback every 10 seconds instead of 20 minutes of silence.

---

### Task 4 — Poller: faster polling + tighter stuck timeout

**File**: `lib/optimizer/training-poller.ts`

Current constants (line 10-13):
```typescript
const FAST_POLL_MS = 5_000;   // unused — only activates after training detected
const SLOW_POLL_MS = 60_000;  // default polling — TOO SLOW
const STUCK_TRAINING_TIMEOUT_MS = 45 * 60 * 1000; // 45 min — TOO LONG
```

Changes:

| Constant | Current | New | Rationale |
|----------|---------|-----|-----------|
| `SLOW_POLL_MS` | 60,000 | 20,000 | 20s default — catches issues faster |
| `FAST_POLL_MS` | 5,000 | 10,000 | 10s when training detected — fast enough |
| `STUCK_TRAINING_TIMEOUT_MS` | 45 min | 20 min | Training should finish in <15 min; 20 min is generous |

Also update stuck detection to use `lastHeartbeatAt` instead of `trainingStartedAt`:
```typescript
// Current: stale = now - trainingStartedAt > STUCK_TIMEOUT
// New:     stale = now - lastHeartbeatAt > STUCK_TIMEOUT
const age = now.getTime() - new Date(model.lastHeartbeatAt ?? model.trainingStartedAt).getTime()
```

This makes stuck detection precise — if Python dies, `lastHeartbeatAt` stops updating.

---

### Task 5 — API: expose training stage through existing pipeline/stream

**Files**: `app/api/ml/pipeline/route.ts`, `lib/events/event-bus.ts`, `components/hooks/useMLTrainingStream.ts`

Correction: do **not** add a second live-status endpoint. The dashboard already hydrates from `/api/ml/pipeline` and receives incremental `ml:training:update` SSE events from the engine poller. Adding `GET /engine/ml/training-live` would duplicate source-of-truth behavior and increase drift risk.

Instead, expose `trainingStage`, `progressMessage`, `lastHeartbeatAt`, `estimatedRemainingMs`, and `sampleCount` on the existing `training.activeTraining` object, and extend `MLTrainingUpdate` with `stage`, `lastHeartbeatAt`, and `estimatedRemainingMs`.

---

### Task 6 — UI: live stage timeline + user controls in ML page

**File**: `app/lab/ml/page.tsx` + new `components/lab/TrainingStatusPanel.tsx`

#### Stage Timeline

Horizontal dot-and-line showing all 8 stages:
```
[Loading] → [HPO] → [Holdout] → [CPCV] → [Final Fit] → [Gate] → [Export] → [Complete]
     ●          ●          ○           ○         ○          ○         ○           ○
   done       done       current       wait      wait        wait      wait        wait
```

- Completed stages: filled green dot
- Current stage: pulsing blue dot + label + message below
- Upcoming stages: grey dots
- Failed: red dot on current stage

#### Info Row
```
Elapsed: 04:32    Last heartbeat: 3s ago    ETA: ~12 min    Samples: 0
```

#### Control Buttons

| Button | Action | API |
|--------|--------|-----|
| **Stop** | Mark model `failed`, stop treating it as active | `PATCH /api/ml/training/{id}` → `{action: 'cancel'}` |
| **Retry** | Trigger a fresh training row through the existing retrain endpoint | `POST /api/ml/retrain` |

Correction: `ml_models.status` currently has a CHECK constraint without `cancelled`, and the rest of the pipeline already treats terminal failures consistently. The operator stop control therefore marks the row `failed` with an explicit operator reason instead of widening lifecycle states for this UI-only control.

#### Live Log Tail
```
14:32:01 [loading]     Loading dataset: 4,247 samples, 38 features
14:32:08 [hpo]         Running HPO trial 10/50 — AUC 0.6241
14:32:45 [hpo]         Running HPO trial 20/50 — AUC 0.6318
...
```

SSE events via `syncBus` (`lib/events/sync-bus.ts`) trigger re-renders on each heartbeat.

---

## Dependency Order

```
Task 1 (Schema) → Task 2 (Python) → Task 3 (Shell) → Task 4 (Poller) → Task 5 (API) → Task 6 (UI)
```

Tasks 1–4 are the backend infrastructure (all must work for the system to be functional). Task 5 adds the API. Task 6 is the UI layer on top.

---

## Files to Modify

| Task | File | Change |
|------|------|--------|
| 1 | `lib/db/schema.ts` | +4 columns (`trainingStage`, `progressMessage`, `lastHeartbeatAt`, `estimatedTimeRemainingMs`) |
| 1 | Migration output | `drizzle/*.sql` (auto-generated) |
| 2 | `services/optimizer/app/job.py` | + `_write_progress()` helper + 9 call sites |
| 2 | `services/optimizer/app/trainer.py` | + 5 call sites in 4-stage pipeline |
| 3 | `scripts/cloud-train.sh` | Async trigger (`gcloud run jobs run --quiet`) + 10s poll loop |
| 4 | `lib/optimizer/training-poller.ts` | Faster polling constants, tighter timeout, `lastHeartbeatAt`-based stale detection |
| 5 | `lib/shared/engine-http.ts` | + `/engine/ml/training-live` endpoint |
| 6 | `app/lab/ml/page.tsx` | + `TrainingStatusPanel` embedding |
| 6 | `components/lab/TrainingStatusPanel.tsx` | New component: stage timeline + info row + controls + log tail |

---

## Post-Implementation Checklist

1. `npm run build && npm run lint` — validate everything compiles
2. Manually mark current stuck training as `failed` with reason: `"Cancelled — upgrading to heartbeat-enabled pipeline"`
3. Trigger a new training and watch the UI live
4. Verify: elapsed timer ticks, stage transitions animate, cancel/retry buttons work
5. Confirm `/api/ml/pipeline` returns new fields (`trainingStage`, `progressMessage`, `lastHeartbeatAt`)
