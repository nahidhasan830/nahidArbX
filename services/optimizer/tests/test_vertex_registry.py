from dataclasses import dataclass

import pytest

from app.vertex_registry import (
    _deployed_model_ids,
    _find_deployed_model_id,
    _undeploy_other_models,
    _vertex_labels,
)


@dataclass
class FakeDeployedModel:
    id: str
    display_name: str


class FakeEndpoint:
    resource_name = "projects/p/locations/r/endpoints/e"

    def __init__(self, deployed_models: list[FakeDeployedModel]) -> None:
        self.deployed_models = deployed_models
        self.undeployed: list[str] = []

    def list_models(self) -> list[FakeDeployedModel]:
        return self.deployed_models

    def undeploy(self, deployed_model_id: str, sync: bool = True) -> None:
        self.undeployed.append(deployed_model_id)


def test_vertex_labels_accept_static_metadata() -> None:
    assert _vertex_labels(
        app="nahidarbx",
        version=12,
        framework="lightgbm",
        purpose="bet-scoring",
    ) == {
        "app": "nahidarbx",
        "version": "12",
        "framework": "lightgbm",
        "purpose": "bet-scoring",
    }


def test_vertex_labels_reject_decimal_metric_values() -> None:
    with pytest.raises(ValueError, match="Invalid Vertex AI label value"):
        _vertex_labels(auc_roc="0.5123")


def test_vertex_labels_reject_more_than_64_labels() -> None:
    labels = {f"k{i}": "v" for i in range(65)}
    with pytest.raises(ValueError, match="at most 64 labels"):
        _vertex_labels(**labels)


def test_deployed_model_ids_reads_endpoint_models() -> None:
    endpoint = FakeEndpoint(
        [
            FakeDeployedModel("old", "lightgbm-v12"),
            FakeDeployedModel("new", "lightgbm-v13"),
        ]
    )

    assert _deployed_model_ids(endpoint) == {"old", "new"}


def test_find_deployed_model_id_prefers_new_matching_deployment() -> None:
    endpoint = FakeEndpoint(
        [
            FakeDeployedModel("old", "lightgbm-v16"),
            FakeDeployedModel("new", "lightgbm-v16"),
        ]
    )

    assert (
        _find_deployed_model_id(
            endpoint,
            "lightgbm-v16",
            exclude_ids={"old"},
        )
        == "new"
    )


def test_undeploy_other_models_keeps_new_deployment() -> None:
    endpoint = FakeEndpoint(
        [
            FakeDeployedModel("old-a", "lightgbm-v12"),
            FakeDeployedModel("new", "lightgbm-v16"),
            FakeDeployedModel("old-b", "lightgbm-v13"),
        ]
    )

    _undeploy_other_models(endpoint, "new")

    assert endpoint.undeployed == ["old-a", "old-b"]
