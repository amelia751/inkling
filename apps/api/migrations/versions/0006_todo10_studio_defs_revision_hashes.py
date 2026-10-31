"""todo10 Phase 1: content and parent hashes and provenance on environment revisions

Every `workspace_environment_history` row gets the RFC 8785 `content_hash` of its environment,
the `parent_hash` of the revision it replaced (a task's first revision: its base, or the hash
of `null` when backfilled), the author kind (`person` | `agent`), and for agent changes the
run id and prompt hash. Existing rows are backfilled in revision order.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-31 19:00:00.000000
"""

import hashlib
import json
import math
from decimal import Decimal

import sqlalchemy as sa
from alembic import op

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None

NULL_HASH = "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"


# A copy of studio_api.kernel.canonical (migrations don't import app code).
def _num(v: float) -> str:
    if not math.isfinite(v):
        raise ValueError(v)
    if v == 0:
        return "0"
    sign, digits, exp = Decimal(repr(v)).as_tuple()
    ds = "".join(map(str, digits)).rstrip("0") or "0"
    n, k = len(digits) + exp, len(ds)
    if k <= n <= 21:
        out = ds + "0" * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + ds
    else:
        out = ds[0] + ("." + ds[1:] if k > 1 else "") + "e" + ("+" if n - 1 >= 0 else "-") + str(abs(n - 1))
    return ("-" if sign else "") + out


def _canon(v) -> str:
    if v is None or isinstance(v, bool):
        return {None: "null", True: "true", False: "false"}[v]
    if isinstance(v, int):
        return str(v) if abs(v) <= 2**53 else _num(float(v))
    if isinstance(v, float):
        return _num(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(_canon(x) for x in v) + "]"
    keys = sorted(v, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _canon(v[k]) for k in keys) + "}"


def _hash(v) -> str:
    return "sha256:" + hashlib.sha256(_canon(v).encode()).hexdigest()


def upgrade() -> None:
    with op.batch_alter_table('workspace_environment_history', schema=None) as batch_op:
        batch_op.add_column(sa.Column('content_hash', sa.String(length=71), nullable=True))
        batch_op.add_column(sa.Column('parent_hash', sa.String(length=71), nullable=True))
        batch_op.add_column(sa.Column('author_kind', sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column('agent_run_id', sa.String(length=128), nullable=True))
        batch_op.add_column(sa.Column('prompt_hash', sa.String(length=71), nullable=True))

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, workspace_id, task_id, environment, author FROM workspace_environment_history ORDER BY workspace_id, task_id, revision")).all()
    last: dict[tuple[str, str], str] = {}
    for r in rows:
        env = r.environment
        if isinstance(env, str):
            env = json.loads(env)
        h = _hash(env)
        kind = "agent" if str(r.author or "").startswith("agent:") else "person"
        conn.execute(sa.text("UPDATE workspace_environment_history SET content_hash = :h, parent_hash = :p, author_kind = :k WHERE id = :id"), {"h": h, "p": last.get((r.workspace_id, r.task_id), NULL_HASH), "k": kind, "id": r.id})
        last[(r.workspace_id, r.task_id)] = h

    with op.batch_alter_table('workspace_environment_history', schema=None) as batch_op:
        batch_op.alter_column('content_hash', existing_type=sa.String(length=71), nullable=False)
        batch_op.alter_column('parent_hash', existing_type=sa.String(length=71), nullable=False)
        batch_op.alter_column('author_kind', existing_type=sa.String(length=16), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table('workspace_environment_history', schema=None) as batch_op:
        for c in ('prompt_hash', 'agent_run_id', 'author_kind', 'parent_hash', 'content_hash'):
            batch_op.drop_column(c)
