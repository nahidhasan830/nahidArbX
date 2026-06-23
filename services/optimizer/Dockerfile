FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.11.7

WORKDIR /app

COPY pyproject.toml uv.lock* ./
RUN uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file /tmp/requirements.txt \
    && uv pip install --system --no-cache --requirements /tmp/requirements.txt

COPY app ./app
RUN uv pip install --system --no-cache --no-deps .

CMD ["python", "-m", "app.job"]
