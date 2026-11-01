package service

import (
	"context"
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
)

// CheckoutInput selects a commit (oid, branch or "tag:<name>") and samples.
type CheckoutInput struct {
	Ref         string
	Filter      manifests.Filter
	Cursor      string
	Limit       int
	IncludeURLs bool
}

// SignedObject is one object of a checkout page.
type SignedObject struct {
	SHA256    string
	SizeBytes int64
	Status    string // available | staged | purged | missing
	URL       string
}

// Checkout is one page of a scoped manifest with short-lived signed URLs.
type Checkout struct {
	CommitOID    string
	ManifestRoot string
	Manifest     *manifests.Manifest
	Objects      []SignedObject
	ExpiresAt    time.Time
	BucketsRead  int
	Next         string
}

// MaxCheckoutPage caps samples per checkout page.
const MaxCheckoutPage = 1000

// CreateCheckout resolves the ref, reads only the buckets the filter can
// match, and signs URLs for the objects on the returned page (spec §16D).
func (s *Service) CreateCheckout(ctx context.Context, p *authn.Principal, repoID string, in CheckoutInput) (*Checkout, error) {
	if err := require(p, authn.ScopeCheckout); err != nil {
		return nil, err
	}
	if p.IsPipeline() && in.IncludeURLs {
		// The pipeline reads manifests to build candidates, never object bytes (todo12).
		return nil, errf(http.StatusForbidden, "forbidden", "the pipeline service checks out manifests only (include_urls: false)")
	}
	if !s.Limiter.Allow("checkout", p.Actor.ID, s.Cfg.RateCheckoutPerMin) {
		return nil, errf(http.StatusTooManyRequests, "rate_limited", "checkout rate limit exceeded")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, MaxCheckoutPage)
	offset := 0
	if in.Cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err == nil {
			offset, err = strconv.Atoi(string(b))
		}
		if err != nil || offset < 0 {
			return nil, errf(http.StatusBadRequest, "bad_request", "invalid cursor")
		}
	}
	var oid, rootHash string
	var buckets []int
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		if tag, ok := strings.CutPrefix(in.Ref, "tag:"); ok {
			r, err := q.GetRelease(ctx, db.GetReleaseParams{RepoID: repoID, Tag: tag})
			if err != nil {
				return notFound(err, "release")
			}
			oid, rootHash = r.CommitOid, r.ManifestRoot
		} else {
			if oid, err = resolveRef(ctx, q, repoID, in.Ref); err != nil {
				return err
			}
			c, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: oid})
			if err != nil {
				return err
			}
			rootHash = c.ManifestRoot
		}
		switch {
		case len(in.Filter.SampleIDs) > 0:
			set := map[int]bool{}
			for _, id := range in.Filter.SampleIDs {
				set[manifests.Bucket(id)] = true
			}
			for b := range set {
				buckets = append(buckets, b)
			}
			sort.Ints(buckets)
		case len(in.Filter.Splits) > 0 || len(in.Filter.StudyUIDHashes) > 0:
			bs, err := q.BucketsForFilter(ctx, db.BucketsForFilterParams{RepoID: repoID, RootHash: rootHash,
				Splits: nonNilS(in.Filter.Splits), Studies: nonNilS(in.Filter.StudyUIDHashes)})
			if err != nil {
				return err
			}
			buckets = []int{}
			for _, b := range bs {
				buckets = append(buckets, int(b))
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	root, err := s.Manifests.LoadRoot(ctx, p.TenantID, repoID, rootHash)
	if err != nil {
		return nil, err
	}
	var m *manifests.Manifest
	read := 0
	switch {
	case root.Format == manifests.FormatJSON:
		m, read = root.Full, 1
	case buckets == nil:
		all := make([]int, 0, len(root.Buckets))
		for b := range root.Buckets {
			all = append(all, b)
		}
		m, err = s.Manifests.LoadBuckets(ctx, p.TenantID, repoID, root, all)
		read = len(all)
	default:
		var present []int
		for _, b := range buckets {
			if _, ok := root.Buckets[b]; ok {
				present = append(present, b)
			}
		}
		m, err = s.Manifests.LoadBuckets(ctx, p.TenantID, repoID, root, present)
		read = len(present)
	}
	if err != nil {
		return nil, err
	}
	m = in.Filter.Apply(m)
	pageM, next := pageManifest(m, offset, limit)
	out := &Checkout{CommitOID: oid, ManifestRoot: rootHash, Manifest: pageM, BucketsRead: read, Next: next,
		ExpiresAt: s.Now().Add(s.Cfg.PresignTTL)}
	hashes := pageM.ArtifactHashes()
	err = s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		arts := map[string]db.VersioningArtifact{}
		for i := 0; i < len(hashes); i += artifactBatch {
			rows, err := q.ArtifactsBySHA(ctx, db.ArtifactsBySHAParams{TenantID: p.TenantID, Hashes: hashes[i:min(i+artifactBatch, len(hashes))]})
			if err != nil {
				return err
			}
			for _, r := range rows {
				arts[r.ContentSha256] = r
			}
		}
		for _, h := range hashes {
			a, ok := arts[h]
			o := SignedObject{SHA256: h, Status: "missing"}
			if ok {
				o.SizeBytes = a.SizeBytes
				switch a.Status {
				case "purged", "deleted":
					o.Status = "purged"
				default:
					o.Status = "available"
					if a.Status == "staged" {
						o.Status = "staged"
					}
					if in.IncludeURLs {
						u, err := s.Blobs.PresignGet(ctx, p.TenantID, h, s.Cfg.PresignTTL)
						if err != nil {
							return err
						}
						o.URL = u
					}
				}
			}
			out.Objects = append(out.Objects, o)
		}
		if err := q.InsertLease(ctx, db.InsertLeaseParams{ID: ids.New(), TenantID: p.TenantID, RepoID: repoID, CommitOid: oid,
			RootHash: rootHash, ActorID: p.Actor.ID, ExpiresAt: s.Now().Add(s.Cfg.CheckoutLeaseTTL)}); err != nil {
			return err
		}
		return s.audit(ctx, q, p, repoID, "checkout", oid, oid, map[string]any{
			"samples": len(pageM.Samples), "objects": len(hashes), "buckets_read": read, "signed": in.IncludeURLs})
	})
	return out, err
}

func nonNilS(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

// pageManifest returns samples[offset:offset+limit] and their annotations.
func pageManifest(m *manifests.Manifest, offset, limit int) (*manifests.Manifest, string) {
	out := &manifests.Manifest{SchemaVersion: m.SchemaVersion, Ontology: m.Ontology, Samples: []manifests.Sample{}, Annotations: []manifests.Annotation{}}
	if offset >= len(m.Samples) {
		return out, ""
	}
	end := min(offset+limit, len(m.Samples))
	keep := map[string]bool{}
	for _, smp := range m.Samples[offset:end] {
		keep[smp.SampleID] = true
		out.Samples = append(out.Samples, smp)
	}
	for _, a := range m.Annotations {
		if keep[a.SampleID] {
			out.Annotations = append(out.Annotations, a)
		}
	}
	next := ""
	if end < len(m.Samples) {
		next = base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(end)))
	}
	return out, next
}
