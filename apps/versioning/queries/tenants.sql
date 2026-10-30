-- name: EnsureTenant :exec
INSERT INTO versioning.tenants (id) VALUES ($1) ON CONFLICT DO NOTHING;

-- name: ListTenants :many
SELECT id FROM versioning.tenants ORDER BY id;
