"""todo10 Phase 8: export/import as OCI image layouts between installations, and promotion
tiers (generated → organisation → curated) with a second person's review."""

from __future__ import annotations

import io
import json
import tarfile

from .conftest import ws
from .test_artifacts import GEN, build, package, token

ALICE = ws("ws-a", **{"X-Dev-Principal": "user:alice"})
BOB = ws("ws-a", **{"X-Dev-Principal": "user:bob"})


def export(c, version="0.1.0", headers=None):
    return c.get(f"/api/v1/plugins/{GEN}/export", params={"version": version}, headers=headers or ws("ws-a"))


def layout_files(data: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        return {m.name: tf.extractfile(m).read() for m in tf.getmembers() if m.isreg()}  # type: ignore[union-attr]


def retar(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, b in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(b)
            tf.addfile(info, io.BytesIO(b))
    return buf.getvalue()


def test_export_is_an_oci_layout_with_signature_and_attestation_referrers(client):
    r = build(client, package()).json()
    res = export(client)
    assert res.status_code == 200 and res.headers["X-Manifest-Digest"] == r["manifestDigest"]
    files = layout_files(res.content)
    assert json.loads(files["oci-layout"]) == {"imageLayoutVersion": "1.0.0"}
    index = json.loads(files["index.json"])
    tagged = [m for m in index["manifests"] if (m.get("annotations") or {}).get("org.opencontainers.image.ref.name") == "0.1.0"]
    assert [m["digest"] for m in tagged] == [r["manifestDigest"]]
    referrers = [json.loads(files[f"blobs/sha256/{m['digest'][7:]}"]) for m in index["manifests"] if m not in tagged]
    assert {x["artifactType"] for x in referrers} == {"application/vnd.in-toto+json", next(x["artifactType"] for x in referrers if x["artifactType"].endswith("signature.v1+json"))}
    assert all(x["subject"]["digest"] == r["manifestDigest"] for x in referrers)
    for name, b in files.items():  # every blob is named by its own digest
        if name.startswith("blobs/"):
            import hashlib

            assert hashlib.sha256(b).hexdigest() == name.split("/")[-1]
    # Agents never move artifacts between installations.
    agent = token(client, "ws-a", ["plugins.read", "plugins.manage", "plugins.author"])
    assert export(client, headers=agent).status_code == 403
    assert client.post("/api/v1/plugins/import", content=res.content, headers=agent).status_code == 403


def test_import_into_another_installation_needs_a_trusted_key(make_client, tmp_path):
    a = make_client()
    build(a, package())
    from studio_api.plugins import store

    a_key = store.signer()
    layout = export(a).content

    # Installation B: its own database, data dir and signing key; it doesn't trust A yet.
    b = make_client(data_dir=tmp_path / "data-b")
    assert store.signer().key_id != a_key.key_id
    res = b.post("/api/v1/plugins/import", content=layout, headers=ws("ws-a"))
    assert res.status_code == 409 and "doesn't trust" in res.json()["detail"]["reason"]
    audit = b.get("/api/v1/audit", params={"action": "plugins.artifact.refused"}, headers=ws("ws-a")).json()["entries"]
    assert audit[0]["after"]["where"] == "import"

    trusted = tmp_path / "trusted.json"
    trusted.write_text(json.dumps({a_key.key_id: a_key.public_key_pem()}))
    b = make_client(data_dir=tmp_path / "data-c", signer_trusted_keys_file=trusted)
    # A flipped byte anywhere in the layout is refused before anything is stored.
    files = layout_files(layout)
    big = max((n for n in files if n.startswith("blobs/")), key=lambda n: len(files[n]))
    evil = bytearray(files[big])
    evil[len(evil) // 2] ^= 1
    res = b.post("/api/v1/plugins/import", content=retar({**files, big: bytes(evil)}), headers=ws("ws-a"))
    assert res.status_code in (409, 422) and b.get(f"/api/v1/plugins/{GEN}", headers=ws("ws-a")).status_code == 404

    res = b.post("/api/v1/plugins/import", content=layout, headers=ws("ws-a"))
    assert res.status_code == 200, res.text
    assert res.json()["imported"][0]["trustTier"] == "generated"
    # Imported artifacts install through the same verified path, and re-import is idempotent.
    plan = b.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=ws("ws-a")).json()
    staged = b.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert staged["state"] == "AWAITING_APPROVAL", staged
    assert b.post("/api/v1/plugins/import", content=layout, headers=ws("ws-a")).json() == {"imported": []}


def _org(client, org: str, *projects: str) -> None:
    from studio_api import db
    from studio_api.models import Organization, ProjectRow

    with db.session_scope() as s:
        s.add(Organization(id=org, name=org, kind="team"))
        s.flush()
        for p in projects:
            row = s.get(ProjectRow, p)
            if row is None:
                s.add(ProjectRow(id=p, org_id=org, title=p, created_by="user:alice"))
            else:
                row.org_id = org


def test_promotion_tiers_need_a_second_person(client):
    _org(client, "org-1", "ws-a", "ws-c")
    _org(client, "org-2", "ws-b")
    assert build(client, package(), headers=ALICE).json()["registered"]
    visible = lambda w: client.get(f"/api/v1/plugins/{GEN}", headers=ws(w)).status_code == 200  # noqa: E731
    assert (visible("ws-a"), visible("ws-c"), visible("ws-b")) == (True, False, False)

    # The agent may ask; nobody can approve their own request or their own artifact.
    agent = token(client, "ws-a", ["plugins.read", "plugins.manage", "plugins.author"])
    p = client.post(f"/api/v1/plugins/{GEN}/promotions", json={"version": "0.1.0", "reason": "useful to the team"}, headers=agent).json()
    assert p["from"] == "generated" and p["to"] == "organisation" and p["state"] == "requested"
    review = lambda h, d="approve": client.post(f"/api/v1/plugins/promotions/{p['id']}/review", json={"decision": d}, headers=h)  # noqa: E731
    assert review(agent).status_code == 403
    assert review(ALICE).status_code == 403  # the author
    r = review(BOB)
    assert r.status_code == 200 and r.json()["state"] == "approved"
    assert (visible("ws-a"), visible("ws-c"), visible("ws-b")) == (True, True, False)
    assert client.get("/api/v1/plugins", params={"q": "counter"}, headers=ws("ws-c")).json()["plugins"][0]["trustTier"] == "organisation"

    # organisation → curated: every workspace of the installation.
    p = client.post(f"/api/v1/plugins/{GEN}/promotions", json={"version": "0.1.0"}, headers=BOB).json()
    assert p["to"] == "curated"
    carol = ws("ws-a", **{"X-Dev-Principal": "user:carol"})
    assert review(BOB).status_code == 403  # the requester
    assert review(carol, "reject").json()["state"] == "rejected"
    assert visible("ws-b") is False
    p = client.post(f"/api/v1/plugins/{GEN}/promotions", json={"version": "0.1.0"}, headers=BOB).json()
    assert review(carol).json()["state"] == "approved"
    assert visible("ws-b")
    assert client.post(f"/api/v1/plugins/{GEN}/promotions", json={"version": "0.1.0"}, headers=BOB).status_code == 409  # top tier
    # Another workspace still can't publish a new version over the id.
    assert any("another workspace" in e for e in build(client, package("0.2.0"), workspace="ws-b", dryRun="true").json()["errors"])
    actions = [e["action"] for e in client.get("/api/v1/audit", headers=ws("ws-a")).json()["entries"]]
    assert actions.count("plugins.promotion.approved") == 2 and "plugins.promotion.rejected" in actions
    listed = client.get("/api/v1/plugins/promotions", headers=ws("ws-a")).json()["promotions"]
    assert [x["state"] for x in listed] == ["approved", "rejected", "approved"]


def test_promotion_re_verifies_the_artifact(client, tmp_path):
    _org(client, "org-1", "ws-a")
    r = build(client, package(), headers=ALICE).json()
    p = client.post(f"/api/v1/plugins/{GEN}/promotions", json={"version": "0.1.0"}, headers=ALICE).json()
    manifest = json.loads((tmp_path / "data" / "artifacts" / "sha256" / r["manifestDigest"][7:]).read_bytes())
    layer = tmp_path / "data" / "artifacts" / "sha256" / manifest["layers"][0]["digest"][7:]
    layer.write_bytes(layer.read_bytes().replace(b"# Counter", b"# Evil!!"))
    res = client.post(f"/api/v1/plugins/promotions/{p['id']}/review", json={"decision": "approve"}, headers=BOB)
    assert res.status_code == 409 and "doesn't match its digest" in res.json()["detail"]["reason"]
