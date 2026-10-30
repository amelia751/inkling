-- name: UpsertStagedArtifact :one
INSERT INTO versioning.artifacts (id, tenant_id, content_sha256, size_bytes, media_type, storage_key, status, created_by, staged_expires_at)
VALUES ($1, $2, $3, $4, $5, $6, 'staged', $7, $8)
ON CONFLICT (tenant_id, content_sha256) DO UPDATE
  SET staged_expires_at = CASE WHEN artifacts.status = 'staged' THEN EXCLUDED.staged_expires_at ELSE artifacts.staged_expires_at END
RETURNING *;

-- name: GetArtifactBySHA :one
SELECT * FROM versioning.artifacts WHERE tenant_id = $1 AND content_sha256 = $2;

-- name: ArtifactsBySHA :many
SELECT * FROM versioning.artifacts WHERE tenant_id = $1 AND content_sha256 = ANY(sqlc.arg(hashes)::text[]);

-- name: InsertArtifactReferences :exec
INSERT INTO versioning.artifact_references (tenant_id, repo_id, root_hash, artifact_id)
SELECT sqlc.arg(tenant_id), sqlc.arg(repo_id), sqlc.arg(root_hash), unnest(sqlc.arg(artifact_ids)::uuid[])
ON CONFLICT DO NOTHING;

-- name: PromoteReferencedArtifacts :execrows
-- Reconcile step 7: staged artifacts referenced by a published root become available.
UPDATE versioning.artifacts a SET status = 'available', staged_expires_at = NULL, unreferenced_since = NULL
WHERE a.status IN ('staged', 'unreferenced') AND EXISTS (
  SELECT 1 FROM versioning.artifact_references r
  JOIN versioning.repo_commits c ON c.repo_id = r.repo_id AND c.manifest_root = r.root_hash
  WHERE r.artifact_id = a.id AND r.repo_id = $1 AND r.root_hash = $2);

-- name: ExpiredStagedArtifacts :many
-- Staged past the TTL and not referenced by any committed root (a registered
-- but never committed manifest does not keep its uploads alive).
SELECT * FROM versioning.artifacts WHERE status = 'staged' AND staged_expires_at < now()
  AND NOT EXISTS (
    SELECT 1 FROM versioning.artifact_references r
    JOIN versioning.repo_commits c ON c.repo_id = r.repo_id AND c.manifest_root = r.root_hash
    WHERE r.artifact_id = artifacts.id)
ORDER BY created_at LIMIT $1;

-- name: SetArtifactStatus :exec
UPDATE versioning.artifacts SET status = $2,
  unreferenced_since = CASE WHEN $2 = 'unreferenced' THEN coalesce(unreferenced_since, now()) WHEN $2 = 'available' THEN NULL ELSE unreferenced_since END,
  purged_at = CASE WHEN $2 = 'purged' THEN now() ELSE purged_at END
WHERE id = $1;

-- name: ListArtifacts :many
SELECT * FROM versioning.artifacts WHERE status NOT IN ('deleted', 'purged') ORDER BY id;

-- name: ArtifactIDsForRoot :many
SELECT artifact_id FROM versioning.artifact_references WHERE repo_id = $1 AND root_hash = $2;

-- name: SetLegalHold :exec
UPDATE versioning.artifacts SET legal_hold = $2 WHERE id = $1;

-- name: InsertLegalHold :one
INSERT INTO versioning.legal_holds (id, tenant_id, repo_id, artifact_id, reason_code, created_by)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: ActiveLegalHolds :many
SELECT * FROM versioning.legal_holds WHERE released_at IS NULL;

-- name: ArtifactLiveReferences :one
-- Purge guard: references from any live branch head or release.
SELECT count(*) FROM versioning.artifact_references r
JOIN versioning.repo_commits c ON c.repo_id = r.repo_id AND c.manifest_root = r.root_hash
WHERE r.artifact_id = $1 AND (
  EXISTS (SELECT 1 FROM versioning.repo_branches b WHERE b.repo_id = c.repo_id AND b.commit_oid = c.oid AND b.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM versioning.dataset_releases d WHERE d.repo_id = c.repo_id AND d.commit_oid = c.oid));

-- name: ArtifactHeld :one
SELECT EXISTS (
  SELECT 1 FROM versioning.legal_holds h WHERE h.released_at IS NULL AND (h.artifact_id = sqlc.arg(artifact_id)::uuid OR h.repo_id IN (
    SELECT r.repo_id FROM versioning.artifact_references r WHERE r.artifact_id = sqlc.arg(artifact_id)::uuid)));
