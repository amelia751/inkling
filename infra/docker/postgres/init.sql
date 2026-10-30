-- Dev/compose only: one Postgres, one database per owner. apps/api uses `studio` (public
-- schema), apps/versioning owns the `versioning` schema in `studio` (created by
-- `migrate bootstrap`), apps/agent uses its own database.
CREATE DATABASE agent;
