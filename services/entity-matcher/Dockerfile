FROM python:3.11-slim AS base

# OS deps for torch / sentence-transformers (libgomp for OpenMP).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 build-essential \
    && rm -rf /var/lib/apt/lists/*

# uv for deterministic dep installs.
COPY --from=ghcr.io/astral-sh/uv:0.4.25 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system -r pyproject.toml --no-cache

# Pre-bake both transformer weights so Cloud Run cold start doesn't pay
# the ~5 GB Hugging Face download. ~2.3 GB each; image lands ~6 GB.
ENV HF_HOME=/opt/hf-cache
RUN python -c "\
from sentence_transformers import SentenceTransformer; \
SentenceTransformer('BAAI/bge-m3'); \
print('BGE-M3 baked')"
RUN python -c "\
from sentence_transformers import CrossEncoder; \
CrossEncoder('BAAI/bge-reranker-v2-m3'); \
print('bge-reranker-v2-m3 baked')"

COPY app ./app

# CPU threading: BGE-M3 + reranker scale near-linearly to ~4 threads, then
# diminishing returns. Cloud Run service is provisioned with 2 vCPU.
ENV OMP_NUM_THREADS=2
ENV TOKENIZERS_PARALLELISM=false
ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
