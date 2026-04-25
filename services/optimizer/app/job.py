"""Job entrypoint — read RUN_ID from env, run one sweep to completion.

Replaces the old FastAPI control-plane (`app/main.py`). Cloud Run Jobs
invoke the container with `RUN_ID` injected via `containerOverrides.env`;
we read it, dispatch to the existing `runner.run_trial_loop(run_id)`
coroutine, and exit. No HTTP server, no background tasks, no autoscaler
reap surface — the migration's whole point.

Cancellation is purely DB-driven (see `runner._cancel_watcher`); a
running Job notices `optimization_runs.status='cancelled'` within ~2s
and exits cleanly. The Next.js side flips that flag — no HTTP call to
the Python process is needed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from .config import get_settings
from .runner import run_trial_loop


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("alphasearch.job")

    run_id = os.getenv("RUN_ID", "").strip()
    if not run_id:
        log.error("RUN_ID env var is required (set via Cloud Run Jobs containerOverrides)")
        sys.exit(2)

    log.info("Job starting for run %s", run_id)
    asyncio.run(run_trial_loop(run_id))
    log.info("Job exiting for run %s", run_id)


if __name__ == "__main__":
    main()
