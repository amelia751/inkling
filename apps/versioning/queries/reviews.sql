-- name: InsertReview :one
INSERT INTO versioning.review_requests (id, tenant_id, repo_id, title, description, author_id, author_on_behalf_of,
  source_branch, source_oid, target_branch, status, required_approvals)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: GetReview :one
SELECT * FROM versioning.review_requests WHERE repo_id = $1 AND id = $2;

-- name: GetReviewForUpdate :one
SELECT * FROM versioning.review_requests WHERE repo_id = $1 AND id = $2 FOR UPDATE;

-- name: ListReviews :many
SELECT * FROM versioning.review_requests
WHERE repo_id = sqlc.arg(repo_id) AND (sqlc.narg(status)::text IS NULL OR status = sqlc.narg(status))
  AND id > sqlc.arg(after)::uuid
ORDER BY id LIMIT sqlc.arg(lim);

-- name: UpdateReviewState :one
UPDATE versioning.review_requests SET status = sqlc.arg(status), source_oid = sqlc.arg(source_oid),
  checked_target_oid = sqlc.narg(checked_target_oid), base_oid = sqlc.narg(base_oid), merge_oid = sqlc.narg(merge_oid),
  version = version + 1, updated_at = now(),
  closed_at = CASE WHEN sqlc.arg(status) IN ('MERGED', 'CLOSED') THEN now() ELSE closed_at END
WHERE id = sqlc.arg(id) AND version = sqlc.arg(version)
RETURNING *;

-- name: OpenReviewsForBranch :many
-- Reviews affected when a branch head moves (as source or as target).
SELECT * FROM versioning.review_requests
WHERE repo_id = $1 AND (source_branch = $2 OR target_branch = $2) AND status NOT IN ('MERGED', 'CLOSED', 'DRAFT')
FOR UPDATE;

-- name: OpenReviewHeads :many
SELECT source_oid, checked_target_oid FROM versioning.review_requests WHERE repo_id = $1 AND status NOT IN ('MERGED', 'CLOSED');

-- name: InsertApproval :exec
INSERT INTO versioning.review_approvals (tenant_id, review_id, reviewer_id, approved_source_oid)
VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;

-- name: ListApprovals :many
SELECT * FROM versioning.review_approvals WHERE review_id = $1 ORDER BY created_at;

-- name: DeleteStaleApprovals :exec
DELETE FROM versioning.review_approvals WHERE review_id = $1 AND approved_source_oid <> $2;

-- name: InsertComment :one
INSERT INTO versioning.review_comments (id, tenant_id, review_id, author_id, sample_id, annotation_id, source_oid, body)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;

-- name: ListComments :many
SELECT * FROM versioning.review_comments WHERE review_id = $1 ORDER BY created_at, id;

-- name: UpsertCheck :exec
INSERT INTO versioning.review_checks (tenant_id, review_id, source_oid, target_oid, name, mandatory, outcome, details)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (review_id, source_oid, target_oid, name) DO UPDATE
  SET outcome = EXCLUDED.outcome, details = EXCLUDED.details, mandatory = EXCLUDED.mandatory, updated_at = now();

-- name: GetCheck :one
SELECT * FROM versioning.review_checks WHERE review_id = $1 AND source_oid = $2 AND target_oid = $3 AND name = $4;

-- name: ListChecks :many
SELECT * FROM versioning.review_checks WHERE review_id = $1 AND source_oid = $2 AND target_oid = $3 ORDER BY name;

-- name: UpsertConflict :exec
INSERT INTO versioning.merge_conflicts (tenant_id, review_id, source_oid, target_oid, conflict_key, kind, sample_id,
  annotation_id, field, base_ref, ours_ref, theirs_ref)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (review_id, source_oid, target_oid, conflict_key) DO NOTHING;

-- name: ListConflicts :many
SELECT * FROM versioning.merge_conflicts WHERE review_id = $1 AND source_oid = $2 AND target_oid = $3 ORDER BY conflict_key;

-- name: ResolveConflict :execrows
UPDATE versioning.merge_conflicts SET resolution = $5, resolved_by = $6, resolved_at = now()
WHERE review_id = $1 AND source_oid = $2 AND target_oid = $3 AND conflict_key = $4;

-- name: InsertPendingCheck :exec
INSERT INTO versioning.review_checks (tenant_id, review_id, source_oid, target_oid, name, mandatory, outcome)
VALUES ($1, $2, $3, $4, $5, $6, 'pending')
ON CONFLICT (review_id, source_oid, target_oid, name) DO NOTHING;
