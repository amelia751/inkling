"""0027: plugin ids stored under a legacy namespace move to the current one; a row already under
the new id wins over its legacy duplicate."""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import command

from studio_api import db
from studio_api.naming import naming, ns

from .test_migrations import _alembic_at

T = "2026-11-02 10:00:00"


def test_0027_moves_legacy_plugin_ids_and_keeps_existing_rows(tmp_path, monkeypatch):
    cfg = _alembic_at(tmp_path, "0026")
    f = tmp_path / "naming.json"
    f.write_text(json.dumps({**naming(), "legacyNamespaces": ["acme"]}))
    monkeypatch.setenv("NAMING_FILE", str(f))
    naming.cache_clear()
    try:
        with db.engine().begin() as c:
            for w in ("w1", "w2"):
                c.execute(sa.text("INSERT INTO workspaces (id, name, created_at) VALUES (:w, :w, :t)"), {"w": w, "t": T})
            for pid in ("acme.wsi", "acme.cine", ns("cine")):
                c.execute(sa.text("INSERT INTO plugin_packages (id, publisher, license, trust_tier) VALUES (:p, 'first-party', 'MIT', 'first-party')"), {"p": pid})
                c.execute(sa.text("INSERT INTO plugin_versions (plugin_id, version, artifact_digest, manifest, created_at) VALUES (:p, '1.0.0', :d, '{}', :t)"), {"p": pid, "d": f"sha256:{pid}", "t": T})
            for w, pid, state in (("w1", "acme.wsi", "ACTIVATED"), ("w1", "acme.cine", "DISABLED"), ("w1", ns("cine"), "ACTIVATED"), ("w2", "acme.wsi", "ACTIVATED")):
                c.execute(sa.text("INSERT INTO workspace_plugins (workspace_id, plugin_id, version, config_revision, state, updated_at) VALUES (:w, :p, '1.0.0', 0, :s, :t)"), {"w": w, "p": pid, "s": state, "t": T})

        command.upgrade(cfg, "0027")
        with db.engine().begin() as c:
            assert sorted(r[0] for r in c.execute(sa.text("SELECT id FROM plugin_packages"))) == sorted([ns("cine"), ns("wsi")])
            versions = dict(c.execute(sa.text("SELECT plugin_id, artifact_digest FROM plugin_versions")).fetchall())
            assert versions == {ns("cine"): f"sha256:{ns('cine')}", ns("wsi"): "sha256:acme.wsi"}
            installs = sorted(c.execute(sa.text("SELECT workspace_id, plugin_id, state FROM workspace_plugins")).fetchall())
            assert installs == [("w1", ns("cine"), "ACTIVATED"), ("w1", ns("wsi"), "ACTIVATED"), ("w2", ns("wsi"), "ACTIVATED")]
    finally:
        monkeypatch.delenv("NAMING_FILE")
        naming.cache_clear()
        command.upgrade(cfg, "head")
        db.reset_engine()
