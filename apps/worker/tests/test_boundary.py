"""todo10 Phase 7 in the worker: boundary jobs against a live kernel, on samples with a canary in
the header and the pixels. The canary must never appear in anything the agent could receive:
fingerprints, fixtures, probe answers, verify reports, build results or job summaries."""

from __future__ import annotations

import io
import json
import tarfile

import httpx
import pytest
import yaml
from studio_signing import LocalSigner

from studio_worker.boundary import build as wbuild
from studio_worker.main import Worker

from .canary import CANARY, INKB_CONVERTER, INKB_H, INKB_NAME_OFFSET, INKB_W, LEAKY_CONVERTER, NETWORK_CONVERTER

H = {"X-Workspace-Id": "bnd"}


def tarball(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in files.items():
            data = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def plugin_source(converter: str, version: str = "0.1.0") -> dict[str, str]:
    from studio_api.naming import ns, plugin_schema_version

    m = {
        "schemaVersion": plugin_schema_version(), "id": ns("generated.inkb"), "name": "INKB", "version": version, "publisher": "generated", "license": "MIT",
        "compatibility": {"studio": ">=0.1.0 <1.0.0", "pluginApi": "^1"}, "capabilities": [], "runtime": {"kind": "none"}, "permissions": {"required": [], "optional": []},
    }
    return {"plugin.yaml": yaml.safe_dump(m, sort_keys=False), "inkb_convert.py": converter, "README.md": "# INKB\n"}


@pytest.fixture
def boundary(stack, tmp_path):
    url = stack["url"]
    worker = Worker(url, stack["token"], tmp_path, "w-boundary", signer=LocalSigner.from_file(stack["build_key"]))
    seen: list[str] = []  # everything the agent would have received

    def call(method: str, path: str, **kw) -> dict:
        r = httpx.request(method, f"{url}{path}", headers=H, timeout=60, **kw)
        assert r.status_code < 300, r.text
        seen.append(r.text)
        return r.json()

    def run(method: str, path: str, **kw) -> dict:
        """Start a job, let the worker run it, return the agent's view of it."""
        r = call(method, path, **kw)
        job = r.get("job")
        if job is None:
            return r
        assert worker.tick()
        return call("GET", f"/api/v1/boundary/jobs/{job['jobId']}")

    def fixture_bytes(set_id: str, name: str) -> bytes:
        r = httpx.get(f"{url}/api/v1/boundary/fixtures/{set_id}/{name}", headers=H)
        assert r.status_code == 200
        seen.append(r.content.decode("latin1"))
        return r.content

    yield {"run": run, "call": call, "seen": seen, "fixture": fixture_bytes, "worker": worker}
    assert not any(CANARY in s for s in seen), "the canary crossed the boundary"


@pytest.mark.parametrize("sample", ["bnd/scan.dcm", "bnd/scan.inkb"])
def test_fingerprint_and_fixtures_never_carry_the_canary(boundary, sample):
    v = boundary["run"]("POST", "/api/v1/boundary/fingerprints", json={"sample": sample})
    fp = v["result"]
    assert v["job"]["state"] == "succeeded", v
    if sample.endswith(".dcm"):
        assert fp["format"]["kind"] == "dicom" and fp["scrub"]["profile"] == "dicom-ps3.15-annex-e-basic"
        assert {"PatientName", "PatientID", "InstitutionName"} <= {f["name"] for f in fp["fields"]}
        assert fp["dicom"]["rows"] == 16 and fp["dicom"]["modality"] == "CT" and fp["dicom"]["removedTags"] >= 4
        assert fp["arrays"][0]["shape"] == [16, 16] and fp["arrays"][0]["dtype"] == "uint8"
    else:
        assert fp["format"] == {"kind": "binary", "magic": "494e4b42", "magicOffset": 0}
        assert any(s["kind"] == "metadata" for s in fp["sections"])
    fx = boundary["run"]("POST", "/api/v1/boundary/fixtures", json={"sample": sample, "count": 3})["result"]
    assert len(fx["fixtures"]) == 3
    for f in fx["fixtures"]:
        data = boundary["fixture"](fx["fixtureSetId"], f["name"])
        assert CANARY.encode() not in data and len(data) == f["bytes"]
    if sample.endswith(".dcm"):
        import pydicom

        first = boundary["fixture"](fx["fixtureSetId"], fx["fixtures"][0]["name"])
        ds = pydicom.dcmread(io.BytesIO(first))
        assert ds.Rows == 16 and ds.Columns == 16 and str(ds.PatientName) == "SYNTHETIC^FIXTURE"
    else:
        first = boundary["fixture"](fx["fixtureSetId"], fx["fixtures"][0]["name"])
        assert first[:4] == b"INKB" and len(first) == fp["bytes"]


def test_probes_answer_numbers_and_hide_text(boundary):
    probes = [
        {"op": "magic", "offset": 0, "hex": "494e4b42"},
        {"op": "read_int", "offset": 6, "width": 2, "signed": False, "endian": "little"},  # header length
        {"op": "read_int", "offset": 8, "width": 4, "signed": False, "endian": "little"},  # width
        {"op": "read_int", "offset": 12, "width": 4, "signed": False, "endian": "little"},  # height
        {"op": "read_text", "offset": INKB_NAME_OFFSET, "length": 24},
        {"op": "read_text", "offset": 0, "length": 4},
        {"op": "size"},
    ]
    r = boundary["run"]("POST", "/api/v1/boundary/probes", json={"sample": "bnd/scan.inkb", "probes": probes})["result"]
    a = r["answers"]
    assert a[0]["value"] is True and a[1]["value"] == 49 and a[2]["value"] == INKB_W and a[3]["value"] == INKB_H
    assert a[4]["value"].startswith("<redacted:")
    assert a[5]["value"] == "<redacted:4>"  # "INKB" isn't a vocabulary word either: placeholders err safe
    assert a[6]["value"] == 49 + INKB_W * INKB_H * 4


def test_verify_reports_shapes_and_classes_never_messages(boundary):
    ok = boundary["run"]("POST", "/api/v1/boundary/verify?sample=bnd/scan.inkb&entrypoint=inkb_convert:convert", content=tarball(plugin_source(INKB_CONVERTER)))["result"]
    assert ok["pass"] is True and ok["stage"] == "done", ok
    assert ok["outputs"][0]["name"] == "image" and ok["outputs"][0]["shape"] == [INKB_H, INKB_W] and ok["outputs"][0]["dtype"] == "float32"
    leaky = boundary["run"]("POST", "/api/v1/boundary/verify?sample=bnd/scan.inkb&entrypoint=inkb_convert:convert", content=tarball(plugin_source(LEAKY_CONVERTER)))["result"]
    assert leaky["pass"] is False and leaky["errorClass"] == "ValueError" and leaky["errorFile"] == "inkb_convert.py" and leaky["errorLine"] == 5
    net = boundary["run"]("POST", "/api/v1/boundary/verify?sample=bnd/scan.inkb&entrypoint=inkb_convert:convert", content=tarball(plugin_source(NETWORK_CONVERTER)))["result"]
    assert net["pass"] is False and net["errorClass"] == "NetworkBlocked"
    missing = boundary["run"]("POST", "/api/v1/boundary/verify?sample=bnd/scan.inkb&entrypoint=inkb_convert:nope", content=tarball(plugin_source(INKB_CONVERTER)))["result"]
    assert missing["errorClass"] == "EntrypointMissing"


def test_build_registers_our_rebuild_not_the_sandbox_bundle(boundary):
    src = plugin_source(INKB_CONVERTER, "0.2.0")
    sandbox = {**src, "dist/inkb-0.2.0.whl": b"PK\x03\x04 sandbox build", "__pycache__/inkb_convert.cpython-312.pyc": b"\x00\x01"}
    sandbox_digest = wbuild.files_digest({k: v.encode() if isinstance(v, str) else v for k, v in sandbox.items()})
    r = boundary["run"]("POST", f"/api/v1/boundary/builds?sandboxDigest={sandbox_digest}", content=tarball(sandbox))
    res = r["result"]
    assert res["pass"] and res["registered"], res
    ours = wbuild.files_digest({k: v.encode() for k, v in src.items()})
    assert res["artifactDigest"] == ours and res["matchesSandbox"] is False and res["sandboxDigest"] == sandbox_digest
    assert {(d["path"], d["reason"]) for d in res["dropped"]} == {("dist/inkb-0.2.0.whl", "build-output"), ("__pycache__/inkb_convert.cpython-312.pyc", "build-output")}
    assert res["signature"]["keyId"].startswith("ed25519:")
    # The registry entry is our build.
    plugins = httpx.get(f"{boundary['worker'].kernel}/api/v1/plugins", params={"q": "inkb"}, headers=H).json()["plugins"]
    entry = next(p for p in plugins if p["id"].endswith("generated.inkb"))
    assert json.dumps(entry).count(ours) >= 1
