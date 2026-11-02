"""todo16 D1: the project's drive is called "Sources" everywhere, so existing drive roots named
"Files" are renamed to "Sources" (new roots get `tree.ROOT_NAME`). Only the drive root itself
(no parent, no import source, a folder) changes; a folder someone named "Files" stays.
`downgrade` renames them back.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-02 10:00:00.000000
"""

from alembic import op

revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None


def _rename(old: str, new: str) -> None:
    op.execute(
        f"UPDATE source_nodes SET name = '{new}' "
        f"WHERE name = '{old}' AND parent_id IS NULL AND source_id IS NULL AND is_dir"
    )


def upgrade() -> None:
    _rename('Files', 'Sources')


def downgrade() -> None:
    _rename('Sources', 'Files')
