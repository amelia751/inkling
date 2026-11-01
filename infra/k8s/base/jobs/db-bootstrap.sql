-- Database roles, run once per instance by the db-bootstrap Job (todo12 A5), as the instance
-- admin (Cloud SQL: `postgres`). Idempotent: re-running resets the passwords (rotation) and
-- changes nothing else. Passwords come in as psql variables from db-bootstrap-secrets, so
-- they're never in this file, a manifest or Terraform state.
--
-- CONNECTION LIMIT is each service's connection budget on the shared instance (todo12 E7): the
-- pipeline gets at most 20 across `studio` (schema `pipeline`) and `pipeline_engine`.
-- versioning's roles are here too (its `migrate bootstrap` is for local superuser databases).
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

-- versioning: the same roles and schema as its `migrate bootstrap`, which can't run against Cloud
-- SQL as is (the admin must be a member of versioning_owner to create a schema it owns).
SELECT 'CREATE ROLE versioning_owner LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'versioning_owner') \gexec
ALTER ROLE versioning_owner LOGIN PASSWORD :'versioning_owner_pw';
SELECT 'CREATE ROLE versioning_app LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'versioning_app') \gexec
ALTER ROLE versioning_app LOGIN NOBYPASSRLS PASSWORD :'versioning_app_pw';
GRANT versioning_owner TO CURRENT_USER;
GRANT CONNECT, CREATE ON DATABASE studio TO versioning_owner;
GRANT CONNECT ON DATABASE studio TO versioning_app;
ALTER ROLE versioning_owner SET search_path = versioning;
ALTER ROLE versioning_app SET search_path = versioning;

\c studio
SET client_min_messages = warning;
-- PostgreSQL 15+ no longer lets every role create in `public`; the api's Alembic tables live there.
GRANT USAGE, CREATE ON SCHEMA public TO api_app;
CREATE SCHEMA IF NOT EXISTS pipeline AUTHORIZATION pipeline_app;
CREATE SCHEMA IF NOT EXISTS versioning AUTHORIZATION versioning_owner;
GRANT USAGE ON SCHEMA versioning TO versioning_app;
