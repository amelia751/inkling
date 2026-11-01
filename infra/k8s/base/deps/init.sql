-- One database per owner: apps/api, apps/versioning and apps/pipeline (their own schemas) use
-- `studio`, apps/agent uses `agent`, the pipeline's engine (DBOS) uses `pipeline_engine`. Roles
-- come from the versioning-migrate init container and the db-bootstrap Job (overlays/dev).
CREATE DATABASE agent;
CREATE DATABASE pipeline_engine;
