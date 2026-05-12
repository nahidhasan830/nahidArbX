# ML training sidecar — LightGBM + ONNX pipeline.
# Built by Cloud Build, deployed to Cloud Run Job `nahidarbx-optimizer-job`.
# Each Job execution runs `python -m app.job`, trains a LightGBM model on
# settled bets with ML features, exports to ONNX, uploads to GCS, and exits.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# LightGBM needs libgomp (OpenMP runtime) — not included in python:slim.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*

# Install uv — 10× faster than pip, deterministic via uv.lock.
RUN pip install --no-cache-dir uv==0.5.4

WORKDIR /app

# Install deps first (layer cache friendly).
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache .

COPY app ./app

# Cloud Run Jobs don't take HTTP traffic — no PORT, no EXPOSE.
CMD ["python", "-m", "app.job"]
