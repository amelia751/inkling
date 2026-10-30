-- name: InsertCommit :exec
INSERT INTO versioning.repo_commits (tenant_id, repo_id, oid, manifest_root, author_id, on_behalf_of, parent_oids, message)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (repo_id, oid) DO NOTHING;

-- name: GetCommitRow :one
SELECT * FROM versioning.repo_commits WHERE repo_id = $1 AND oid = $2;

-- name: ListCommitOIDs :many
SELECT oid, manifest_root, created_at FROM versioning.repo_commits WHERE repo_id = $1;

-- name: CommitsSince :many
SELECT oid FROM versioning.repo_commits WHERE repo_id = $1 AND created_at > $2;
