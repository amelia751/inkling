-- name: InsertDiffJob :one
INSERT INTO versioning.diff_jobs (id, tenant_id, repo_id, base_oid, head_oid, status) VALUES ($1, $2, $3, $4, $5, 'pending')
RETURNING *;

-- name: FindDiffJob :one
SELECT * FROM versioning.diff_jobs WHERE repo_id = $1 AND base_oid = $2 AND head_oid = $3 AND status <> 'failed'
ORDER BY created_at DESC LIMIT 1;

-- name: GetDiffJob :one
SELECT * FROM versioning.diff_jobs WHERE repo_id = $1 AND id = $2;

-- name: SetDiffJobStatus :exec
UPDATE versioning.diff_jobs SET status = $3, result_key = $4,
  finished_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE finished_at END
WHERE repo_id = $1 AND id = $2;
