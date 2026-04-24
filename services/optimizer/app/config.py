"""Environment-driven configuration. Read once at import time."""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Sidecar configuration. Reads from `.env` two levels up + process env."""

    model_config = SettingsConfigDict(
        # Repo-root .env shared with the Next.js app.
        env_file=os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Database — same Cloud SQL instance as Next.js.
    database_url: str = Field(default="", alias="DATABASE_URL")
    cloud_sql_instance: str | None = Field(default=None, alias="CLOUD_SQL_INSTANCE")

    # Auth (HMAC). Empty string in dev = unauthenticated localhost.
    optimizer_shared_secret: str = Field(default="", alias="OPTIMIZER_SHARED_SECRET")

    # Trial loop tunables.
    max_concurrent_trials: int = Field(default=4, alias="OPTIMIZER_MAX_CONCURRENCY")
    trial_persist_batch_size: int = Field(default=10, alias="OPTIMIZER_PERSIST_BATCH")

    # Defaults if a run row leaves them blank.
    default_n_trials: int = Field(default=2000, alias="OPTIMIZER_DEFAULT_N_TRIALS")
    default_rng_seed: int = Field(default=42, alias="OPTIMIZER_DEFAULT_SEED")

    # Logging.
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
