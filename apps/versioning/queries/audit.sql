-- name: InsertAudit :exec
INSERT INTO versioning.audit_events (id, tenant_id, repo_id, actor_id, actor_kind, on_behalf_of, event_type, entity_id, commit_oid, payload, request_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: ListAudit :many
SELECT * FROM versioning.audit_events WHERE repo_id = $1 ORDER BY created_at, id;
