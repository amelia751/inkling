// Package reconcile detects inconsistencies between Postgres, the Git object
// store and object storage, repairs what is safe to repair, and reports the
// rest (spec §13, todo4 Phase 3). It never deletes reachable data.
package reconcile

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

// Finding kinds.
const (
	MissingObjects   = "published_commit_missing_objects" // pages someone
	OrphanCommit     = "orphaned_git_commit"
	ExpiredStaged    = "staged_upload_expired"
	StaleProjection  = "stale_ref_projection"
	OutboxGap        = "outbox_delivery_gap"
	PromotedArtifact = "staged_artifact_promoted"
)

// Finding is one reported issue.
type Finding struct {
	Tenant   string `json:"tenant_id"`
	Repo     string `json:"repo_id,omitempty"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"` // info | warning | page
	Subject  string `json:"subject"`
	Repaired bool   `json:"repaired"`
}

// Reconciler holds the stores.
type Reconciler struct {
	DB          *storage.DB
	Git         *gitengine.Engine
	Blobs       storage.BlobStore
	Manifests   *manifests.Store
	Log         *slog.Logger
	OrphanGrace time.Duration // a Git commit younger than this may still be in flight
	OutboxLag   time.Duration
	Recent      time.Duration // published commits newer than this are verified too
	Now         func() time.Time
}

// RunOnce checks every tenant and repository and records findings.
func (r *Reconciler) RunOnce(ctx context.Context) ([]Finding, error) {
	tenants, err := db.New(r.DB.Pool).ListTenants(ctx)
	if err != nil {
		return nil, err
	}
	var all []Finding
	for _, t := range tenants {
		fs, err := r.tenant(ctx, t)
		if err != nil {
			return all, err
		}
		all = append(all, fs...)
	}
	return all, nil
}

func (r *Reconciler) tenant(ctx context.Context, tenant string) ([]Finding, error) {
	var out []Finding
	add := func(repo, kind, sev, subject string, repaired bool) {
		out = append(out, Finding{Tenant: tenant, Repo: repo, Kind: kind, Severity: sev, Subject: subject, Repaired: repaired})
	}
	var repos []string
	err := r.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		var err error
		if repos, err = q.ListRepoIDs(ctx); err != nil {
			return err
		}
		// Staged uploads past their TTL that nothing references.
		expired, err := q.ExpiredStagedArtifacts(ctx, 1000)
		if err != nil {
			return err
		}
		for _, a := range expired {
			if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: a.ID, Status: "unreferenced"}); err != nil {
				return err
			}
			add("", ExpiredStaged, "info", a.ContentSha256, true)
		}
		n, err := q.StaleOutboxCount(ctx, r.Now().Add(-r.OutboxLag))
		if err != nil {
			return err
		}
		if n > 0 {
			add("", OutboxGap, "warning", itoa(n)+" events undelivered", false)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, repo := range repos {
		fs, err := r.repo(ctx, tenant, repo)
		if err != nil {
			return out, err
		}
		out = append(out, fs...)
	}
	if len(out) > 0 {
		err = r.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
			q := db.New(tx)
			for _, f := range out {
				if f.Severity == "page" {
					r.Log.Error("reconcile: published data missing", "page", true, "tenant_id", f.Tenant,
						"repo_id", f.Repo, "kind", f.Kind, "subject", f.Subject)
				}
				if err := q.InsertReconcileReport(ctx, db.InsertReconcileReportParams{ID: ids.New(), TenantID: tenant,
					RepoID: strp(f.Repo), Kind: f.Kind, Severity: f.Severity, Subject: f.Subject, Repaired: f.Repaired}); err != nil {
					return err
				}
			}
			return nil
		})
	}
	return out, err
}

func (r *Reconciler) repo(ctx context.Context, tenant, repo string) ([]Finding, error) {
	var out []Finding
	add := func(kind, sev, subject string, repaired bool) {
		out = append(out, Finding{Tenant: tenant, Repo: repo, Kind: kind, Severity: sev, Subject: subject, Repaired: repaired})
	}
	g := r.Git.Open(ctx, tenant, repo)
	var published map[string]string // oid -> root, for heads, releases and recent commits
	var known map[string]bool
	err := r.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		published, known = map[string]string{}, map[string]bool{}
		commits, err := q.ListCommitOIDs(ctx, repo)
		if err != nil {
			return err
		}
		rootOf := map[string]string{}
		for _, c := range commits {
			known[c.Oid] = true
			rootOf[c.Oid] = c.ManifestRoot
			if c.CreatedAt.After(r.Now().Add(-r.Recent)) {
				published[c.Oid] = c.ManifestRoot
			}
		}
		heads, err := q.AllBranchHeads(ctx, repo)
		if err != nil {
			return err
		}
		want := map[string]string{}
		for _, b := range heads {
			published[b.CommitOid] = rootOf[b.CommitOid]
			if b.DeletedAt == nil {
				want["refs/heads/"+b.Name] = b.CommitOid
			}
		}
		rels, err := q.ListReleases(ctx, repo)
		if err != nil {
			return err
		}
		for _, rel := range rels {
			published[rel.CommitOid] = rel.ManifestRoot
			want["refs/tags/"+rel.Tag] = rel.CommitOid
		}
		// Rebuild a stale ref projection from the authoritative tables.
		have, err := q.ListRefProjections(ctx, repo)
		if err != nil {
			return err
		}
		got := map[string]string{}
		for _, h := range have {
			got[h.Name] = h.Target
		}
		for name, target := range want {
			if got[name] != target {
				if err := q.UpsertRefProjection(ctx, db.UpsertRefProjectionParams{TenantID: tenant, RepoID: repo, Name: name, Target: target}); err != nil {
					return err
				}
				add(StaleProjection, "warning", name, true)
			}
		}
		for name := range got {
			if _, ok := want[name]; !ok {
				if err := q.DeleteRefProjection(ctx, db.DeleteRefProjectionParams{RepoID: repo, Name: name}); err != nil {
					return err
				}
				add(StaleProjection, "warning", name, true)
			}
		}
		// Re-run step 7 for every committed root (idempotent).
		roots, err := q.CommittedRoots(ctx, repo)
		if err != nil {
			return err
		}
		for _, root := range roots {
			n, err := q.PromoteReferencedArtifacts(ctx, db.PromoteReferencedArtifactsParams{RepoID: repo, RootHash: root})
			if err != nil {
				return err
			}
			if n > 0 {
				add(PromotedArtifact, "info", root, true)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Published commits must have their Git objects and manifest objects.
	for oid, root := range published {
		if _, err := g.ObjectIDs(oid); err != nil {
			add(MissingObjects, "page", "commit "+oid, false)
			continue
		}
		mr, err := r.Manifests.LoadRoot(ctx, tenant, repo, root)
		if err != nil {
			add(MissingObjects, "page", "manifest "+root, false)
			continue
		}
		if mr.Format == manifests.FormatChunked {
			all := make([]int, 0, len(mr.Buckets))
			for b := range mr.Buckets {
				all = append(all, b)
			}
			if _, err := r.Manifests.LoadBuckets(ctx, tenant, repo, mr, all); err != nil {
				add(MissingObjects, "page", "manifest chunks "+root, false)
			}
		}
	}
	// Orphaned Git commits: written but never published (a crash between the
	// Git write and the CAS). GC removes them after the grace window.
	var orphans []db.GitCommitObjectsRow
	if err := r.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		var err error
		orphans, err = db.New(tx).GitCommitObjects(ctx, repo)
		return err
	}); err != nil {
		return nil, err
	}
	for _, o := range orphans {
		if !known[o.Oid] && o.CreatedAt.Before(r.Now().Add(-r.OrphanGrace)) {
			add(OrphanCommit, "info", o.Oid, false)
		}
	}
	return out, nil
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func itoa(n int64) string {
	b := []byte{}
	if n == 0 {
		return "0"
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
