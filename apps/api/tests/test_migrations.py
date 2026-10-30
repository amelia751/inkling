"""Alembic history stays linear (the api-migrate Job runs `alembic upgrade head`).

Two branches that each add a revision with the same down_revision merge without a git
conflict and only fail at deploy time ("Multiple head revisions"); this catches it in CI.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

API = Path(__file__).resolve().parents[1]


def test_one_head_and_unique_revisions():
    script = ScriptDirectory.from_config(Config(str(API / "alembic.ini")))
    assert len(script.get_heads()) == 1, f"multiple Alembic heads: {script.get_heads()}; renumber the newer revision"
    revisions = list(script.walk_revisions())
    assert len({r.revision for r in revisions}) == len(revisions)
