-- +goose Up
-- The pipeline's own schema in database studio (todo12 E7). Tables arrive with the pipeline
-- workstream's migrations; in production the schema is created by the db-bootstrap Job
-- (owned by pipeline_app), so this is a no-op there.
CREATE SCHEMA IF NOT EXISTS pipeline;

-- +goose Down
SELECT 1;
