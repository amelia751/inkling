"""todo10 Phase 7: the data boundary in the kernel. Agent tokens reach only the allowlisted
routes; boundary jobs return fixed-schema results the kernel validates and re-checks; probes
are budgeted and audited; builds are verified (digest, signature) before registration."""

from __future__ import annotations

import hashlib

from studio_signing import LocalSigner, envelope

from studio_api.kernel import agent_scope
from studio_api.plugins import digest

from .conftest import worker_headers, ws
from .test_artifacts import package, tarball, token

D = "sha256:" + "0" * 64
BOUNDARY_SCOPES = ["samples.inspect", "samples.verify", "plugins.read", "plugins.manage", "plugins.author", "annotations.read", "assets.write"]


def agent(c, scopes=BOUNDARY_SCOPES):
    return token(c, "ws-a", scopes)


def claim(c, worker="w1"):
    r = c.post("/api/v1/worker/claim", json={"workerId": worker}, headers=worker_headers()).json()
    assert r["job"] and r.get("builtin") == "boundary", r
    return r["job"]


def complete(c, job, result, worker="w1"):
    return c.post(f"/api/v1/worker/boundary/jobs/{job['jobId']}/complete", json={"workerId": worker, "result": result}, headers=worker_headers())


def view(c, h, job_id):
    r = c.get(f"/api/v1/boundary/jobs/{job_id}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def fingerprint(sample_id, **extra):
    return {
        "schema": "boundary.fingerprint/v1",
        "sampleId": sample_id,
        "sampleDigest": D,
        "bytes": 100,
        "format": {"kind": "png", "magic": "89504e47", "magicOffset": 0},
        "endianness": "big",
        "sections": [{"name": "IHDR", "offset": 8, "length": 25, "kind": "header"}],
        "fields": [{"name": "width", "dtype": "uint32"}, {"name": "Jane.Doe@example.com", "dtype": "string"}],
        "arrays": [{"name": "pixels", "dtype": "uint8", "shape": [30, 40], "endianness": "none"}],
        "table": None,
        "dicom": None,
        "scrub": {"profile": "generic-structure-v1", "valuesDropped": 3, "namesRedacted": 0, "textCheck": "x"},
        **extra,
    }


def test_every_agent_route_exists_and_the_rest_are_refused(client):
    from studio_api.app import create_app

    app = create_app(init_db=False)
    routes = set()
    for r in app.router.routes:
        for sub in getattr(r, "routes", [r]):
            for m in getattr(sub, "methods", ()) or ():
                routes.add((m, sub.path))
    # Included routers are flattened differently across FastAPI versions; fall back to the modules.
    if len(routes) < 50:
        from studio_api.routes import boots, boundary, drops, environments, explore, files, kernel, plugins, projects, sources, versioning

        for mod in (boots, boundary, drops, environments, explore, files, kernel, plugins, projects, sources, versioning):
            for r in mod.router.routes:
                routes |= {(m, r.path) for m in r.methods}
    missing = agent_scope.AGENT_ROUTES - routes
    assert not missing, f"allowlisted routes that don't exist: {sorted(missing)}"

    h = token(client, "ws-a", ["assets.read", "annotations.read", "commands.invoke", "plugins.read"], agent="task")
    a = client.get("/api/v1/assets", headers=h).json()["assets"][0]
    assert client.get("/api/v1/plugins", headers=h).status_code == 200
    for method, path in [
        ("GET", f"/api/v1/assets/{a['id']}/content"),
        ("GET", f"/api/v1/assets/{a['id']}/url"),
        ("POST", "/api/v1/assets/url-token"),
        ("GET", "/api/annotations/ws-a"),
        ("GET", "/api/v1/annotations"),
        ("GET", "/api/v1/jobs"),
        ("GET", "/api/v1/audit"),
        ("POST", "/api/v1/workspaces/ws-a/plugins/approve"),
    ]:
        assert client.request(method, path, headers=h).status_code == 403, (method, path)
    # A person (dev headers) still reads bytes.
    assert client.get(f"/api/v1/assets/{a['id']}/content", headers=ws("ws-a")).status_code == 200


def test_fingerprint_job_is_cleaned_validated_and_cached(client):
    h = agent(client)
    r = client.post("/api/v1/boundary/fingerprints", json={"sample": "img/a.png"}, headers=h).json()
    assert r["fingerprint"] is None and r["job"]["kind"] == "fingerprint" and r["job"]["counts"]["total"] == "<20"
    job = claim(client)
    sid = job["input"]["sampleId"]
    # The worker reads the bytes through the job, and only the job's own sample.
    got = client.get(f"/api/v1/worker/boundary/jobs/{job['jobId']}/sample?workerId=w1", headers=worker_headers())
    assert got.status_code == 200 and got.content.startswith(b"\x89PNG")
    assert complete(client, job, fingerprint(sid)).json()["state"] == "succeeded"
    v = view(client, h, job["jobId"])
    names = [f["name"] for f in v["result"]["fields"]]
    assert names == ["width", "<redacted:20>"] and v["result"]["scrub"]["namesRedacted"] == 1
    assert v["result"]["scrub"]["textCheck"] == "dev-vocab-v1"
    # Second ask: the stored fingerprint, no new job.
    again = client.post("/api/v1/boundary/fingerprints", json={"sample": sid}, headers=h).json()
    assert again["job"] is None and again["fingerprint"]["sampleId"] == sid


def test_a_report_outside_the_schema_fails_and_keeps_nothing(client):
    h = agent(client)
    client.post("/api/v1/boundary/fingerprints", json={"sample": "img/a.png"}, headers=h)
    job = claim(client)
    bad = fingerprint(job["input"]["sampleId"], note="Patient: Jane Doe, DOB 1970-01-01")
    assert complete(client, job, bad).json()["state"] == "failed"
    v = view(client, h, job["jobId"])
    assert v["result"] is None and v["job"]["errorClasses"] == [{"errorClass": "OutputInvalid", "count": "<20"}]
    assert "Jane" not in str(v)


def test_fixture_jobs_get_the_fingerprint_not_the_sample(client):
    h = agent(client)
    assert client.post("/api/v1/boundary/fixtures", json={"sample": "img/a.png"}, headers=h).status_code == 409
    client.post("/api/v1/boundary/fingerprints", json={"sample": "img/a.png"}, headers=h)
    fj = claim(client)
    complete(client, fj, fingerprint(fj["input"]["sampleId"]))
    client.post("/api/v1/boundary/fixtures", json={"sample": "img/a.png", "count": 1}, headers=h)
    job = claim(client)
    assert job["tool"] == "synthesize_fixtures" and job["input"]["fingerprint"]["sampleId"] == fj["input"]["sampleId"]
    assert client.get(f"/api/v1/worker/boundary/jobs/{job['jobId']}/sample?workerId=w1", headers=worker_headers()).status_code == 403
    data = b"\x89PNG synthetic"
    put = client.put(f"/api/v1/worker/boundary/jobs/{job['jobId']}/fixtures/fixture-00.png?workerId=w1", content=data, headers={**worker_headers(), "Content-Type": "image/png"})
    assert put.status_code == 200
    res = {
        "schema": "boundary.fixtures/v1", "fixtureSetId": job["input"]["fixtureSetId"], "sampleId": job["input"]["sampleId"],
        "fingerprintDigest": job["input"]["fingerprintDigest"], "generator": "synthetic-v1", "seed": 7,
        "fixtures": [{"name": "fixture-00.png", "bytes": 1, "sha256": D, "mediaType": "image/png", "variant": "noise"}],
    }
    assert complete(client, job, res).json()["state"] == "succeeded"
    r = view(client, h, job["jobId"])["result"]
    assert r["fixtures"][0]["sha256"] == f"sha256:{hashlib.sha256(data).hexdigest()}"
    got = client.get(f"/api/v1/boundary/fixtures/{r['fixtureSetId']}/fixture-00.png", headers=h)
    assert got.status_code == 200 and got.content == data


def test_probes_are_typed_budgeted_audited_and_text_is_checked(make_client):
    c = make_client(boundary_probe_budget=3)
    h = agent(c)
    assert c.post("/api/v1/boundary/probes", json={"sample": "img/a.png", "probes": [{"op": "shell", "cmd": "cat"}]}, headers=h).status_code == 422
    ok = c.post("/api/v1/boundary/probes", json={"sample": "img/a.png", "probes": [{"op": "magic", "offset": 0, "hex": "89504e47"}, {"op": "read_text", "offset": 0, "length": 16}]}, headers=h)
    assert ok.status_code == 200
    job = claim(c)
    res = {
        "schema": "boundary.probe/v1", "sampleId": job["input"]["sampleId"], "sampleDigest": D,
        "answers": [
            {"op": "magic", "ok": True, "error": None, "value": True, "offsets": None, "names": None, "sections": None},
            {"op": "read_text", "ok": True, "error": None, "value": "CANARY Smith", "offsets": None, "names": None, "sections": None},
        ],
        "budget": {"used": 0, "limit": 0, "remaining": 0},
    }
    assert complete(c, job, res).json()["state"] == "succeeded"
    r = view(c, h, job["jobId"])["result"]
    assert r["answers"][1]["value"] == "<redacted:12>" and r["budget"] == {"used": 2, "limit": 3, "remaining": 1}
    over = c.post("/api/v1/boundary/probes", json={"sample": "img/a.png", "probes": [{"op": "size"}, {"op": "size"}]}, headers=h)
    assert over.status_code == 429
    entries = c.get("/api/v1/audit?action=boundary.probe", headers=ws("ws-a")).json()["entries"]
    assert len(entries) == 1 and entries[0]["after"]["probes"] == 2


def test_verify_report_lines_only_point_into_the_agents_source(client):
    h = agent(client)
    src = tarball(package())
    r = client.post("/api/v1/boundary/verify?sample=img/a.png&entrypoint=conv.main:convert", content=src, headers=h)
    assert r.status_code == 200, r.text
    job = claim(client)
    assert client.get(f"/api/v1/worker/boundary/jobs/{job['jobId']}/source?workerId=w1", headers=worker_headers()).content == src
    report = {
        "schema": "boundary.verify-report/v1", "pass": False, "sampleId": job["input"]["sampleId"], "sampleDigest": D,
        "sourceDigest": job["input"]["sourceDigest"], "stage": "convert", "errorClass": "ValueError", "errorFile": "lib/numpy/core.py", "errorLine": 99,
        "outputs": [], "durationMs": 5, "timedOut": False, "toolchain": {"python": "3.12.1", "runner": "verify-v1"},
    }
    complete(client, job, report)
    v = view(client, h, job["jobId"])["result"]
    assert v["errorClass"] == "ValueError" and v["errorFile"] is None and v["errorLine"] is None


def _build_job(c, h, files, sandbox_digest=None):
    q = f"?sandboxDigest={sandbox_digest}" if sandbox_digest else ""
    assert c.post(f"/api/v1/boundary/builds{q}", content=tarball(files), headers=h).status_code == 200
    return claim(c)


def test_builds_register_our_bundle_only_with_a_trusted_signature(make_client, tmp_path):
    key = tmp_path / "build.key"
    c = make_client(signer_key_file=key)
    h = agent(c)
    signer = LocalSigner.from_file(key)
    files = package()
    bundle = tarball(files)
    ours = digest.files_digest({k: v.encode() for k, v in files.items()})

    # An untrusted key: refused, nothing registered.
    job = _build_job(c, h, {**files, "dist/x.whl": "binary"}, sandbox_digest="sha256:" + "a" * 64)
    c.put(f"/api/v1/worker/boundary/jobs/{job['jobId']}/bundle?workerId=w1", content=bundle, headers=worker_headers())
    result = {"schema": "boundary.build/v1", "pass": True, "pluginId": None, "version": None, "artifactDigest": ours, "sourceDigest": D, "sandboxDigest": None, "matchesSandbox": None,
              "signature": envelope(LocalSigner.generate(), ours), "dropped": [{"path": "dist/x.whl", "reason": "build-output"}], "errors": [], "registered": False, "duplicate": False,
              "toolchain": {"python": "3.12.1", "builder": "canonical-source-v1"}}
    assert complete(c, job, result).json()["state"] == "failed"

    job = _build_job(c, h, {**files, "dist/x.whl": "binary"}, sandbox_digest="sha256:" + "a" * 64)
    c.put(f"/api/v1/worker/boundary/jobs/{job['jobId']}/bundle?workerId=w1", content=bundle, headers=worker_headers())
    assert complete(c, job, {**result, "signature": envelope(signer, ours)}).json()["state"] == "succeeded"
    r = view(c, h, job["jobId"])["result"]
    assert r["registered"] and r["artifactDigest"] == ours and r["matchesSandbox"] is False
    installed = c.get(f"/api/v1/plugins/{r['pluginId']}", headers=ws("ws-a")).json()
    assert (installed.get("artifactDigest") or installed.get("versions", [{}])[-1].get("artifactDigest")) == ours or ours in str(installed)


def test_filtered_annotations_drop_free_text(client):
    doc = {"annotations": [
        {"id": "a1", "itemId": "img/a.png", "label": "cat", "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4, "comment": "seen by Dr Smith"}, "provenance": "human-created", "attributes": {"note": "Patient Jane Doe called", "score": 0.9, "review_status": "accepted"}},
        {"id": "a2", "itemId": "Doe_Jane/scan.png", "label": "Jane Doe", "geometry": None, "attributes": {}},
    ]}
    assert client.put("/api/annotations/ws-a", json=doc, headers=ws("ws-a")).status_code == 200
    h = agent(client)
    r = client.get("/api/v1/boundary/annotations", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == "<20"
    a1, a2 = body["annotations"]
    assert a1["geometry"] == {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}
    assert a1["attributes"]["note"].startswith("<redacted:") and a1["attributes"]["score"] == 0.9 and a1["review"] == "accepted"
    assert a2["itemId"].startswith("<redacted:") and a2["label"].startswith("<redacted:")
    assert "Jane" not in r.text and "Smith" not in r.text
    exp = client.post("/api/v1/boundary/annotations/export", headers=h).json()
    assert exp["artifactId"] and exp["annotations"] == "<20"


def test_capability_jobs_reach_agents_as_summaries(client):
    from studio_api.kernel import boundary
    from studio_api.models import PluginJob

    h = agent(client)
    client.post("/api/v1/boundary/fingerprints", json={"sample": "img/a.png"}, headers=h)
    job = claim(client)
    c = client.post(f"/api/v1/worker/boundary/jobs/{job['jobId']}/fail", json={"workerId": "w1", "errorClass": "Traceback: /data/Jane_Doe.dcm"}, headers=worker_headers())
    assert c.json()["state"] == "failed"
    v = view(client, h, job["jobId"])
    assert v["job"]["errorClasses"][0]["errorClass"] == "Other"
    assert boundary.error_class("ValueError") == "ValueError" and PluginJob  # noqa: B018
