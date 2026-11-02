"""todo20 D4: a project's default Studio (`projects.default_task_id`), backfilled with the last
live Studio a drop booted; todo20 D3: `dataset` proposals still `proposed` are dismissed
(`evidence.dismissedReason = "superseded"`): drops are the one way files become a Studio.

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-02 23:00:00.000000
"""

import json

import sqlalchemy as sa
from alembic import op

revision = '0030'
down_revision = '0029'
branch_labels = None
depends_on = None

WHO = 'system:migration-0030'


def _json(v):
    if isinstance(v, (dict, list)) or v is None:
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return None


def upgrade() -> None:
    op.add_column('projects', sa.Column('default_task_id', sa.String(128), nullable=True))
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())

    if 'drop_plans' in tables and 'tasks' in tables:
        live = {r.id: r.project_id for r in bind.execute(sa.text("SELECT id, project_id FROM tasks WHERE trashed_at IS NULL"))}
        chosen: dict[str, str] = {}
        rows = bind.execute(sa.text("SELECT project_id, applied FROM drop_plans WHERE state = 'applied' ORDER BY applied_at, drop_id")).fetchall()
        for r in rows:
            a = _json(r.applied) or {}
            for tid in (a.get('taskIds') or a.get('tasks') or []) if isinstance(a, dict) else []:
                if live.get(tid) == r.project_id:
                    chosen[r.project_id] = tid  # the latest drop wins
                    break
        for pid, tid in chosen.items():
            bind.execute(sa.text("UPDATE projects SET default_task_id = :t WHERE id = :p AND default_task_id IS NULL"), {"t": tid, "p": pid})

    if 'proposals' in tables:
        for r in bind.execute(sa.text("SELECT id, evidence FROM proposals WHERE kind = 'dataset' AND status = 'proposed'")).fetchall():
            ev = _json(r.evidence)
            ev = ev if isinstance(ev, dict) else {}
            ev['dismissedReason'] = 'superseded'
            bind.execute(sa.text("UPDATE proposals SET status = 'dismissed', decided_by = :w, decided_at = CURRENT_TIMESTAMP, evidence = :e WHERE id = :i"), {"w": WHO, "e": json.dumps(ev), "i": r.id})


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("UPDATE proposals SET status = 'proposed', decided_by = NULL, decided_at = NULL WHERE kind = 'dataset' AND decided_by = :w"), {"w": WHO})
    op.drop_column('projects', 'default_task_id')
