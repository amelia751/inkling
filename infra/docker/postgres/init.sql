-- Dev/compose only: one Postgres, one database per owner. apps/api uses `studio` (public
-- schema), apps/versioning owns the `versioning` schema in `studio` (created by
-- `migrate bootstrap`), apps/agent uses its own database.
CREATE DATABASE agent;

-- apps/pipeline (todo12 E7): role pipeline_app owns schema `pipeline` in `studio` (its tables)
-- and the database `pipeline_engine` (DBOS state). CONNECTION LIMIT is the pipeline's
-- connection budget (≤ 20% of max_connections). Production runs the same statements through
-- the db-bootstrap Job (todo12 A5). This file runs on a fresh volume only: on an existing one,
-- run this block by hand (`docker compose exec postgres psql -U studio -d studio`).
CREATE ROLE pipeline_app LOGIN PASSWORD 'dev-only-pipeline-pw' CONNECTION LIMIT 20;
CREATE DATABASE pipeline_engine OWNER pipeline_app;
CREATE SCHEMA IF NOT EXISTS pipeline AUTHORIZATION pipeline_app;
GRANT CONNECT ON DATABASE studio TO pipeline_app;
ALTER ROLE pipeline_app SET search_path = pipeline;
