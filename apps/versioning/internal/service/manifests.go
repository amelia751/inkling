package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/manifests"
)

// PutManifest validates m, checks every referenced artifact belongs to the
// caller's tenant, stores the manifest and registers its root.
func (s *Service) PutManifest(ctx context.Context, p *authn.Principal, repoID string, m *manifests.Manifest) (*manifests.Written, error) {
	if err := require(p, authn.ScopeWrite); err != nil {
		return nil, err
	}
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error { _, err := s.repo(ctx, q, p, repoID); return err }); err != nil {
		return nil, err
	}
	if m.Samples == nil {
		m.Samples = []manifests.Sample{}
	}
	if m.Annotations == nil {
		m.Annotations = []manifests.Annotation{}
	}
	if err := manifests.Validate(m, s.Cfg.MaxCommitEntries); err != nil {
		return nil, validationErr(err)
	}
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		_, err := s.checkArtifacts(ctx, q, p.TenantID, m)
		return err
	}); err != nil {
		return nil, err
	}
	w, err := s.Manifests.Write(ctx, p.TenantID, repoID, m)
	if err != nil {
		return nil, err
	}
	err = s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error { return s.registerRoot(ctx, q, p, repoID, w) })
	return w, err
}

func validationErr(err error) error {
	var ve *manifests.ValidationError
	if errors.As(err, &ve) {
		return &Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Detail: ve.Error(), Problems: ve.Problems}
	}
	if errors.Is(err, manifests.ErrTooLarge) {
		return errf(http.StatusRequestEntityTooLarge, "too_large", "%v", err)
	}
	return err
}

const artifactBatch = 10_000

// artifactReader is the slice of *db.Queries that checkArtifacts needs; unit
// tests substitute an in-memory fake.
type artifactReader interface {
	ArtifactsBySHA(ctx context.Context, arg db.ArtifactsBySHAParams) ([]db.VersioningArtifact, error)
}

// checkArtifacts verifies referenced hashes are registered for this tenant,
// not purged, and that sample object sizes match. Knowing a hash is never
// enough: a foreign tenant's artifact is simply absent under RLS.
func (s *Service) checkArtifacts(ctx context.Context, q artifactReader, tenant string, m *manifests.Manifest) (map[string]db.VersioningArtifact, error) {
	hashes := m.ArtifactHashes()
	found := make(map[string]db.VersioningArtifact, len(hashes))
	for i := 0; i < len(hashes); i += artifactBatch {
		rows, err := q.ArtifactsBySHA(ctx, db.ArtifactsBySHAParams{TenantID: tenant, Hashes: hashes[i:min(i+artifactBatch, len(hashes))]})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			found[r.ContentSha256] = r
		}
	}
	var missing, purged, size []string
	for _, h := range hashes {
		a, ok := found[h]
		switch {
		case !ok:
			missing = append(missing, h)
		case a.Status == "purged" || a.Status == "deleted":
			purged = append(purged, h)
		}
	}
	for _, smp := range m.Samples {
		for _, o := range smp.Objects {
			if a, ok := found[o.SHA256]; ok && a.SizeBytes != o.SizeBytes {
				size = append(size, smp.SampleID+"/"+o.Role)
			}
		}
	}
	if len(purged) > 0 {
		return nil, &Error{Status: http.StatusGone, Code: "purged", Detail: "manifest references purged artifacts", Problems: cap10(purged)}
	}
	if len(missing)+len(size) > 0 {
		var probs []string
		for _, h := range cap10(missing) {
			probs = append(probs, "artifact not registered for tenant: "+h)
		}
		for _, x := range cap10(size) {
			probs = append(probs, "size_bytes does not match stored artifact: "+x)
		}
		return nil, &Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed",
			Detail: fmt.Sprintf("%d unknown artifacts, %d size mismatches", len(missing), len(size)), Problems: probs}
	}
	return found, nil
}

func cap10(xs []string) []string {
	if len(xs) > 10 {
		return xs[:10]
	}
	return xs
}

// registerRoot records the manifest root, its filter index and the artifacts
// it references. Idempotent.
func (s *Service) registerRoot(ctx context.Context, q *db.Queries, p *authn.Principal, repoID string, w *manifests.Written) error {
	if err := q.InsertManifestRoot(ctx, db.InsertManifestRootParams{TenantID: p.TenantID, RepoID: repoID, RootHash: w.RootHash,
		SchemaVersion: manifests.SchemaVersion, Format: w.Format, ObjectKey: w.ObjectKey,
		SampleCount: int32(w.Samples), AnnotationCount: int32(w.Annots), CreatedBy: p.Actor.ID}); err != nil {
		return err
	}
	has, err := q.HasManifestIndex(ctx, db.HasManifestIndexParams{RepoID: repoID, RootHash: w.RootHash})
	if err != nil || has {
		return err
	}
	const indexBatch = 5000
	for i := 0; i < len(w.Index); i += indexBatch {
		ip := db.InsertManifestIndexParams{TenantID: p.TenantID, RepoID: repoID, RootHash: w.RootHash}
		for _, r := range w.Index[i:min(i+indexBatch, len(w.Index))] {
			lc, _ := json.Marshal(r.LabelCounts)
			ip.Buckets = append(ip.Buckets, int16(r.Bucket))
			ip.Studies = append(ip.Studies, r.StudyUIDHash)
			ip.Series = append(ip.Series, r.SeriesUIDHash)
			ip.Splits = append(ip.Splits, r.Split)
			ip.Counts = append(ip.Counts, int32(r.SampleCount))
			ip.Labels = append(ip.Labels, lc)
		}
		if err := q.InsertManifestIndex(ctx, ip); err != nil {
			return err
		}
	}
	if w.Manifest == nil {
		return nil
	}
	found, err := s.checkArtifacts(ctx, q, p.TenantID, w.Manifest)
	if err != nil {
		return err
	}
	idsList := make([]string, 0, len(found))
	for _, a := range found {
		idsList = append(idsList, a.ID)
	}
	for i := 0; i < len(idsList); i += artifactBatch {
		if err := q.InsertArtifactReferences(ctx, db.InsertArtifactReferencesParams{TenantID: p.TenantID, RepoID: repoID,
			RootHash: w.RootHash, ArtifactIds: idsList[i:min(i+artifactBatch, len(idsList))]}); err != nil {
			return err
		}
	}
	return nil
}

// rootRow loads a registered manifest root of this repo.
func rootRow(ctx context.Context, q *db.Queries, repoID, root string) (db.VersioningManifestRoot, error) {
	r, err := q.GetManifestRoot(ctx, db.GetManifestRootParams{RepoID: repoID, RootHash: root})
	if errors.Is(err, pgx.ErrNoRows) {
		return r, errf(http.StatusUnprocessableEntity, "validation_failed", "manifest root is not registered for this repository")
	}
	return r, err
}
