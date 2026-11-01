-- todo12 Milestone 1: approvals bound to what the reviewer saw. Each approval gets an id (the
-- pipeline's PublishWorkflow id, so one approval publishes at most once), the digest of the
-- candidate's output manifest the api showed the reviewer, and the target head the review was
-- checked against. A pipeline principal may merge only with an approval whose target is still
-- the review's checked target (a stale approval doesn't count). Re-approving after the target
-- moved mints a new id.

-- +goose Up
ALTER TABLE versioning.review_approvals
    ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN candidate_digest text CHECK (candidate_digest IS NULL OR candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    ADD COLUMN approved_target_oid text CHECK (approved_target_oid IS NULL OR approved_target_oid ~ '^[0-9a-f]{40}$');
CREATE UNIQUE INDEX review_approvals_id ON versioning.review_approvals (id);

-- +goose Down
DROP INDEX IF EXISTS versioning.review_approvals_id;
ALTER TABLE versioning.review_approvals DROP COLUMN approved_target_oid, DROP COLUMN candidate_digest, DROP COLUMN id;
