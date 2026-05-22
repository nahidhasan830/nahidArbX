# entity-matcher

**⚠️ Status: Fallback Only** — This service is no longer the primary entity matching path. The engine now uses Vertex AI Text Embeddings API directly.

Self-hosted ML pairwise matcher for the entity-resolution v2 store.
Provides fallback entity matching when Vertex AI Text Embeddings API is unavailable.

Primary path: Vertex AI Text Embeddings API (`lib/matching/entities/vertex-embeddings-client.ts`)
Fallback path: This Cloud Run service (BGE-M3 embeddings + cross-encoder reranking)

## Endpoints

| Path                | Method                                                                       | Purpose |
| ------------------- | ---------------------------------------------------------------------------- | ------- |
| `GET  /healthz`     | liveness + calibrator version                                                |
| `POST /embed`       | `{ text }` → `{ embedding: [1024] }`                                         |
| `POST /embed-batch` | `{ texts: [...] }` → `{ embeddings: [[...]] }`                               |
| `POST /score`       | `{ name_a, name_b, stage }` → `{ score, pvalue, stage_used, model_version }` |
| `POST /reload`      | hot-reload conformal calibrator after trainer Job lands new weights          |

`stage` is either `"bi-encoder"` (fast cosine, no calibration) or
`"cross-encoder"` (slow reranker + MAPIE conformal p-value). The Next.js
`autoResolve()` calls bi-encoder first; only escalates to cross-encoder
when bi-encoder cosine lands in the uncertain band [0.5, 0.92].

## Models

- **Bi-encoder:** `BAAI/bge-m3` (568 M params, 1024-dim, multilingual)
- **Cross-encoder:** `BAAI/bge-reranker-v2-m3` (568 M params, multilingual reranker)
- **Calibrator:** MAPIE empirical conformal prediction. Starts uncalibrated
  (returns p=0.5) until the trainer Job publishes its first artefact;
  after that, p-values reflect the negative-class score distribution
  measured on a held-out 20% slice.

Both transformer weights are **baked into the Docker image** (~6 GB total)
so Cloud Run cold starts don't pay a 5 GB Hugging Face download. The image
build uploads to Artifact Registry under `optimizer/entity-matcher`.

## Deployment

```bash
cd services/entity-matcher
./deploy.sh
```

Deploys as a Cloud Run **Service** (not a Job — this is HTTP-shaped) with:

- `--min-instances=1` — always-on; both models take ~15 s to load and
  the auto-resolver can't tolerate cold-start latency on the sync hot path.
- `--memory=8Gi` — both models in-memory + working set ~7 GB.
- `--cpu=2`, `--concurrency=8` — torch CPU threading caps near 2 threads
  for batch=1 inference; concurrency 8 lets bursts queue without spawning
  new instances.
- `--max-instances=4` — soft cap; we have never seen the matcher cap-out
  at our volume.

Cost: ~$60/month always-on at min-instances=1.

## Reload after retrain

The trainer Job (`services/entity-trainer`) publishes new calibration
artefacts to `gs://nahidarbx-matcher/calibrator_*.joblib` and then POSTs
`/reload` on this service. The reload re-reads the artefact from disk
without restarting the process — model weights stay loaded.

## Why two models, not one

A bi-encoder gets us fast cheap retrieval (vector cosine, milliseconds
per pair). A cross-encoder gets us accurate disambiguation on hard pairs
("Athletic" in La Liga vs "Athletic" in Colombian Primera A) — but a
cross-encoder call is ~50 ms. We use bi-encoder to filter the easy
~85% of decisions in <10 ms, and only burn cross-encoder cycles on the
~15% that land in the uncertain band.
