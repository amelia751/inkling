import json
import subprocess
import sys
import textwrap
from pathlib import Path

import httpx
import pytest

from studio_plugin_sdk import naming
from studio_plugin_sdk.context import AnnotationsClient

REPO_NAMING = json.loads((Path(__file__).resolve().parents[3] / "schemas" / "naming.json").read_text())


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.delenv(naming.NAMING_FILE_ENV, raising=False)
    naming.configure(None)
    yield
    naming.configure(None)


def test_reads_the_repo_naming_config_from_a_checkout():
    assert naming.naming() == REPO_NAMING
    assert naming.ns("segmentation") == f"{REPO_NAMING['namespace']}.segmentation"
    assert naming.plugin_schema_version() == f"{REPO_NAMING['schemaPrefix']}.plugins/v1"


def test_env_override_and_legacy_namespaces(tmp_path, monkeypatch):
    f = tmp_path / "naming.json"
    f.write_text(json.dumps({**REPO_NAMING, "namespace": "acme", "envPrefix": "ACME_", "legacyNamespaces": ["old"]}))
    monkeypatch.setenv(naming.NAMING_FILE_ENV, str(f))
    monkeypatch.setenv("ACME_E2E", "1")
    assert naming.ns("x") == "acme.x"
    assert naming.canonical_id("old.seg.tool") == "acme.seg.tool" and naming.canonical_id("other.y") == "other.y"
    assert naming.env("E2E") == "1"
    monkeypatch.setenv(naming.NAMING_FILE_ENV, str(tmp_path / "missing.json"))
    naming.configure(None)
    with pytest.raises(FileNotFoundError):
        naming.naming()


def test_configured_values_win_and_are_checked():
    naming.configure({**REPO_NAMING, "namespace": "job"})
    assert naming.ns("a") == "job.a"
    with pytest.raises(ValueError):
        naming.configure({"namespace": "x"})


def test_installed_copy_outside_the_repo_uses_the_job_config(tmp_path):
    """Inside a plugin's uv env the SDK is a copy with no repo above it: the runner applies the
    naming config the worker sends with the job before importing the plugin."""
    src = Path(naming.__file__).resolve().parent
    pkg = tmp_path / "site" / "studio_plugin_sdk"
    pkg.mkdir(parents=True)
    for p in src.glob("*.py"):
        (pkg / p.name).write_text(p.read_text())
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "named_plugin.py").write_text(textwrap.dedent('''
        from studio_plugin_sdk.naming import ns
        TOOL_ID = ns("named.echo")

        def register(tools):
            @tools.tool("echo")
            def echo(ctx, req):
                return {"id": TOOL_ID}
    '''))
    httpx_dir = Path(httpx.__file__).resolve().parents[1]
    job = {"entrypoint": "named_plugin:register", "tool": "echo", "input": {}, "kernelUrl": "http://127.0.0.1:9", "sessionToken": "t", "workspaceId": "w", "jobId": "j", "naming": {**REPO_NAMING, "namespace": "acme"}}
    env = {"PYTHONPATH": f"{tmp_path / 'work'}:{tmp_path / 'site'}:{httpx_dir}", "PATH": ""}
    p = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path[:0] = sys.argv[1].split(':'); from studio_plugin_sdk.runner import main; raise SystemExit(main())", env["PYTHONPATH"]], input=json.dumps(job), capture_output=True, text=True, cwd=tmp_path / "work", env=env)
    last = json.loads(p.stdout.splitlines()[-1])
    assert last == {"type": "result", "result": {"id": "acme.named.echo"}, "costUsd": None}, p.stderr
    # Without the job's config and with no checkout above it, it fails loudly instead of guessing.
    del job["naming"]
    p = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path[:0] = sys.argv[1].split(':'); from studio_plugin_sdk.runner import main; raise SystemExit(main())", env["PYTHONPATH"]], input=json.dumps(job), capture_output=True, text=True, cwd=tmp_path / "work", env=env)
    last = json.loads(p.stdout.splitlines()[-1])
    assert last["type"] == "error" and "no naming config" in last["error"]


def kernel(handler):
    return httpx.Client(base_url="http://kernel", transport=httpx.MockTransport(handler))


def test_annotations_write_goes_to_the_kernel_bound_to_the_job():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(path=req.url.path, job=req.headers.get("X-Job-Id"), key=req.headers.get("Idempotency-Key"), body=json.loads(req.content))
        return httpx.Response(200, json={"annotationIds": ["k1"]})

    ids = AnnotationsClient(kernel(handler), "job-7").write([{"id": "a", "itemId": "i", "label": "l", "geometry": {"type": "box", "x": 0, "y": 0, "w": 1, "h": 1}}], key="retry-safe")
    assert ids == ["k1"]
    assert seen["path"] == "/api/v1/annotations" and seen["job"] == "job-7" and seen["key"] == "retry-safe"
    assert seen["body"]["annotations"][0]["id"] == "a"


def test_annotations_write_errors_map_to_exceptions():
    def denied(req):
        return httpx.Response(403, json={"detail": "no annotations.write"})

    def invalid(req):
        return httpx.Response(422, json={"detail": "annotations[0]: mask.counts sum to 10"})

    with pytest.raises(PermissionError, match="annotations.write"):
        AnnotationsClient(kernel(denied), "j").write([{}])
    with pytest.raises(ValueError, match="mask.counts"):
        AnnotationsClient(kernel(invalid), "j").write([{}])
