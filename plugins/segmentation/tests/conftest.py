from pathlib import Path

import pytest
from studio_plugin_sdk import JobsClient, SecretsClient, ToolContext

FIXTURES = Path(__file__).parent.parent / "fixtures"
REPO = Path(__file__).resolve().parents[3]


class FakeAssets:
    def __init__(self, data: dict[str, bytes]):
        self.data = data

    def read(self, asset_id: str) -> bytes:
        if asset_id not in self.data:
            raise PermissionError(asset_id)
        return self.data[asset_id]


@pytest.fixture
def ctx():
    def make(provider="mock", config=None, secrets=None, progress=None):
        return ToolContext(
            workspace_id="w",
            job_id="j",
            assets=FakeAssets({"img/sample.png": (FIXTURES / "sample_image.png").read_bytes()}),
            jobs=JobsClient((progress if progress is not None else []).append),
            secrets=SecretsClient(None, secrets or {}),
            provider={"id": provider},
            config=config or {},
        )

    return make
