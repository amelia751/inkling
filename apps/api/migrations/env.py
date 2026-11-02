"""Alembic environment: the URL comes from the kernel settings (<envPrefix>API_DATABASE_URL)."""

from alembic import context

from studio_api import models  # noqa: F401 — registers every table on Base.metadata
from studio_api.config import settings
from studio_api.db import Base, engine, normalize_url

target_metadata = Base.metadata


def run() -> None:
    if context.is_offline_mode():
        context.configure(url=normalize_url(settings().database_url), target_metadata=target_metadata, literal_binds=True, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    given = context.config.attributes.get("connection")  # studio_api.devdb passes its own
    if given is not None:
        context.configure(connection=given, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    with engine().connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


run()
