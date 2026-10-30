package gc

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
)

// Plan lists what a sweep deletes (or would delete in dry-run mode).
type Plan struct {
	Tenant       string   `json:"tenant_id"`
	DryRun       bool     `json:"dry_run"`
	Artifacts    []string `json:"artifacts"`     // content sha256
	GitObjects   int      `json:"git_objects"`   // count
	ManifestKeys []string `json:"manifest_keys"` // object keys
	Roots        int      `json:"manifest_roots"`
}

// Sweep re-marks, then removes only objects unreachable for longer than
// grace. Held repositories are skipped entirely. With dryRun it only plans.
func (c *Collector) Sweep(ctx context.Context, tenant string, grace time.Duration, dryRun bool) (*Plan, error) {
	r, err := c.Mark(ctx, tenant)
	if err != nil {
		return nil, err
	}
	if _, err := c.UpdateStatuses(ctx, r); err != nil {
		return nil, err
	}
	cutoff := c.Now().Add(-grace)
	plan := &Plan{Tenant: tenant, DryRun: dryRun, Artifacts: []string{}, ManifestKeys: []string{}}
	var repos []string
	type gitDel struct {
		repo string
		oids []string
	}
	var gitDels []gitDel
	type rootDel struct{ repo, root string }
	var rootDels []rootDel
	var artDels []db.VersioningArtifact

	err = c.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		var err error
		if repos, err = q.ListRepoIDs(ctx); err != nil {
			return err
		}
		arts, err := q.UnreferencedArtifactsOlderThan(ctx, &cutoff)
		if err != nil {
			return err
		}
		for _, a := range arts {
			if !r.ArtifactReachable(a) {
				artDels = append(artDels, a)
				plan.Artifacts = append(plan.Artifacts, a.ContentSha256)
			}
		}
		for _, repo := range repos {
			if r.HeldRepos[repo] {
				continue
			}
			objs, err := q.GitObjectsOlderThan(ctx, db.GitObjectsOlderThanParams{RepoID: repo, CreatedAt: cutoff})
			if err != nil {
				return err
			}
			var del []string
			for _, o := range objs {
				if !r.GitObjects[repo][o.Oid] {
					del = append(del, o.Oid)
				}
			}
			if len(del) > 0 {
				gitDels = append(gitDels, gitDel{repo, del})
				plan.GitObjects += len(del)
			}
			roots, err := q.ListManifestRoots(ctx, repo)
			if err != nil {
				return err
			}
			committed, err := q.CommittedRoots(ctx, repo)
			if err != nil {
				return err
			}
			isCommitted := map[string]bool{}
			for _, h := range committed {
				isCommitted[h] = true
			}
			for _, mr := range roots {
				if !r.Roots[repo][mr.RootHash] && !isCommitted[mr.RootHash] && mr.CreatedAt.Before(cutoff) {
					rootDels = append(rootDels, rootDel{repo, mr.RootHash})
				}
			}
		}
		plan.Roots = len(rootDels)
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, repo := range repos {
		if r.HeldRepos[repo] {
			continue
		}
		prefix := tenant + "/" + repo + "/"
		if err := c.Blobs.ListManifests(ctx, prefix, func(key string, mod time.Time) error {
			if strings.Contains(key, "/diffs/") || r.ManifestKeys[key] || !mod.Before(cutoff) {
				return nil
			}
			plan.ManifestKeys = append(plan.ManifestKeys, key)
			return nil
		}); err != nil {
			return nil, err
		}
	}
	if dryRun {
		return plan, nil
	}
	// Bytes first, rows second: a crash leaves rows pointing at nothing, which
	// the reconciler reports, never live data without its bytes.
	for _, a := range artDels {
		if err := c.Blobs.Delete(ctx, tenant, a.ContentSha256); err != nil {
			return plan, err
		}
	}
	for _, k := range plan.ManifestKeys {
		if err := c.Blobs.DeleteManifest(ctx, k); err != nil {
			return plan, err
		}
	}
	err = c.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		for _, a := range artDels {
			if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: a.ID, Status: "deleted"}); err != nil {
				return err
			}
		}
		for _, g := range gitDels {
			if _, err := q.DeleteGitObjects(ctx, db.DeleteGitObjectsParams{RepoID: g.repo, Oids: g.oids}); err != nil {
				return err
			}
		}
		for _, d := range rootDels {
			if err := q.DeleteArtifactRefsForRoot(ctx, db.DeleteArtifactRefsForRootParams{RepoID: d.repo, RootHash: d.root}); err != nil {
				return err
			}
			if err := q.DeleteManifestIndex(ctx, db.DeleteManifestIndexParams{RepoID: d.repo, RootHash: d.root}); err != nil {
				return err
			}
			if err := q.DeleteManifestRoot(ctx, db.DeleteManifestRootParams{RepoID: d.repo, RootHash: d.root}); err != nil {
				return err
			}
		}
		return nil
	})
	return plan, err
}
