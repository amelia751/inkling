"""Namespace rename as a data migration (todo2 D3): the kernel's counterpart of
tools/rename-namespace.mjs. Rewrites every stored id under `<old>.` to `<new>.`.

Use from an Alembic revision after changing the naming config:

    from studio_api.plugins.rename import rename_namespace
    def upgrade(): rename_namespace(op.get_bind(), "old", "new")
    def downgrade(): rename_namespace(op.get_bind(), "new", "old")
"""

from __future__ import annotations

import json
import re

from sqlalchemy import text
from sqlalchemy.engine import Connection

# (table, key columns, id columns, JSON columns)
TABLES = [
    ("annotation_documents", ["workspace_id", "task_id"], [], ["annotations"]),
    ("workspace_environments", ["workspace_id", "task_id"], [], ["environment"]),
    ("plugin_packages", ["id"], ["id"], []),
    ("plugin_versions", ["plugin_id", "version"], ["plugin_id"], ["manifest"]),
    ("plugin_capabilities", ["plugin_id", "version", "capability_id"], ["plugin_id"], []),
    ("workspace_plugins", ["workspace_id", "plugin_id"], ["plugin_id"], []),
    ("workspace_plugin_history", ["id"], ["plugin_id"], []),
    ("workspace_plugin_grants", ["workspace_id", "plugin_id", "version", "permission"], ["plugin_id"], []),
    ("workspace_plugin_configs", ["workspace_id", "plugin_id", "config_revision"], ["plugin_id"], []),
    ("plugin_install_requests", ["id"], ["plugin_id"], ["plan"]),
    ("plugin_jobs", ["job_id"], ["plugin_id"], []),
]


def rename_namespace(conn: Connection, old: str, new: str) -> int:
    pattern = re.compile(rf"(^|[^\w.-]){re.escape(old)}\.(?=[\w-])")

    def fix_text(s: str) -> str:
        return pattern.sub(rf"\g<1>{new}.", s)

    def walk(v):
        if isinstance(v, str):
            return fix_text(v)
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {fix_text(k): walk(x) for k, x in v.items()}
        return v

    changed = 0
    for table, keys, id_cols, json_cols in TABLES:
        cols = list(dict.fromkeys(keys + id_cols + json_cols))
        for row in conn.execute(text(f"SELECT {', '.join(cols)} FROM {table}")).mappings().all():
            updates = {}
            for c in id_cols:
                if isinstance(row[c], str) and fix_text(row[c]) != row[c]:
                    updates[c] = fix_text(row[c])
            for c in json_cols:
                raw = row[c]
                val = json.loads(raw) if isinstance(raw, str) else raw
                new_val = walk(val)
                if new_val != val:
                    updates[c] = json.dumps(new_val)
            if updates:
                sets = ", ".join(f"{c} = :new_{c}" for c in updates)
                where = " AND ".join(f"{k} = :key_{k}" for k in keys)
                conn.execute(text(f"UPDATE {table} SET {sets} WHERE {where}"), {**{f"new_{c}": v for c, v in updates.items()}, **{f"key_{k}": row[k] for k in keys}})
                changed += 1
    return changed
