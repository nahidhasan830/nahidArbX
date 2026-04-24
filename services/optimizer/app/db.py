"""SQLAlchemy + Cloud SQL connector setup.

Mirrors the Next.js `lib/db/client.ts` pattern: when `CLOUD_SQL_INSTANCE`
is set, route through `google-cloud-sql-connector` (no proxy sidecar).
Otherwise fall back to the plain `DATABASE_URL` (local dev with a proxy
already running).
"""

from __future__ import annotations

from functools import lru_cache
from urllib.parse import unquote, urlparse

from google.cloud.sql.connector import Connector, IPTypes
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings


@lru_cache(maxsize=1)
def _connector() -> Connector:
    return Connector()


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    settings = get_settings()
    db_url = settings.database_url
    if not db_url:
        raise RuntimeError("DATABASE_URL is not set")

    instance = settings.cloud_sql_instance
    parsed = urlparse(db_url)
    user = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = (parsed.path or "").lstrip("/")

    if instance:
        # Route via Cloud SQL connector. Use pg8000 (pure-Python; works inside
        # the connector's socket factory). Engine is sync; runner uses
        # asyncio.to_thread to keep the FastAPI loop non-blocking.
        connector = _connector()

        def getconn():
            return connector.connect(
                instance,
                "pg8000",
                user=user,
                password=password,
                db=database,
                ip_type=IPTypes.PUBLIC,
            )

        return create_engine(
            "postgresql+pg8000://",
            creator=getconn,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,
        )

    # Local fallback — direct connection (e.g., to a local cloud-sql-proxy).
    return create_engine(
        db_url,
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
    )


@lru_cache(maxsize=1)
def session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def open_session() -> Session:
    return session_factory()()
