"""Shared ML training progress helpers.

The training job and the trainer both need to write progress updates to
`ml_models` without importing each other. This module holds the DB write
helper and the stage vocabulary in one place.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


TRAINING_STAGES = {
    "loading",
    "hpo",
    "holdout",
    "cpcv",
    "final",
    "gate",
    "export",
    "complete",
    "failed",
    "rejected",
}


def write_progress(
    session: Any,
    model_id: str | None,
    stage: str,
    message: str,
    estimated_ms: int = 0,
) -> None:
    """Persist a heartbeat/progress update for the active training row."""
    if not model_id or stage not in TRAINING_STAGES:
        return

    session.execute(
        text("""
            UPDATE ml_models
            SET training_stage = :stage,
                progress_message = :message,
                last_heartbeat_at = now(),
                estimated_time_remaining_ms = :estimated_ms
            WHERE id = :model_id
        """),
        {
            "stage": stage,
            "message": message,
            "estimated_ms": max(0, int(estimated_ms)),
            "model_id": model_id,
        },
    )
    session.commit()
