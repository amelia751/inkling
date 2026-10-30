-- name: CreateBranch :one
INSERT INTO versioning.repo_branches (tenant_id, repo_id, name, commit_oid, protected, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetBranch :one
SELECT * FROM versioning.repo_branches WHERE repo_id = $1 AND name = $2;

-- name: GetLiveBranchForUpdate :one
SELECT * FROM versioning.repo_branches WHERE repo_id = $1 AND name = $2 AND deleted_at IS NULL FOR UPDATE;

-- name: ListBranches :many
SELECT * FROM versioning.repo_branches
WHERE repo_id = $1 AND deleted_at IS NULL AND name > sqlc.arg(after)::text
ORDER BY name LIMIT $2;

-- name: AllBranchHeads :many
SELECT name, commit_oid, deleted_at, retain_until FROM versioning.repo_branches
WHERE repo_id = $1 AND (deleted_at IS NULL OR retain_until > now());

-- name: CASBranchHead :one
-- The authoritative head move (spec §5): zero rows means a stale expected head.
UPDATE versioning.repo_branches
SET commit_oid = sqlc.arg(new_oid), generation = generation + 1, updated_at = now()
WHERE repo_id = sqlc.arg(repo_id) AND name = sqlc.arg(name) AND commit_oid = sqlc.arg(expected_oid)
  AND tenant_id = sqlc.arg(tenant_id) AND deleted_at IS NULL
RETURNING generation;

-- name: TombstoneBranch :one
UPDATE versioning.repo_branches
SET deleted_at = now(), retain_until = sqlc.arg(retain_until), updated_at = now()
WHERE repo_id = sqlc.arg(repo_id) AND name = sqlc.arg(name) AND commit_oid = sqlc.arg(expected_oid)
  AND deleted_at IS NULL AND NOT protected
RETURNING *;

-- name: ReviveBranch :one
UPDATE versioning.repo_branches
SET deleted_at = NULL, retain_until = NULL, commit_oid = $3, generation = generation + 1, updated_at = now(), protected = $4
WHERE repo_id = $1 AND name = $2 AND deleted_at IS NOT NULL
RETURNING *;

-- name: CountLiveBranches :one
SELECT count(*) FROM versioning.repo_branches WHERE repo_id = $1 AND deleted_at IS NULL;

-- name: UpsertRefProjection :exec
INSERT INTO versioning.git_refs (tenant_id, repo_id, name, target) VALUES ($1, $2, $3, $4)
ON CONFLICT (repo_id, name) DO UPDATE SET target = EXCLUDED.target;

-- name: DeleteRefProjection :exec
DELETE FROM versioning.git_refs WHERE repo_id = $1 AND name = $2;

-- name: ListRefProjections :many
SELECT name, target FROM versioning.git_refs WHERE repo_id = $1 ORDER BY name;
