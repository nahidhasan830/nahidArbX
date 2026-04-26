"""Cloud SQL connection pool for the entity-matcher service.

Uses the Cloud SQL Python Connector with password auth extracted from
DATABASE_URL. Falls back to a plain DATABASE_URL connection for local
development.

Usage::

    from app.db import get_engine
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT 1"))
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional
from urllib.parse import urlparse, unquote

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

log = logging.getLogger("entity-matcher.db")

_lock = threading.Lock()
_engine: Optional[Engine] = None


def get_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine
    with _lock:
        if _engine is None:
            _engine = _create_engine()
    return _engine


def _create_engine() -> Engine:
    instance = os.getenv("CLOUD_SQL_INSTANCE")
    database_url = os.getenv("DATABASE_URL")

    if instance and database_url:
        log.info("Connecting via Cloud SQL Connector (instance=%s)", instance)
        from google.cloud.sql.connector import Connector

        parsed = urlparse(database_url)
        db_user = unquote(parsed.username or "nahidarbx_app")
        db_pass = unquote(parsed.password or "")
        db_name = (parsed.path or "/nahidarbx").lstrip("/")

        connector = Connector()

        def getconn():
            return connector.connect(
                instance,
                "pg8000",
                user=db_user,
                password=db_pass,
                db=db_name,
            )

        engine = create_engine(
            "postgresql+pg8000://",
            creator=getconn,
            pool_size=3,
            max_overflow=2,
            pool_pre_ping=True,
        )
    elif database_url:
        log.info("Connecting via DATABASE_URL")
        url = database_url.replace("postgresql://", "postgresql+pg8000://")
        engine = create_engine(
            url,
            pool_size=3,
            max_overflow=2,
            pool_pre_ping=True,
        )
    else:
        raise RuntimeError(
            "Either CLOUD_SQL_INSTANCE or DATABASE_URL must be set"
        )

    with engine.connect() as conn:
        from sqlalchemy import text
        conn.execute(text("SELECT 1"))
    log.info("Database connection verified")

    return engine
