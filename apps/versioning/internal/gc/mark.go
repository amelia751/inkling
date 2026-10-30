// Package gc implements reachability-based garbage collection (spec §13).
// Mark computes everything reachable from the roots; Sweep deletes only what
// has been unreachable for longer than the grace window and has no lease or
// hold. Sweep is dry-run by default (todo4 Phase 3).
package gc

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

// Collector holds the stores GC needs.
type Collector struct {
	DB               *storage.DB
	Git              *gitengine.Engine
	Blobs            storage.BlobStore
	Manifests        *manifests.Store
	HistoryRetention time.Duration
	Now              func() time.Time
}

// Reachable is the mark result for one tenant.
type Reachable struct {
	Tenant       string
	HeldRepos    map[string]bool
	Commits      map[string]map[string]bool // repo -> commit oid
	GitObjects   map[string]map[string]bool // repo -> object oid
	Roots        map[string]map[string]bool // repo -> manifest root hash
	ManifestKeys map[string]bool
	Artifacts    map[string]bool // artifact id
	ArtifactSHAs map[string]bool // content sha (conflict refs, holds)
}

func (r *Reachable) add(m map[string]map[string]bool, repo, k string) {
	if m[repo] == nil {
		m[repo] = map[string]bool{}
	}
	m[repo][k] = true
}

// Mark walks every repository of a tenant from its GC roots: branch heads
// (including tombstones within retention), releases, open reviews and their
// conflict refs, commits inside the history retention window, checkout
// leases and legal holds.
func (c *Collector) Mark(ctx context.Context, tenant string) (*Reachable, error) {
	r := &Reachable{Tenant: tenant, HeldRepos: map[string]bool{}, Commits: map[string]map[string]bool{},
		GitObjects: map[string]map[string]bool{}, Roots: map[string]map[string]bool{}, ManifestKeys: map[string]bool{},
		Artifacts: map[string]bool{}, ArtifactSHAs: map[string]bool{}}
	var repos []string
	heads := map[string][]string{}
	err := c.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		var err error
		if repos, err = q.ListRepoIDs(ctx); err != nil {
			return err
		}
		holds, err := q.ActiveLegalHolds(ctx)
		if err != nil {
			return err
		}
		for _, h := range holds {
			if h.ArtifactID != nil {
				r.Artifacts[*h.ArtifactID] = true
			} else if h.RepoID != nil {
				r.HeldRepos[*h.RepoID] = true
			}
		}
		since := c.Now().Add(-c.HistoryRetention)
		for _, repo := range repos {
			var roots []string
			bs, err := q.AllBranchHeads(ctx, repo)
			if err != nil {
				return err
			}
			for _, b := range bs {
				roots = append(roots, b.CommitOid)
			}
			rels, err := q.ListReleases(ctx, repo)
			if err != nil {
				return err
			}
			for _, rel := range rels {
				roots = append(roots, rel.CommitOid)
			}
			revs, err := q.OpenReviewHeads(ctx, repo)
			if err != nil {
				return err
			}
			for _, rv := range revs {
				roots = append(roots, rv.SourceOid)
				if rv.CheckedTargetOid != nil {
					roots = append(roots, *rv.CheckedTargetOid)
				}
			}
			recent, err := q.CommitsSince(ctx, db.CommitsSinceParams{RepoID: repo, CreatedAt: since})
			if err != nil {
				return err
			}
			roots = append(roots, recent...)
			leases, err := q.ActiveLeases(ctx, repo)
			if err != nil {
				return err
			}
			for _, l := range leases {
				roots = append(roots, l.CommitOid)
			}
			if r.HeldRepos[repo] {
				all, err := q.ListCommitOIDs(ctx, repo)
				if err != nil {
					return err
				}
				for _, cm := range all {
					roots = append(roots, cm.Oid)
				}
			}
			refs, err := q.OpenConflictRefs(ctx, repo)
			if err != nil {
				return err
			}
			for _, cr := range refs {
				for _, ref := range []*string{cr.BaseRef, cr.OursRef, cr.TheirsRef} {
					if ref != nil && len(*ref) == 71 {
						r.ArtifactSHAs[manifests.RefHex(*ref)] = true
					}
				}
				if cr.Resolution != nil {
					var res struct {
						Custom struct {
							Ref string `json:"ref"`
						} `json:"custom"`
					}
					if json.Unmarshal(cr.Resolution, &res) == nil && res.Custom.Ref != "" {
						r.ArtifactSHAs[manifests.RefHex(res.Custom.Ref)] = true
					}
				}
			}
			heads[repo] = dedupe(roots)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, repo := range repos {
		g := c.Git.Open(ctx, tenant, repo)
		if err := g.Walk(heads[repo], func(oid string) error {
			r.add(r.Commits, repo, oid)
			objs, err := g.ObjectIDs(oid)
			for _, o := range objs {
				r.add(r.GitObjects, repo, o)
			}
			if err != nil {
				return err
			}
			cm, err := g.ReadCommit(oid)
			if err != nil {
				return err
			}
			r.add(r.Roots, repo, cm.Snapshot.Dataset.ManifestRoot)
			return nil
		}); err != nil {
			return nil, err
		}
		for root := range r.Roots[repo] {
			mr, err := c.Manifests.LoadRoot(ctx, tenant, repo, root)
			if err != nil {
				return nil, err
			}
			for _, k := range c.Manifests.ChunkKeys(tenant, repo, mr) {
				r.ManifestKeys[k] = true
			}
		}
		if err := c.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
			q := db.New(tx)
			for root := range r.Roots[repo] {
				arts, err := q.ArtifactIDsForRoot(ctx, db.ArtifactIDsForRootParams{RepoID: repo, RootHash: root})
				if err != nil {
					return err
				}
				for _, a := range arts {
					r.Artifacts[a] = true
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func dedupe(xs []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// ArtifactReachable reports whether an artifact row is reachable.
func (r *Reachable) ArtifactReachable(a db.VersioningArtifact) bool {
	return r.Artifacts[a.ID] || r.ArtifactSHAs[a.ContentSha256] || a.LegalHold
}

// UpdateStatuses records reachability on artifact rows: unreachable
// available artifacts become unreferenced (starting their grace period);
// reachable unreferenced ones become available again. Returns the ids newly
// marked unreferenced.
func (c *Collector) UpdateStatuses(ctx context.Context, r *Reachable) ([]string, error) {
	var newly []string
	err := c.DB.InTenantTx(ctx, r.Tenant, func(tx pgx.Tx) error {
		q := db.New(tx)
		arts, err := q.ListArtifacts(ctx)
		if err != nil {
			return err
		}
		for _, a := range arts {
			reach := r.ArtifactReachable(a)
			switch {
			case reach && a.Status == "unreferenced":
				if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: a.ID, Status: "available"}); err != nil {
					return err
				}
			case !reach && a.Status == "available":
				if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: a.ID, Status: "unreferenced"}); err != nil {
					return err
				}
				newly = append(newly, a.ID)
				if err := c.emitUnreferenced(ctx, q, r.Tenant, a); err != nil {
					return err
				}
			}
		}
		return nil
	})
	return newly, err
}

// emitUnreferenced announces that an artifact started its GC grace period.
func (c *Collector) emitUnreferenced(ctx context.Context, q *db.Queries, tenant string, a db.VersioningArtifact) error {
	id := ids.New()
	b, err := json.Marshal(map[string]any{"event_id": id, "event_type": "versioning.artifact.unreferenced", "version": 1,
		"tenant_id": tenant, "repo_id": "", "entity_id": a.ID, "actor_id": "versioning", "occurred_at": c.Now().UTC(),
		"data": map[string]string{"sha256": a.ContentSha256}})
	if err != nil {
		return err
	}
	return q.InsertOutbox(ctx, db.InsertOutboxParams{ID: id, TenantID: tenant, EventType: "versioning.artifact.unreferenced", EntityID: a.ID, Payload: b})
}
