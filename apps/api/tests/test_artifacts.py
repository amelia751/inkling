"""§9 agent-authored plugins: artifact builder checks, signing, workspace-only visibility,
the code diff in the install plan, and scopes that keep approval with the user."""

from __future__ import annotations

import io
import json
import tarfile

import yaml

from studio_api.naming import ns, plugin_schema_version

from .conftest import ws

GEN = ns("generated.counter")


def tarball(files: dict[str, str | bytes], *, link: str | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in files.items():
            data = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        if link:
            info = tarfile.TarInfo(link)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tf.addfile(info)
    return buf.getvalue()


def package(version: str = "0.1.0", **overrides) -> dict[str, str]:
    m = {
        "schemaVersion": plugin_schema_version(),
        "id": GEN,
        "name": "Counter",
        "version": version,
        "publisher": "generated",
        "license": "MIT",
        "compatibility": {"studio": ">=0.1.0 <1.0.0", "pluginApi": "^1"},
        "capabilities": [],
        "runtime": {"kind": "none"},
        "ui": {"contributions": "ui/contributions.json"},
        "permissions": {"required": [], "optional": []},
    }
    m.update(overrides.pop("manifest", {}))
    ui = {
        "toolbarActions": [],
        "panels": [{"id": "count", "surface": "studio.panel.right", "title": "Count", "renderer": overrides.pop("renderer", "studio.declarative-panel.v1"), "dataBinding": "annotations.currentItem", "config": {"blocks": []}}],
    }
    return {"plugin.yaml": yaml.safe_dump(m, sort_keys=False), "ui/contributions.json": json.dumps(ui), "README.md": "# Counter\n", **overrides}


def build(c, files, workspace="ws-a", headers=None, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return c.post(f"/api/v1/plugins/artifacts{'?' + q if q else ''}", content=tarball(files) if isinstance(files, dict) else files, headers=headers or ws(workspace))


def token(c, workspace, scopes, agent="builder"):
    r = c.post("/api/v1/sessions", json={"agent": agent, "scopes": scopes, "profile": agent}, headers=ws(workspace))
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}", "X-Workspace-Id": workspace}


def test_dry_run_reports_problems_without_registering(client):
    bad = package(manifest={"ui": {"module": "ui/manifest.ts", "contributions": "ui/contributions.json"}}, renderer="evil.renderer.v1", **{"ui/x.tsx": "export {}"})
    r = build(client, bad, dryRun="true").json()
    assert not r["ok"]
    text = " ".join(r["errors"])
    assert "declarative UI" in text and "trusted renderer" in text and "JavaScript or TypeScript" in text
    assert client.get("/api/v1/plugins", params={"q": "counter"}, headers=ws("ws-a")).json()["plugins"] == []


def test_unsafe_archives_are_refused(client):
    assert build(client, tarball({"../escape.txt": "x", "plugin.yaml": "id: x"})).status_code == 422
    assert build(client, tarball(package(), link="ui/link")).status_code == 422
    assert build(client, b"not a tarball").status_code == 422


def test_unlocked_or_off_index_dependencies_fail(client):
    py = '[project]\nname="c"\nversion="0.1.0"\ndependencies=["evil"]\n[tool.uv.sources]\nevil = { git = "https://example.test/evil.git" }\n'
    r = build(client, package(**{"pyproject.toml": py}), dryRun="true").json()
    assert any("uv.lock" in e for e in r["errors"]) and any("not the package index" in e for e in r["errors"])


def test_first_party_ids_cant_be_taken(client):
    r = build(client, package(manifest={"id": ns("image2d")}), dryRun="true").json()
    assert any("can't take its id" in e for e in r["errors"])


def test_build_signs_registers_and_installs_through_review(client):
    r = build(client, package()).json()
    assert r["ok"] and r["registered"] and r["artifactDigest"].startswith("sha256:")
    found = client.get("/api/v1/plugins", params={"q": "counter"}, headers=ws("ws-a")).json()["plugins"]
    assert [p["trustTier"] for p in found] == ["generated"]
    # Same bytes again: idempotent. Same version, other bytes: immutable.
    assert build(client, package()).json()["duplicate"] is True
    assert build(client, package(**{"README.md": "# changed\n"})).status_code == 409

    plan = client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=ws("ws-a")).json()
    item = plan["plan"]["install"][0]
    assert plan["plan"]["risk"] == "high" and item["trustTier"] == "generated"
    assert item["codeDiff"]["base"] == "template" and "ui/contributions.json" in item["codeDiff"]["diff"]
    staged = client.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert staged["state"] == "AWAITING_APPROVAL", staged
    done = client.post("/api/v1/workspaces/ws-a/plugins/approve", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert done.get("state") == "ACTIVATED", done

    # A new version diffs against the previous generated one.
    build(client, package("0.2.0", **{"README.md": "# Counter v2\n"}))
    plan2 = client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN, "version": "0.2.0"}, headers=ws("ws-a")).json()
    diff = plan2["plan"]["install"][0]["codeDiff"]
    assert diff["base"] == f"{GEN}@0.1.0" and diff["changed"] == ["README.md", "plugin.yaml"]


def test_generated_plugins_stay_in_their_workspace(client):
    build(client, package(), workspace="ws-a")
    assert client.get("/api/v1/plugins", params={"q": "counter"}, headers=ws("ws-b")).json()["plugins"] == []
    assert client.get(f"/api/v1/plugins/{GEN}", headers=ws("ws-b")).status_code == 404
    plan = client.post("/api/v1/workspaces/ws-b/plugins/plan", json={"pluginId": GEN}, headers=ws("ws-b")).json()
    assert plan["state"] == "REJECTED"
    # ws-b can't publish over ws-a's id either.
    assert any("another workspace" in e for e in build(client, package("0.3.0"), workspace="ws-b", dryRun="true").json()["errors"])


def test_tampered_store_or_signature_is_rejected_at_stage(client, tmp_path):
    build(client, package())
    idx = tmp_path / "data" / "registry-generated.json"
    entry = json.loads(idx.read_text())["plugins"][0]
    (tmp_path / "data" / "plugin-artifacts" / GEN / "0.1.0" / "package" / "README.md").write_text("# evil\n")
    plan = client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=ws("ws-a")).json()
    staged = client.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert staged["state"] == "REJECTED" and "digest mismatch" in str(staged["checks"])

    # Restore the bytes but forge the digest + signature pair: the signature no longer covers it.
    (tmp_path / "data" / "plugin-artifacts" / GEN / "0.1.0" / "package" / "README.md").write_text("# Counter\n")
    doc = json.loads(idx.read_text())
    doc["plugins"][0]["signature"] = {**entry["signature"], "sig": entry["signature"]["sig"][::-1]}
    idx.write_text(json.dumps(doc))
    plan = client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=ws("ws-a")).json()
    staged = client.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert staged["state"] == "REJECTED" and "signature" in str(staged["checks"])


def test_agent_scopes_never_include_approval(client):
    builder = token(client, "ws-a", ["plugins.read", "plugins.manage", "plugins.author"])
    # Agents only dry-run here; what gets registered is the worker's rebuild (todo10 Phase 7).
    assert build(client, package(), headers=builder).status_code == 403
    assert build(client, package(), headers=builder, dryRun="true").json()["ok"]
    assert build(client, package()).json()["registered"]
    plan = client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=builder).json()
    assert client.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=builder).json()["state"] == "AWAITING_APPROVAL"
    assert client.post("/api/v1/workspaces/ws-a/plugins/approve", json={"requestId": plan["requestId"]}, headers=builder).status_code == 403
    assert client.post("/api/v1/workspaces/ws-a/plugins/activate", json={"requestId": plan["requestId"]}, headers=builder).status_code == 409  # high risk
    task = token(client, "ws-a", ["assets.read", "annotations.read", "commands.invoke"], agent="task")
    assert client.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": GEN}, headers=task).status_code == 403
    assert client.get("/api/v1/plugins", headers=task).status_code == 403
    assert client.post("/api/v1/plugins/artifacts", content=tarball(package("0.9.0")), headers=task).status_code == 403


def test_workspace_capabilities_and_lazy_docs(registry_client, tmp_path):
    c = registry_client()
    from .test_installer_flow import install

    assert c.get("/api/v1/workspaces/ws-a/capabilities", headers=ws("ws-a")).json()["capabilities"] == []
    install(c, "ws-a", "test.seg")
    (tmp_path / "repo" / "plugins" / "seg11" / "skills" / "segmentation").mkdir(parents=True)
    (tmp_path / "repo" / "plugins" / "seg11" / "skills" / "segmentation" / "SKILL.md").write_text("Use segment_objects for masks.")
    caps = c.get("/api/v1/workspaces/ws-a/capabilities", headers=ws("ws-a")).json()["capabilities"]
    assert {(r["capability"], r["pluginId"]) for r in caps} == {("image.segment", "test.seg"), ("image.view", "test.viewer")}
    d = c.get("/api/v1/plugins/test.seg/docs", headers=ws("ws-a")).json()
    assert d["skills"] == [{"name": "segmentation", "content": "Use segment_objects for masks."}]
