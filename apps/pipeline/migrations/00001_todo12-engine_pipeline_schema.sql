-- +goose Up
-- The pipeline's own schema in database studio (todo12 E7). Tables arrive with the pipeline
-- workstream's migrations; in production the schema is created by the db-bootstrap Job
-- (owned by pipeline_app), so this is a no-op there.
-- Postgres checks CREATE on the database before IF NOT EXISTS, and pipeline_app has none where
-- db-bootstrap made the schema for it: create it only when it's really missing.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pipeline') THEN
        CREATE SCHEMA pipeline;
    END IF;
END
$$;
-- +goose StatementEnd

-- +goose Down
SELECT 1;
