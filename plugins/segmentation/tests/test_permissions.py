"""The manifest asks for what the providers need and nothing more; secrets only via the broker."""

from pathlib import Path

import pytest
import yaml

from studio_plugin_segmentation.tools import segment_objects

MANIFEST = yaml.safe_load((Path(__file__).parent.parent / "plugin.yaml").read_text())


def test_provider_needs_are_declared_permissions():
    perms = set(MANIFEST["permissions"]["required"]) | set(MANIFEST["permissions"]["optional"])
    for p in MANIFEST["providers"]:
        for host in p.get("egress", []):
            assert f"network.egress:{host}" in perms
        for s in p.get("secrets", []):
            assert f"secrets.use:{s}" in perms
    # Hosted and network permissions are optional: a workspace grants them only if it uses that provider.
    assert all(not p.startswith(("network.", "secrets.")) for p in MANIFEST["permissions"]["required"])


def test_hosted_provider_without_a_granted_secret_fails_closed(ctx):
    # The runner reports PermissionError as a non-recoverable job error.
    with pytest.raises(PermissionError, match="META_MODEL_API_KEY"):
        segment_objects(ctx("meta.sam", config={"metaEndpoint": "https://api.example.test/sam"}), {"asset_id": "img/sample.png"})


def test_unreadable_assets_are_permission_errors(ctx):
    with pytest.raises(PermissionError):
        segment_objects(ctx(), {"asset_id": "img/other.png"})
