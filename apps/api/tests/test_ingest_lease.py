"""todo18 §2 E: on SQLite two workers can't take the same task item (conditional update lease)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from studio_api import config, db
from studio_api.kernel import ingest
from studio_api.models import TaskItem, now


def test_a_stale_reader_cannot_lease_an_item_another_worker_took(tmp_path):
    config.set_settings(config.load_settings(database_url=f"sqlite:///{tmp_path}/api.db", seed_root=tmp_path / "s", data_dir=tmp_path / "d", secret_key="k", create_tables=True))
    db.reset_engine()
    db.create_all()
    with db.session_scope() as s:
        s.add(TaskItem(task_id="t", project_id="p", session_id="x", client_file_id="c", item_id="i", node_id="n", name="a.png", rel_path="a.png", kind="image", size=1, sha256="0" * 64, state="uploaded", meta={}, priority=0, attempts=0))
    a, b = Session(db.engine(), expire_on_commit=False), Session(db.engine(), expire_on_commit=False)
    stale = a.query(TaskItem).one()  # worker A read the row, unleased
    a.commit()
    assert len(ingest.claim(b)) == 1  # worker B takes it
    b.commit()
    assert ingest._take(a, stale, now()) is False  # A's lease write finds it already taken
    a.commit()
    with db.session_scope() as s:
        assert s.query(TaskItem).one().attempts == 1
    a.close()
    b.close()
