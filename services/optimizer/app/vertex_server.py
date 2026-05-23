"""Vertex AI custom prediction server for the LightGBM ONNX scorer."""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from google.cloud import storage

from .feature_names import FEATURE_COUNT

log = logging.getLogger(__name__)


def _model_path() -> Path:
    storage_uri = os.environ.get("AIP_STORAGE_URI")
    if not storage_uri:
        raise RuntimeError("AIP_STORAGE_URI is not set")

    if storage_uri.startswith("gs://"):
        return _download_model(storage_uri)

    model_path = Path(storage_uri) / "model.onnx"
    if not model_path.exists():
        raise FileNotFoundError(f"model.onnx not found at {model_path}")
    return model_path


def _download_model(storage_uri: str) -> Path:
    without_scheme = storage_uri.removeprefix("gs://").rstrip("/")
    bucket_name, _, prefix = without_scheme.partition("/")
    if not bucket_name or not prefix:
        raise RuntimeError(f"Invalid AIP_STORAGE_URI: {storage_uri}")

    local_path = Path("/tmp/nahidarbx-model.onnx")
    if local_path.exists():
        return local_path

    blob_name = f"{prefix}/model.onnx"
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.download_to_filename(local_path)
    log.info("Downloaded ONNX model from gs://%s/%s", bucket_name, blob_name)
    return local_path


class OnnxScorer:
    def __init__(self) -> None:
        path = _model_path()
        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        log.info("Loaded ONNX model from %s", path)

    def predict(self, instances: Any) -> list[list[float]]:
        if not isinstance(instances, list):
            raise ValueError("instances must be an array")

        features = np.asarray(instances, dtype=np.float32)
        if features.ndim == 1:
            features = features.reshape(1, -1)
        if features.ndim != 2 or features.shape[1] != FEATURE_COUNT:
            raise ValueError(
                f"instances must have shape [n,{FEATURE_COUNT}], got {features.shape}",
            )

        results = self.session.run(None, {self.input_name: features})
        probabilities = results[1]
        if isinstance(probabilities, np.ndarray):
            rows = probabilities.tolist()
        elif isinstance(probabilities, list):
            rows = [
                [float(row.get(0, 0.0)), float(row.get(1, 0.0))]
                if isinstance(row, dict)
                else [float(row[0]), float(row[1])]
                for row in probabilities
            ]
        else:
            raise ValueError(f"Unexpected ONNX probability output: {type(probabilities)!r}")

        return [[float(row[0]), float(row[1])] for row in rows]


SCORER: OnnxScorer | None = None


def _get_scorer() -> OnnxScorer:
    global SCORER
    if SCORER is None:
        SCORER = OnnxScorer()
    return SCORER


class Handler(BaseHTTPRequestHandler):
    server_version = "NahidArbXVertexScorer/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            try:
                _get_scorer()
                self._json({"status": "ok"})
            except Exception as exc:
                log.exception("Health check failed")
                self._json({"status": "error", "error": str(exc)}, status=503)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/predict":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            predictions = _get_scorer().predict(body.get("instances"))
            self._json({"predictions": predictions})
        except Exception as exc:
            log.exception("Prediction failed")
            self._json({"error": str(exc)}, status=400)

    def log_message(self, fmt: str, *args: object) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    def _json(self, payload: dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    port = int(os.environ.get("AIP_HTTP_PORT", os.environ.get("PORT", "8080")))
    _get_scorer()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log.info("Vertex prediction server listening on port %d", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
