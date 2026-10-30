-- name: GetIdempotency :one
SELECT * FROM versioning.idempotency_records
WHERE tenant_id = $1 AND repo_id = $2 AND branch = $3 AND idempotency_key = $4 AND expires_at > now();

-- name: InsertIdempotency :exec
INSERT INTO versioning.idempotency_records (tenant_id, repo_id, branch, idempotency_key, request_hash, status_code, response_json, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: DeleteExpiredIdempotency :execrows
DELETE FROM versioning.idempotency_records WHERE expires_at <= now();
