-- +goose Up
-- Versioning service schema (versioning.md §11, todo4 V1/V2).
-- Owned by versioning_owner; the service runs as versioning_app, which has DML
-- only and is subject to row-level security on every tenant-scoped table.
CREATE SCHEMA IF NOT EXISTS versioning;

-- Tenants known to this service. Not RLS-protected: background jobs iterate it
-- and then SET LOCAL app.tenant_id per tenant, so versioning_app never needs
-- BYPASSRLS.
CREATE TABLE versioning.tenants (
    id         uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE versioning.dataset_repositories (
    id             uuid PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES versioning.tenants (id),
    project_id     uuid NOT NULL,
    name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    default_branch text NOT NULL DEFAULT 'main',
    policy_id      text NOT NULL DEFAULT 'default',
    required_approvals integer NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 0 AND 10),
    object_format  text NOT NULL DEFAULT 'sha1' CHECK (object_format IN ('sha1', 'sha256')),
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, project_id, name)
);
CREATE INDEX dataset_repositories_tenant_project ON versioning.dataset_repositories (tenant_id, project_id, id);

CREATE TABLE versioning.repo_branches (
    tenant_id    uuid NOT NULL,
    repo_id      uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    name         text NOT NULL CHECK (
        name ~ '^[a-z0-9][a-z0-9._/-]{0,127}$'
        AND name NOT LIKE '%..%' AND name NOT LIKE '%//%' AND name NOT LIKE '%@{%'
        AND name NOT LIKE '%/' AND name NOT LIKE '%.lock' AND name <> 'head'
    ),
    commit_oid   text NOT NULL CHECK (commit_oid ~ '^[0-9a-f]{40}$'),
    generation   bigint NOT NULL DEFAULT 1,
    protected    boolean NOT NULL DEFAULT false,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    retain_until timestamptz,
    PRIMARY KEY (repo_id, name)
);

CREATE TABLE versioning.repo_commits (
    tenant_id     uuid NOT NULL,
    repo_id       uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    oid           text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
    manifest_root text NOT NULL CHECK (manifest_root ~ '^sha256:[0-9a-f]{64}$'),
    author_id     text NOT NULL,
    on_behalf_of  text,
    parent_oids   text[] NOT NULL DEFAULT '{}',
    message       text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'reverted')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, oid)
);
CREATE INDEX repo_commits_created ON versioning.repo_commits (repo_id, created_at DESC);

CREATE TABLE versioning.manifest_roots (
    tenant_id        uuid NOT NULL,
    repo_id          uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    root_hash        text NOT NULL CHECK (root_hash ~ '^sha256:[0-9a-f]{64}$'),
    schema_version   text NOT NULL,
    format           text NOT NULL CHECK (format IN ('json-v1', 'chunked-v1')),
    object_key       text NOT NULL,
    sample_count     integer NOT NULL,
    annotation_count integer NOT NULL,
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, root_hash)
);

-- Filter samples without reading chunks (todo4 Phase 3, V7).
CREATE TABLE versioning.manifest_index (
    tenant_id       uuid NOT NULL,
    repo_id         uuid NOT NULL,
    root_hash       text NOT NULL,
    bucket          smallint NOT NULL CHECK (bucket BETWEEN 0 AND 255),
    study_uid_hash  text NOT NULL DEFAULT '',
    series_uid_hash text NOT NULL DEFAULT '',
    split           text NOT NULL DEFAULT '',
    sample_count    integer NOT NULL,
    label_counts    jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (repo_id, root_hash, bucket, study_uid_hash, series_uid_hash, split),
    FOREIGN KEY (repo_id, root_hash) REFERENCES versioning.manifest_roots (repo_id, root_hash)
);

CREATE TABLE versioning.artifacts (
    id                uuid PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES versioning.tenants (id),
    content_sha256    text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes        bigint NOT NULL CHECK (size_bytes >= 0),
    media_type        text NOT NULL,
    storage_key       text NOT NULL,
    status            text NOT NULL DEFAULT 'staged'
        CHECK (status IN ('staged', 'available', 'unreferenced', 'deleted', 'purged')),
    legal_hold        boolean NOT NULL DEFAULT false,
    created_by        text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    staged_expires_at timestamptz,
    unreferenced_since timestamptz,
    purged_at         timestamptz,
    UNIQUE (tenant_id, content_sha256)
);
CREATE INDEX artifacts_status ON versioning.artifacts (tenant_id, status);

CREATE TABLE versioning.artifact_references (
    tenant_id   uuid NOT NULL,
    repo_id     uuid NOT NULL,
    root_hash   text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES versioning.artifacts (id),
    PRIMARY KEY (repo_id, root_hash, artifact_id),
    FOREIGN KEY (repo_id, root_hash) REFERENCES versioning.manifest_roots (repo_id, root_hash)
);
CREATE INDEX artifact_references_artifact ON versioning.artifact_references (artifact_id);

CREATE TABLE versioning.review_requests (
    id                 uuid PRIMARY KEY,
    tenant_id          uuid NOT NULL,
    repo_id            uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    description        text NOT NULL DEFAULT '',
    author_id          text NOT NULL,
    author_on_behalf_of text,
    source_branch      text NOT NULL,
    source_oid         text NOT NULL,
    target_branch      text NOT NULL,
    checked_target_oid text,
    base_oid           text,
    status             text NOT NULL CHECK (status IN
        ('DRAFT', 'OPEN', 'CHECKING', 'READY', 'BLOCKED', 'CONFLICTED', 'MERGING', 'MERGED', 'CLOSED')),
    required_approvals integer NOT NULL DEFAULT 1 CHECK (required_approvals >= 0),
    merge_oid          text,
    version            bigint NOT NULL DEFAULT 1,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    closed_at          timestamptz,
    CHECK (source_branch <> target_branch)
);
CREATE INDEX review_requests_status ON versioning.review_requests (repo_id, status);
CREATE INDEX review_requests_source ON versioning.review_requests (repo_id, source_branch) WHERE status NOT IN ('MERGED', 'CLOSED');
CREATE INDEX review_requests_target ON versioning.review_requests (repo_id, target_branch) WHERE status NOT IN ('MERGED', 'CLOSED');

CREATE TABLE versioning.review_approvals (
    tenant_id           uuid NOT NULL,
    review_id           uuid NOT NULL REFERENCES versioning.review_requests (id),
    reviewer_id         text NOT NULL,
    approved_source_oid text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, reviewer_id, approved_source_oid)
);

CREATE TABLE versioning.review_comments (
    id            uuid PRIMARY KEY,
    tenant_id     uuid NOT NULL,
    review_id     uuid NOT NULL REFERENCES versioning.review_requests (id),
    author_id     text NOT NULL,
    sample_id     text,
    annotation_id text,
    source_oid    text NOT NULL,
    body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_review ON versioning.review_comments (review_id, created_at);

CREATE TABLE versioning.review_checks (
    tenant_id    uuid NOT NULL,
    review_id    uuid NOT NULL REFERENCES versioning.review_requests (id),
    source_oid   text NOT NULL,
    target_oid   text NOT NULL,
    name         text NOT NULL,
    mandatory    boolean NOT NULL,
    outcome      text NOT NULL CHECK (outcome IN ('pending', 'passed', 'failed', 'error')),
    details      jsonb NOT NULL DEFAULT '{}',
    artifact_ref text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, source_oid, target_oid, name)
);

CREATE TABLE versioning.merge_conflicts (
    tenant_id     uuid NOT NULL,
    review_id     uuid NOT NULL REFERENCES versioning.review_requests (id),
    source_oid    text NOT NULL,
    target_oid    text NOT NULL,
    conflict_key  text NOT NULL,
    kind          text NOT NULL,
    sample_id     text,
    annotation_id text,
    field         text,
    base_ref      text,
    ours_ref      text,
    theirs_ref    text,
    resolution    jsonb,
    resolved_by   text,
    resolved_at   timestamptz,
    PRIMARY KEY (review_id, source_oid, target_oid, conflict_key)
);

CREATE TABLE versioning.dataset_releases (
    tenant_id        uuid NOT NULL,
    repo_id          uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    tag              text NOT NULL CHECK (tag ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    commit_oid       text NOT NULL,
    manifest_root    text NOT NULL,
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    retention_policy text NOT NULL DEFAULT 'standard',
    retain_until     timestamptz,
    attestations     jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY (repo_id, tag)
);

CREATE TABLE versioning.idempotency_records (
    tenant_id       uuid NOT NULL,
    repo_id         uuid NOT NULL,
    branch          text NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
    request_hash    text NOT NULL,
    status_code     integer NOT NULL,
    response_json   jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    UNIQUE (tenant_id, repo_id, branch, idempotency_key)
);
CREATE INDEX idempotency_records_expiry ON versioning.idempotency_records (expires_at);

CREATE TABLE versioning.audit_events (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL,
    repo_id      uuid,
    actor_id     text NOT NULL,
    actor_kind   text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'service')),
    on_behalf_of text,
    event_type   text NOT NULL,
    entity_id    text NOT NULL,
    commit_oid   text,
    payload      jsonb NOT NULL DEFAULT '{}',
    request_id   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_repo ON versioning.audit_events (repo_id, created_at);

CREATE TABLE versioning.outbox_events (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL,
    event_type   text NOT NULL,
    entity_id    text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX outbox_events_undelivered ON versioning.outbox_events (created_at) WHERE delivered_at IS NULL;

CREATE TABLE versioning.legal_holds (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    repo_id     uuid REFERENCES versioning.dataset_repositories (id),
    artifact_id uuid REFERENCES versioning.artifacts (id),
    reason_code text NOT NULL,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    CHECK (repo_id IS NOT NULL OR artifact_id IS NOT NULL)
);

CREATE TABLE versioning.checkout_leases (
    id         uuid PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    repo_id    uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    commit_oid text NOT NULL,
    root_hash  text NOT NULL,
    actor_id   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX checkout_leases_active ON versioning.checkout_leases (repo_id, expires_at);

CREATE TABLE versioning.reconcile_reports (
    id         uuid PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    repo_id    uuid,
    kind       text NOT NULL,
    severity   text NOT NULL CHECK (severity IN ('info', 'warning', 'page')),
    subject    text NOT NULL,
    repaired   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Background semantic diffs too large to answer synchronously (spec §7).
CREATE TABLE versioning.diff_jobs (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    repo_id     uuid NOT NULL REFERENCES versioning.dataset_repositories (id),
    base_oid    text NOT NULL,
    head_oid    text NOT NULL,
    status      text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
    result_key  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX diff_jobs_pair ON versioning.diff_jobs (repo_id, base_oid, head_oid);

-- go-git object storage (todo4 V1). Objects are immutable and content-addressed.
CREATE TABLE versioning.git_objects (
    tenant_id  uuid NOT NULL,
    repo_id    uuid NOT NULL,
    oid        text NOT NULL,
    type       smallint NOT NULL,
    size       integer NOT NULL,
    data       bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, oid)
);
CREATE INDEX git_objects_type ON versioning.git_objects (repo_id, type);

-- Projection only: repo_branches is authoritative (versioning.md §4).
CREATE TABLE versioning.git_refs (
    tenant_id uuid NOT NULL,
    repo_id   uuid NOT NULL,
    name      text NOT NULL,
    target    text NOT NULL,
    PRIMARY KEY (repo_id, name)
);

CREATE TABLE versioning.repo_config (
    tenant_id uuid NOT NULL,
    repo_id   uuid PRIMARY KEY,
    data      bytea NOT NULL
);

-- Shallow list and index for storer conformance; bare repos never use them.
CREATE TABLE versioning.git_aux (
    tenant_id  uuid NOT NULL,
    repo_id    uuid NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('shallow', 'index')),
    data       bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, kind)
);

-- Row-level security: a second layer behind application checks (spec §14).
-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'dataset_repositories', 'repo_branches', 'repo_commits', 'manifest_roots', 'manifest_index',
        'artifacts', 'artifact_references', 'review_requests', 'review_approvals', 'review_comments',
        'review_checks', 'merge_conflicts', 'dataset_releases', 'idempotency_records', 'audit_events',
        'outbox_events', 'legal_holds', 'diff_jobs', 'checkout_leases', 'reconcile_reports', 'git_objects', 'git_refs',
        'repo_config', 'git_aux'
    ] LOOP
        EXECUTE format('ALTER TABLE versioning.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON versioning.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t);
    END LOOP;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'versioning_app') THEN
        GRANT USAGE ON SCHEMA versioning TO versioning_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA versioning TO versioning_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA versioning TO versioning_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA versioning GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO versioning_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA versioning GRANT USAGE, SELECT ON SEQUENCES TO versioning_app;
    END IF;
END
$$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS versioning.git_aux;
DROP TABLE IF EXISTS versioning.repo_config;
DROP TABLE IF EXISTS versioning.git_refs;
DROP TABLE IF EXISTS versioning.git_objects;
DROP TABLE IF EXISTS versioning.reconcile_reports;
DROP TABLE IF EXISTS versioning.diff_jobs;
DROP TABLE IF EXISTS versioning.checkout_leases;
DROP TABLE IF EXISTS versioning.legal_holds;
DROP TABLE IF EXISTS versioning.outbox_events;
DROP TABLE IF EXISTS versioning.audit_events;
DROP TABLE IF EXISTS versioning.idempotency_records;
DROP TABLE IF EXISTS versioning.dataset_releases;
DROP TABLE IF EXISTS versioning.merge_conflicts;
DROP TABLE IF EXISTS versioning.review_checks;
DROP TABLE IF EXISTS versioning.review_comments;
DROP TABLE IF EXISTS versioning.review_approvals;
DROP TABLE IF EXISTS versioning.review_requests;
DROP TABLE IF EXISTS versioning.artifact_references;
DROP TABLE IF EXISTS versioning.artifacts;
DROP TABLE IF EXISTS versioning.manifest_index;
DROP TABLE IF EXISTS versioning.manifest_roots;
DROP TABLE IF EXISTS versioning.repo_commits;
DROP TABLE IF EXISTS versioning.repo_branches;
DROP TABLE IF EXISTS versioning.dataset_repositories;
DROP TABLE IF EXISTS versioning.tenants;
