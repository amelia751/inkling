"""todo20 D7: clean up existing projects once.

Per project, the per-kind Studios one drop booted before todo19 (`boot_id` `drop-<drop>-col-…`,
one per collection of the drop's dataset) that have **no annotations** are combined: the oldest
becomes "Studio", accepting the union of their kinds (`collection_id` cleared, its environment
`extends` every preset they used, as a new revision); the others go to Trash. Image-only Studios
made from a `dataset` proposal (no boot) with no annotations go to Trash too, with their dataset
when it has no other Studio. One Trash batch per project (`fs_batches`, kind `trash`, resource
`studio`), so a person restores everything from Trash. Studios with annotations are left alone.
The project's default Studio is the combined Studio of its latest drop unless one is set.

Revision ID: 0031
Revises: 0030
Create Date: 2026-11-02 23:10:00.000000
"""

import json
import re
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = '0031'
down_revision = '0030'
branch_labels = None
depends_on = None

WHO = 'system:migration-0031'
PER_KIND = re.compile(r'^drop-(.+)-(col-[A-Za-z0-9_-]+)$')


def _json(v):
    if isinstance(v, (dict, list)) or v is None:
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return None


def _extends(env) -> list[str]:
    ext = (env or {}).get('extends') if isinstance(env, dict) else None
    return [ext] if isinstance(ext, str) else [x for x in ext or [] if isinstance(x, str)]


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if not {'tasks', 'projects', 'fs_batches'} <= tables:
        return
    from studio_api.kernel.canonical import NULL_CONTENT_HASH, content_hash

    at = datetime.now(UTC)
    annotated = set()
    if 'annotation_documents' in tables:
        for r in bind.execute(sa.text("SELECT workspace_id, task_id, annotations FROM annotation_documents")):
            if _json(r.annotations):
                annotated.add((r.workspace_id, r.task_id))
    kinds = {r.id: r.kind for r in bind.execute(sa.text("SELECT id, kind FROM dataset_collections"))} if 'dataset_collections' in tables else {}
    from_proposal = {r.id for r in bind.execute(sa.text("SELECT id FROM datasets WHERE created_from_proposal_id IS NOT NULL AND trashed_at IS NULL"))}
    tasks = bind.execute(sa.text("SELECT id, project_id, dataset_id, title, boot_id, collection_id, accepts, created_at FROM tasks WHERE trashed_at IS NULL ORDER BY created_at, id")).fetchall()
    projects = {r.id: r for r in bind.execute(sa.text("SELECT id, default_task_id FROM projects WHERE trashed_at IS NULL AND (seed IS NULL OR seed = :f) AND sample_of IS NULL"), {"f": False})}

    by_project: dict[str, list] = {}
    for t in tasks:
        if t.project_id in projects:
            by_project.setdefault(t.project_id, []).append(t)

    for pid, rows in by_project.items():
        trash_tasks: list[str] = []
        groups: dict[tuple[str, str], list] = {}
        for t in rows:
            m = PER_KIND.match(t.boot_id or '')
            if m and t.collection_id and (pid, t.id) not in annotated:
                groups.setdefault((m.group(1), t.dataset_id), []).append(t)
        combined: list[str] = []
        for group in groups.values():
            keep, rest = group[0], group[1:]
            accepts: list[str] = []
            for t in group:
                for k in [*(_json(t.accepts) or []), kinds.get(t.collection_id)]:
                    if k and k not in accepts:
                        accepts.append(k)
            presets: list[str] = []
            envs = {}
            for t in group:
                e = bind.execute(sa.text("SELECT revision, environment FROM workspace_environments WHERE workspace_id = :p AND task_id = :t"), {"p": pid, "t": t.id}).fetchone()
                envs[t.id] = e
                for x in _extends(_json(e.environment) if e is not None else None):
                    if x not in presets:
                        presets.append(x)
            bind.execute(sa.text("UPDATE tasks SET title = 'Studio', accepts = :a, collection_id = NULL WHERE id = :t"), {"a": json.dumps(accepts) if accepts else None, "t": keep.id})
            e = envs.get(keep.id)
            if e is not None and len(presets) > len(_extends(_json(e.environment))):
                env = dict(_json(e.environment) or {})
                env['extends'] = presets[0] if len(presets) == 1 else presets
                rev = (e.revision or 0) + 1
                parent = content_hash(_json(e.environment)) if e.environment is not None else NULL_CONTENT_HASH
                bind.execute(sa.text("UPDATE workspace_environments SET revision = :r, environment = :e, author = :w, saved_at = :at WHERE workspace_id = :p AND task_id = :t"), {"r": rev, "e": json.dumps(env), "w": WHO, "at": at, "p": pid, "t": keep.id})
                bind.execute(
                    sa.text("INSERT INTO workspace_environment_history (workspace_id, task_id, revision, environment, author, saved_at, content_hash, parent_hash, author_kind) VALUES (:p, :t, :r, :e, :w, :at, :h, :ph, 'person')"),
                    {"p": pid, "t": keep.id, "r": rev, "e": json.dumps(env), "w": WHO, "at": at, "h": content_hash(env), "ph": parent},
                )
            combined.append(keep.id)
            trash_tasks += [t.id for t in rest]
        # Image-only Studios a dataset proposal made ("Annotate"), never annotated.
        trash_datasets: list[str] = []
        for t in rows:
            if t.boot_id is None and t.dataset_id in from_proposal and (pid, t.id) not in annotated and t.id not in trash_tasks:
                trash_tasks.append(t.id)
        for dsid in {t.dataset_id for t in rows if t.id in trash_tasks and t.dataset_id in from_proposal}:
            if all(t.id in trash_tasks for t in rows if t.dataset_id == dsid):
                trash_datasets.append(dsid)
        default = projects[pid].default_task_id
        if default in trash_tasks or default is None or not any(t.id == default for t in rows):
            default = combined[-1] if combined else None
            if default is None:
                left = [t.id for t in rows if t.id not in trash_tasks]
                default = left[-1] if left else None
            bind.execute(sa.text("UPDATE projects SET default_task_id = :t WHERE id = :p"), {"t": default, "p": pid})
        if not trash_tasks:
            continue
        batch = 'bat-' + uuid.uuid4().hex
        n = len(trash_tasks)
        bind.execute(
            sa.text("INSERT INTO fs_batches (id, project_id, actor, kind, label, summary, undoable, seq, resource, at) VALUES (:id, :p, :w, 'trash', :l, :s, :u, 0, 'studio', :at)"),
            {"id": batch, "p": pid, "w": WHO, "l": f"{n} unused Studio{'' if n == 1 else 's'}", "s": f"Combined into the project's Studio: moved {n} unused Studio{'' if n == 1 else 's'} to Trash", "u": False, "at": at},
        )
        params = {"at": at, "w": WHO, "b": batch}
        for tid in trash_tasks:
            bind.execute(sa.text("UPDATE tasks SET trashed_at = :at, trashed_by = :w, trash_batch_id = :b WHERE id = :t"), {**params, "t": tid})
        for dsid in trash_datasets:
            bind.execute(sa.text("UPDATE datasets SET trashed_at = :at, trashed_by = :w, trash_batch_id = :b WHERE id = :d"), {**params, "d": dsid})
            bind.execute(sa.text("UPDATE dataset_collections SET trashed_at = :at, trashed_by = :w, trash_batch_id = :b WHERE dataset_id = :d AND trashed_at IS NULL"), {**params, "d": dsid})


def downgrade() -> None:
    # Reversible through Trash (restore the batch); the combined Studio keeps its wider accepts.
    pass
