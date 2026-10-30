-- name: InsertRelease :one
INSERT INTO versioning.dataset_releases (tenant_id, repo_id, tag, commit_oid, manifest_root, created_by, retention_policy, retain_until, attestations)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: GetRelease :one
SELECT * FROM versioning.dataset_releases WHERE repo_id = $1 AND tag = $2;

-- name: ListReleases :many
SELECT * FROM versioning.dataset_releases WHERE repo_id = $1 ORDER BY created_at, tag;

-- name: DeleteRelease :exec
DELETE FROM versioning.dataset_releases WHERE repo_id = $1 AND tag = $2;

-- name: ReviewsMergedAt :many
SELECT id FROM versioning.review_requests WHERE repo_id = $1 AND merge_oid = $2 AND status = 'MERGED';
