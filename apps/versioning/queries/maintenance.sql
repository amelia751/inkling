-- name: InsertLease :exec
INSERT INTO versioning.checkout_leases (id, tenant_id, repo_id, commit_oid, root_hash, actor_id, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ActiveLeases :many
SELECT commit_oid, root_hash FROM versioning.checkout_leases WHERE repo_id = $1 AND expires_at > now();

-- name: DeleteExpiredLeases :execrows
DELETE FROM versioning.checkout_leases WHERE expires_at <= now();

-- name: InsertReconcileReport :exec
INSERT INTO versioning.reconcile_reports (id, tenant_id, repo_id, kind, severity, subject, repaired)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListReconcileReports :many
SELECT * FROM versioning.reconcile_reports ORDER BY created_at, id;

-- name: GitObjectsOlderThan :many
SELECT oid, type FROM versioning.git_objects WHERE repo_id = $1 AND created_at < $2;

-- name: GitCommitObjects :many
SELECT oid, created_at FROM versioning.git_objects WHERE repo_id = $1 AND type = 1;

-- name: DeleteGitObjects :execrows
DELETE FROM versioning.git_objects WHERE repo_id = $1 AND oid = ANY(sqlc.arg(oids)::text[]);

-- name: HeldRepos :many
SELECT DISTINCT repo_id FROM versioning.legal_holds WHERE released_at IS NULL AND repo_id IS NOT NULL;

-- name: OpenConflictRefs :many
SELECT c.base_ref, c.ours_ref, c.theirs_ref, c.resolution FROM versioning.merge_conflicts c
JOIN versioning.review_requests r ON r.id = c.review_id
WHERE r.repo_id = $1 AND r.status NOT IN ('MERGED', 'CLOSED');

-- name: DeleteArtifactRefsForRoot :exec
DELETE FROM versioning.artifact_references WHERE repo_id = $1 AND root_hash = $2;

-- name: UnreferencedArtifactsOlderThan :many
SELECT * FROM versioning.artifacts WHERE status = 'unreferenced' AND unreferenced_since < $1 AND NOT legal_hold ORDER BY id;

-- name: CommittedRoots :many
SELECT DISTINCT manifest_root FROM versioning.repo_commits WHERE repo_id = $1;
