"""FastAPI app — control plane for the AlphaSearch optimizer sidecar.

Endpoints:
  POST /run/start    {run_id}  → spawn a background trial loop, return 202
  POST /run/cancel   {run_id}  → flip DB flag (loop polls and exits cleanly)
  GET  /health                 → 200 OK if the process + DB are reachable

Auth: every non-health request requires `X-Optimizer-Token` matching
`OPTIMIZER_SHARED_SECRET`. Empty secret in dev = no auth (localhost only).
"""

from __future__ import annotations

import asyncio
import hmac
import logging

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from .config import get_settings
from .db import open_session
from .runner import run_trial_loop

logging.basicConfig(
    level=get_settings().log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("alphasearch")

app = FastAPI(
    title="AlphaSearch Optimizer",
    version="0.1.0",
    description="Strategy parameter optimizer sidecar for nahidArbX.",
)

# Track in-flight tasks so /health can report them and shutdown can await them.
_active_tasks: dict[str, asyncio.Task[None]] = {}


def _check_auth(token: str | None) -> None:
    secret = get_settings().optimizer_shared_secret
    if not secret:
        return  # dev mode — auth disabled
    if not token or not hmac.compare_digest(token, secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid X-Optimizer-Token",
        )


# ── Models ────────────────────────────────────────────────────────────────


class RunRef(BaseModel):
    run_id: str


# ── Endpoints ─────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, object]:
    db_ok = False
    db_error: str | None = None
    try:
        with open_session() as s:
            s.execute(text("SELECT 1"))
        db_ok = True
    except Exception as exc:  # noqa: BLE001
        db_error = str(exc)
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "ok" if db_ok else f"error: {db_error}",
        "active_runs": list(_active_tasks.keys()),
    }


@app.post("/run/start", status_code=status.HTTP_202_ACCEPTED)
async def run_start(
    payload: RunRef,
    x_optimizer_token: str | None = Header(default=None),
) -> dict[str, str]:
    _check_auth(x_optimizer_token)

    run_id = payload.run_id
    if run_id in _active_tasks and not _active_tasks[run_id].done():
        return {"status": "already_running", "run_id": run_id}

    # Reap finished task references.
    _active_tasks.pop(run_id, None)

    task = asyncio.create_task(run_trial_loop(run_id), name=f"run-{run_id}")
    _active_tasks[run_id] = task

    def _on_done(_: asyncio.Task[None]) -> None:
        _active_tasks.pop(run_id, None)

    task.add_done_callback(_on_done)
    log.info("Spawned trial loop for run %s", run_id)
    return {"status": "accepted", "run_id": run_id}


@app.post("/run/cancel")
async def run_cancel(
    payload: RunRef,
    x_optimizer_token: str | None = Header(default=None),
) -> dict[str, str]:
    _check_auth(x_optimizer_token)
    run_id = payload.run_id
    # Set status='cancelled' in DB; the runner polls it each iteration.
    with open_session() as s:
        s.execute(
            text(
                "UPDATE optimization_runs SET status = 'cancelled' "
                "WHERE id = :id AND status IN ('queued','running')"
            ),
            {"id": run_id},
        )
        s.commit()
    return {"status": "cancellation_requested", "run_id": run_id}


@app.on_event("shutdown")
async def _shutdown() -> None:
    """Wait briefly for in-flight loops to notice cancel before exiting."""
    if not _active_tasks:
        return
    log.warning("Shutting down — %d active runs will keep their state in DB.", len(_active_tasks))
    for task in list(_active_tasks.values()):
        task.cancel()
    await asyncio.gather(*_active_tasks.values(), return_exceptions=True)
