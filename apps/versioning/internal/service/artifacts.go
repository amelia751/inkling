package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"regexp"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

// RevisionMediaType marks annotation-revision artifacts.
const RevisionMediaType = "application/vnd.studio.annotation-revision+json"

var (
	mediaTypeRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.+/-]{0,127}$`)
	sha256RE    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reasonRE    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

// PutArtifact streams bytes into staging. It returns created=false when the
// identical artifact was already registered.
func (s *Service) PutArtifact(ctx context.Context, p *authn.Principal, sha, mediaType string, size int64, body io.Reader) (*db.VersioningArtifact, bool, error) {
	if err := require(p, authn.ScopeWrite); err != nil {
		return nil, false, err
	}
	if !sha256RE.MatchString(sha) {
		return nil, false, errf(http.StatusBadRequest, "bad_request", "sha256 must be 64 lowercase hex characters")
	}
	if !mediaTypeRE.MatchString(mediaType) {
		return nil, false, errf(http.StatusBadRequest, "bad_request", "invalid media type")
	}
	if size < 0 {
		return nil, false, errf(http.StatusLengthRequired, "bad_request", "Content-Length is required")
	}
	if size > s.Cfg.MaxArtifactBytes {
		return nil, false, errf(http.StatusRequestEntityTooLarge, "too_large", "artifact exceeds the size limit")
	}
	var existing *db.VersioningArtifact
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		a, err := q.GetArtifactBySHA(ctx, db.GetArtifactBySHAParams{TenantID: p.TenantID, ContentSha256: sha})
		if err == nil {
			existing = &a
			return nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}); err != nil {
		return nil, false, err
	}
	if existing != nil {
		if existing.Status == "purged" {
			return nil, false, errf(http.StatusGone, "purged", "this content was purged and cannot be re-uploaded")
		}
		if existing.SizeBytes != size {
			return nil, false, errf(http.StatusUnprocessableEntity, "validation_failed", "content length does not match stored artifact")
		}
		if existing.Status != "deleted" {
			_, _ = io.Copy(io.Discard, io.LimitReader(body, size))
			return existing, false, nil
		}
	}
	if err := s.Blobs.PutStaged(ctx, p.TenantID, sha, size, mediaType, body); err != nil {
		if errors.Is(err, storage.ErrHashMismatch) || errors.Is(err, storage.ErrSizeMismatch) {
			return nil, false, errf(http.StatusUnprocessableEntity, "validation_failed", "%v", err)
		}
		return nil, false, err
	}
	var out db.VersioningArtifact
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		if err := q.EnsureTenant(ctx, p.TenantID); err != nil {
			return err
		}
		a, err := q.UpsertStagedArtifact(ctx, db.UpsertStagedArtifactParams{ID: ids.New(), TenantID: p.TenantID,
			ContentSha256: sha, SizeBytes: size, MediaType: mediaType, StorageKey: storage.ObjectKey(p.TenantID, sha),
			CreatedBy: p.Actor.ID, StagedExpiresAt: timePtr(s.Now().Add(s.Cfg.StagedTTL))})
		if err != nil {
			return err
		}
		if a.Status == "deleted" {
			if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: a.ID, Status: "staged"}); err != nil {
				return err
			}
			a.Status = "staged"
		}
		out = a
		return nil
	})
	return &out, true, err
}

// GetArtifact returns artifact metadata.
func (s *Service) GetArtifact(ctx context.Context, p *authn.Principal, sha string) (*db.VersioningArtifact, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out db.VersioningArtifact
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		a, err := q.GetArtifactBySHA(ctx, db.GetArtifactBySHAParams{TenantID: p.TenantID, ContentSha256: sha})
		out = a
		return notFound(err, "artifact")
	})
	return &out, err
}

// PutAnnotationRevision canonicalises and stores a revision document.
func (s *Service) PutAnnotationRevision(ctx context.Context, p *authn.Principal, r *manifests.AnnotationRevision) (string, error) {
	if err := manifests.ValidateRevision(r); err != nil {
		return "", validationErr(err)
	}
	b, ref, err := manifests.EncodeRevision(r)
	if err != nil {
		return "", err
	}
	if _, _, err := s.PutArtifact(ctx, p, manifests.RefHex(ref), RevisionMediaType, int64(len(b)), bytes.NewReader(b)); err != nil {
		return "", err
	}
	return ref, nil
}

// revisionLoader reads annotation revisions for one tenant, verifying hashes.
type revisionLoader struct {
	s      *Service
	tenant string
}

var revisionCache, _ = lru.New[string, *manifests.AnnotationRevision](100_000)

func (s *Service) revisions(tenant string) *revisionLoader {
	return &revisionLoader{s: s, tenant: tenant}
}

// LoadRevision implements semanticdiff.RevisionLoader.
func (l *revisionLoader) LoadRevision(ctx context.Context, ref string) (*manifests.AnnotationRevision, error) {
	key := l.tenant + "/" + ref
	if r, ok := revisionCache.Get(key); ok {
		cp := *r
		return &cp, nil
	}
	h := manifests.RefHex(ref)
	rc, err := l.s.Blobs.Get(ctx, l.tenant, h, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	b, err := io.ReadAll(io.LimitReader(rc, 16<<20))
	if err != nil {
		return nil, err
	}
	if manifests.HashHex(b) != h {
		return nil, errors.New("annotation revision failed hash verification")
	}
	r, err := manifests.DecodeRevision(b)
	if err != nil {
		return nil, err
	}
	revisionCache.Add(key, r)
	cp := *r
	return &cp, nil
}

// storeRevisions persists merged/resolved revisions produced by a merge.
func (s *Service) storeRevisions(ctx context.Context, p *authn.Principal, revs map[string]*manifests.AnnotationRevision) error {
	for ref, r := range revs {
		got, err := s.PutAnnotationRevision(ctx, p, r)
		if err != nil {
			return err
		}
		if got != ref {
			return errors.New("merged revision ref mismatch")
		}
	}
	return nil
}

// Purge deletes the bytes of a withdrawn artifact (todo4 V9). It is gated by
// configuration until the retention ADR is signed off.
func (s *Service) Purge(ctx context.Context, p *authn.Principal, sha, reason, idemKey string) (*db.VersioningArtifact, error) {
	if !s.Cfg.PurgeEnabled {
		return nil, errf(http.StatusForbidden, "disabled", "purge is disabled until the retention ADR is approved")
	}
	if err := require(p, authn.ScopePurge); err != nil {
		return nil, err
	}
	if !reasonRE.MatchString(reason) {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid reason_code")
	}
	k, err := newIdem(zeroRepo, "@op/purge/"+sha, idemKey, map[string]string{"sha": sha, "reason": reason})
	if err != nil {
		return nil, err
	}
	var target db.VersioningArtifact
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		a, err := q.GetArtifactBySHA(ctx, db.GetArtifactBySHAParams{TenantID: p.TenantID, ContentSha256: sha})
		if err != nil {
			return notFound(err, "artifact")
		}
		target = a
		held, err := q.ArtifactHeld(ctx, a.ID)
		if err != nil {
			return err
		}
		if held || a.LegalHold {
			return errf(http.StatusConflict, "legal_hold", "artifact is under legal hold")
		}
		live, err := q.ArtifactLiveReferences(ctx, a.ID)
		if err != nil {
			return err
		}
		if live > 0 {
			return errf(http.StatusConflict, "conflict", "artifact is still referenced by a live branch head or release; withdraw it with a reviewed commit first")
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if target.Status != "purged" {
		if err := s.Blobs.Delete(ctx, p.TenantID, sha); err != nil {
			return nil, err
		}
	}
	return idempotent(ctx, s, p, k, http.StatusOK, func(q *db.Queries, _ pgx.Tx) (*db.VersioningArtifact, error) {
		if err := q.SetArtifactStatus(ctx, db.SetArtifactStatusParams{ID: target.ID, Status: "purged"}); err != nil {
			return nil, err
		}
		if err := s.audit(ctx, q, p, "", "artifact.purged", target.ID, "", map[string]string{"reason_code": reason}); err != nil {
			return nil, err
		}
		target.Status = "purged"
		return &target, nil
	})
}

// CreateLegalHold places a hold on a repository or one artifact.
func (s *Service) CreateLegalHold(ctx context.Context, p *authn.Principal, repoID, sha, reason string) (*db.VersioningLegalHold, error) {
	if err := require(p, authn.ScopeAdmin); err != nil {
		return nil, err
	}
	if !reasonRE.MatchString(reason) {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid reason_code")
	}
	var out db.VersioningLegalHold
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var artifactID *string
		if sha != "" {
			a, err := q.GetArtifactBySHA(ctx, db.GetArtifactBySHAParams{TenantID: p.TenantID, ContentSha256: sha})
			if err != nil {
				return notFound(err, "artifact")
			}
			artifactID = &a.ID
			if err := q.SetLegalHold(ctx, db.SetLegalHoldParams{ID: a.ID, LegalHold: true}); err != nil {
				return err
			}
		}
		h, err := q.InsertLegalHold(ctx, db.InsertLegalHoldParams{ID: ids.New(), TenantID: p.TenantID, RepoID: &repoID,
			ArtifactID: artifactID, ReasonCode: reason, CreatedBy: p.Actor.ID})
		if err != nil {
			return err
		}
		out = h
		return s.audit(ctx, q, p, repoID, "legal_hold.created", h.ID, "", map[string]string{"reason_code": reason})
	})
	return &out, err
}
