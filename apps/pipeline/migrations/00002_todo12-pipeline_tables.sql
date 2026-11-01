-- The pipeline schema (docs/pipeline.md §16; todo/todo12.md §4 Milestone 1 item 3).
-- Definitions, immutable revisions, runs, logical steps and their attempts, staged artifacts,
-- lineage, and the outbox/inbox pair. References to other services (workspaces, projects,
-- kernel jobs, versioning repos and commits) are logical ids, never cross-schema foreign keys,
-- and no versioning-owned head is stored as an authority: `candidate` and `publish` are read
-- models. Every row carries workspace_id.
--
-- In Cloud SQL the schema already exists, owned by pipeline_app (todo12 A5); locally the
-- migration creates it.

-- +goose Up
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

CREATE TABLE pipeline.pipeline_definitions (
    workspace_id     text        NOT NULL,
    pipeline_id      text        NOT NULL,
    name             text        NOT NULL,
    current_revision text,
    created_by       text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    archived_at      timestamptz,
    PRIMARY KEY (workspace_id, pipeline_id)
);

-- (workspace_id, pipeline_id, revision) unique; revisions are immutable (trigger below).
CREATE TABLE pipeline.pipeline_revisions (
    workspace_id text        NOT NULL,
    pipeline_id  text        NOT NULL,
    revision     text        NOT NULL CHECK (revision ~ '^sha256:[0-9a-f]{64}$'),
    graph        jsonb       NOT NULL,
    plan         jsonb       NOT NULL,
    plan_digest  text        NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_by   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, pipeline_id, revision),
    FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipeline.pipeline_definitions (workspace_id, pipeline_id)
);

-- +goose StatementBegin
CREATE FUNCTION pipeline.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$;
-- +goose StatementEnd

CREATE TRIGGER pipeline_revisions_immutable BEFORE UPDATE OR DELETE ON pipeline.pipeline_revisions
    FOR EACH ROW EXECUTE FUNCTION pipeline.reject_mutation();

CREATE TABLE pipeline.pipeline_runs (
    run_id              text        PRIMARY KEY,
    workspace_id        text        NOT NULL,
    project_id          text        NOT NULL,
    pipeline_id         text        NOT NULL,
    revision            text        NOT NULL,
    plan_digest         text        NOT NULL,
    state               text        NOT NULL CHECK (state IN ('queued', 'running', 'awaiting_review', 'publishing',
                                                               'published', 'rejected', 'failed', 'cancelled')),
    trigger_type        text        NOT NULL,
    source_event_id     text,
    idempotency_key     text        NOT NULL,
    envelope            jsonb       NOT NULL,
    target_repo_id      text        NOT NULL,
    target_branch       text        NOT NULL,
    candidate           jsonb,
    publish             jsonb,
    error               jsonb,
    application_version text        NOT NULL,
    actor               text        NOT NULL,
    correlation_id      text,
    version             integer     NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deadline_at         timestamptz NOT NULL,
    finished_at         timestamptz,
    UNIQUE (workspace_id, idempotency_key),
    FOREIGN KEY (workspace_id, pipeline_id, revision)
        REFERENCES pipeline.pipeline_revisions (workspace_id, pipeline_id, revision)
);
CREATE INDEX pipeline_runs_project ON pipeline.pipeline_runs (workspace_id, project_id, created_at DESC);
CREATE INDEX pipeline_runs_active ON pipeline.pipeline_runs (state, deadline_at)
    WHERE state IN ('queued', 'running', 'publishing');

-- (run_id, step_id, partition_id) is the logical step; attempts are subordinate.
CREATE TABLE pipeline.step_executions (
    step_execution_id text        PRIMARY KEY,
    run_id            text        NOT NULL REFERENCES pipeline.pipeline_runs (run_id),
    workspace_id      text        NOT NULL,
    step_id           text        NOT NULL,
    partition_id      text        NOT NULL,
    state             text        NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    attempts          integer     NOT NULL DEFAULT 0,
    job_id            text,
    outputs           jsonb,
    items_in          integer,
    items_out          integer,
    items_quarantined integer,
    error             jsonb,
    started_at        timestamptz,
    finished_at       timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, step_id, partition_id)
);

CREATE TABLE pipeline.step_attempts (
    attempt_id        text        PRIMARY KEY,
    step_execution_id text        NOT NULL REFERENCES pipeline.step_executions (step_execution_id),
    workspace_id      text        NOT NULL,
    attempt           integer     NOT NULL CHECK (attempt >= 1),
    job_id            text,
    state             text        NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
    result_ref        text,
    error             jsonb,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    UNIQUE (step_execution_id, attempt)
);

-- Staged outputs, keyed by their attempt-unique blob key.
CREATE TABLE pipeline.run_artifacts (
    blob_key     text        PRIMARY KEY,
    workspace_id text        NOT NULL,
    run_id       text        NOT NULL REFERENCES pipeline.pipeline_runs (run_id),
    step_id      text        NOT NULL,
    partition_id text        NOT NULL,
    attempt      integer     NOT NULL CHECK (attempt >= 1),
    name         text        NOT NULL,
    role         text        NOT NULL CHECK (role IN ('output', 'manifest', 'report', 'quarantine')),
    digest       text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    size_bytes   bigint      NOT NULL CHECK (size_bytes >= 0),
    media_type   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_artifacts_run ON pipeline.run_artifacts (run_id, step_id);
CREATE INDEX run_artifacts_digest ON pipeline.run_artifacts (workspace_id, digest);

-- Lineage (§8): input commit/artifact/session → step → output artifact → candidate commit.
CREATE TABLE pipeline.lineage_edges (
    workspace_id text        NOT NULL,
    run_id       text        NOT NULL REFERENCES pipeline.pipeline_runs (run_id),
    step_id      text        NOT NULL DEFAULT '',
    from_kind    text        NOT NULL CHECK (from_kind IN ('upload_session', 'dataset_commit', 'artifact', 'candidate_commit', 'approval', 'step')),
    from_ref     text        NOT NULL,
    to_kind      text        NOT NULL CHECK (to_kind IN ('artifact', 'candidate_commit', 'merge_commit', 'step')),
    to_ref       text        NOT NULL,
    attributes   jsonb       NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, step_id, from_kind, from_ref, to_kind, to_ref)
);
CREATE INDEX lineage_from ON pipeline.lineage_edges (workspace_id, from_kind, from_ref);
CREATE INDEX lineage_to ON pipeline.lineage_edges (workspace_id, to_kind, to_ref);

-- Written in the same transaction as the state change it announces; dispatched at least once.
CREATE TABLE pipeline.pipeline_outbox (
    id              bigserial   PRIMARY KEY,
    event_id        text        NOT NULL UNIQUE,
    workspace_id    text        NOT NULL,
    type            text        NOT NULL,
    payload         jsonb       NOT NULL,
    payload_ref     text,
    correlation_id  text,
    depth           integer     NOT NULL DEFAULT 0 CHECK (depth >= 0),
    idempotency_key text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    dispatched_at   timestamptz,
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX pipeline_outbox_pending ON pipeline.pipeline_outbox (id) WHERE dispatched_at IS NULL;

-- Consumers record each event id they applied; a redelivery is a no-op.
CREATE TABLE pipeline.pipeline_inbox_dedupe (
    consumer     text        NOT NULL,
    event_id     text        NOT NULL,
    workspace_id text        NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- +goose Down
DROP TABLE IF EXISTS pipeline.pipeline_inbox_dedupe;
DROP TABLE IF EXISTS pipeline.pipeline_outbox;
DROP TABLE IF EXISTS pipeline.lineage_edges;
DROP TABLE IF EXISTS pipeline.run_artifacts;
DROP TABLE IF EXISTS pipeline.step_attempts;
DROP TABLE IF EXISTS pipeline.step_executions;
DROP TABLE IF EXISTS pipeline.pipeline_runs;
DROP TRIGGER IF EXISTS pipeline_revisions_immutable ON pipeline.pipeline_revisions;
DROP TABLE IF EXISTS pipeline.pipeline_revisions;
DROP FUNCTION IF EXISTS pipeline.reject_mutation();
DROP TABLE IF EXISTS pipeline.pipeline_definitions;
