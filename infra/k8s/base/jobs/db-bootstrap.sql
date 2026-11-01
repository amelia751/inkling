-- Database roles, run once per instance by the db-bootstrap Job (todo12 A5), as the instance
-- admin (Cloud SQL: `postgres`). Idempotent: re-running resets the passwords (rotation) and
-- changes nothing else. Passwords come in as psql variables from db-bootstrap-secrets, so
-- they're never in this file, a manifest or Terraform state.
--
-- CONNECTION LIMIT is each service's connection budget on the shared instance (todo12 E7): the
-- pipeline gets at most 20 across `studio` (schema `pipeline`) and `pipeline_engine`.
-- versioning's roles come from its own `migrate bootstrap` (apps/versioning/README.md).
\set ON_ERROR_STOP on
SET client_min_messages = warning;

SELECT 'CREATE ROLE api_app LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_app') \gexec
ALTER ROLE api_app LOGIN PASSWORD :'api_pw' CONNECTION LIMIT 60;
GRANT ALL ON DATABASE studio TO api_app;

SELECT 'CREATE ROLE pipeline_app LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pipeline_app') \gexec
ALTER ROLE pipeline_app LOGIN PASSWORD :'pipeline_pw' CONNECTION LIMIT 20;
-- Cloud SQL's admin isn't a superuser: it must be a member before it can hand ownership over.
GRANT pipeline_app TO CURRENT_USER;
GRANT CONNECT ON DATABASE studio TO pipeline_app;
ALTER DATABASE pipeline_engine OWNER TO pipeline_app;
REVOKE ALL ON DATABASE pipeline_engine FROM PUBLIC;
-- Only in `studio`: in pipeline_engine DBOS uses its own schema.
ALTER ROLE pipeline_app IN DATABASE studio SET search_path = pipeline;

\c studio
SET client_min_messages = warning;
-- PostgreSQL 15+ no longer lets every role create in `public`; the api's Alembic tables live there.
GRANT USAGE, CREATE ON SCHEMA public TO api_app;
CREATE SCHEMA IF NOT EXISTS pipeline AUTHORIZATION pipeline_app;
