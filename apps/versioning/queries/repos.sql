-- name: CreateRepo :one
INSERT INTO versioning.dataset_repositories (id, tenant_id, project_id, name, default_branch, policy_id, required_approvals, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: GetRepo :one
SELECT * FROM versioning.dataset_repositories WHERE id = $1;

-- name: ListRepoIDs :many
SELECT id FROM versioning.dataset_repositories ORDER BY id;
