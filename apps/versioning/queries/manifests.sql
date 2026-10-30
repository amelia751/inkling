-- name: InsertManifestRoot :exec
INSERT INTO versioning.manifest_roots (tenant_id, repo_id, root_hash, schema_version, format, object_key, sample_count, annotation_count, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (repo_id, root_hash) DO NOTHING;

-- name: GetManifestRoot :one
SELECT * FROM versioning.manifest_roots WHERE repo_id = $1 AND root_hash = $2;

-- name: ListManifestRoots :many
SELECT root_hash, object_key, format, created_at FROM versioning.manifest_roots WHERE repo_id = $1;

-- name: InsertManifestIndex :exec
-- COPY is not allowed under row-level security, so rows go in as arrays.
INSERT INTO versioning.manifest_index (tenant_id, repo_id, root_hash, bucket, study_uid_hash, series_uid_hash, split, sample_count, label_counts)
SELECT sqlc.arg(tenant_id), sqlc.arg(repo_id), sqlc.arg(root_hash),
  unnest(sqlc.arg(buckets)::smallint[]), unnest(sqlc.arg(studies)::text[]), unnest(sqlc.arg(series)::text[]),
  unnest(sqlc.arg(splits)::text[]), unnest(sqlc.arg(counts)::int[]), unnest(sqlc.arg(labels)::jsonb[]);

-- name: HasManifestIndex :one
SELECT EXISTS (SELECT 1 FROM versioning.manifest_index WHERE repo_id = $1 AND root_hash = $2);

-- name: BucketsForFilter :many
-- Partial checkout: resolve a filter to the buckets that can contain matches.
SELECT DISTINCT bucket FROM versioning.manifest_index
WHERE repo_id = sqlc.arg(repo_id) AND root_hash = sqlc.arg(root_hash)
  AND (cardinality(sqlc.arg(splits)::text[]) = 0 OR split = ANY(sqlc.arg(splits)::text[]))
  AND (cardinality(sqlc.arg(studies)::text[]) = 0 OR study_uid_hash = ANY(sqlc.arg(studies)::text[]))
ORDER BY bucket;

-- name: DeleteManifestRoot :exec
DELETE FROM versioning.manifest_roots WHERE repo_id = $1 AND root_hash = $2;

-- name: DeleteManifestIndex :exec
DELETE FROM versioning.manifest_index WHERE repo_id = $1 AND root_hash = $2;
