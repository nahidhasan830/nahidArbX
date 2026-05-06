"""Environment-driven configuration for the ML training sidecar."""

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

    # GCS bucket for ONNX model storage.
    ml_model_bucket: str = Field(default="nahidarbx-ml-models", alias="ML_MODEL_BUCKET")

    # ML pipeline thresholds.
    ml_cold_start_threshold: int = Field(default=100, alias="ML_COLD_START_THRESHOLD")

    # Logging.
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
