-- name: InsertOutbox :exec
INSERT INTO versioning.outbox_events (id, tenant_id, event_type, entity_id, payload) VALUES ($1, $2, $3, $4, $5);

-- name: ClaimOutbox :many
SELECT * FROM versioning.outbox_events WHERE delivered_at IS NULL ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED;

-- name: MarkOutboxDelivered :exec
UPDATE versioning.outbox_events SET delivered_at = now() WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: StaleOutboxCount :one
SELECT count(*) FROM versioning.outbox_events WHERE delivered_at IS NULL AND created_at < $1;
