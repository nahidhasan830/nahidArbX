#!/usr/bin/env python3
"""Deploy the latest DB-stored ONNX model to Vertex AI and patch ml_models."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OPTIMIZER_ROOT = REPO_ROOT / "services" / "optimizer"
sys.path.insert(0, str(OPTIMIZER_ROOT))


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env(REPO_ROOT / ".env")
os.environ.setdefault("VERTEX_MODEL_BUCKET", "gs://nahidarbx-ml-models")

from app.db import open_session
from app.vertex_registry import deploy_onnx_path_to_vertex
from sqlalchemy import text


def main() -> int:
    version_arg = sys.argv[1] if len(sys.argv) > 1 else None
    session = open_session()
    try:
        if version_arg:
            row = session.execute(
                text("""
                    SELECT id, version, onnx_blob
                    FROM ml_models
                    WHERE version = :version
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {"version": int(version_arg)},
            ).mappings().first()
        else:
            row = session.execute(
                text("""
                    SELECT id, version, onnx_blob
                    FROM ml_models
                    WHERE status = 'deployed'
                    ORDER BY deployed_at DESC
                    LIMIT 1
                """),
            ).mappings().first()

        if not row:
            raise RuntimeError("No matching ml_models row found")
        if row["onnx_blob"] is None:
            raise RuntimeError(f"Model v{row['version']} has no onnx_blob")

        with tempfile.TemporaryDirectory() as tmpdir:
            onnx_path = Path(tmpdir) / f"model_v{row['version']}.onnx"
            onnx_path.write_bytes(bytes(row["onnx_blob"]))
            model_name, endpoint_name = deploy_onnx_path_to_vertex(
                str(onnx_path),
                int(row["version"]),
            )

        session.execute(
            text("""
                UPDATE ml_models
                SET vertex_model_name = :model_name,
                    vertex_endpoint_name = :endpoint_name,
                    model_artifact_path = :model_name,
                    progress_message = 'Model deployed to Vertex AI Prediction'
                WHERE id = :id
            """),
            {
                "id": row["id"],
                "model_name": model_name,
                "endpoint_name": endpoint_name,
            },
        )
        session.commit()
        print(f"Deployed v{row['version']} to Vertex")
        print(f"model={model_name}")
        print(f"endpoint={endpoint_name}")
        return 0
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
