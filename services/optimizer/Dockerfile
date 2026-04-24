# AlphaSearch optimizer sidecar — Python 3.12 + FastAPI + Optuna.
# Built by Cloud Build, deployed to Cloud Run service `nahidarbx-optimizer`.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install uv — 10× faster than pip, deterministic via uv.lock.
RUN pip install --no-cache-dir uv==0.5.4

WORKDIR /app

# Install deps first (layer cache friendly).
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache .

COPY app ./app

# Cloud Run injects PORT (defaults 8080). Local dev sets PORT=8001.
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
