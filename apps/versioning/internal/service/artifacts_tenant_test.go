package service

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/manifests"
)

// fakeArtifacts is an in-memory artifacts table holding rows of several
// tenants. Like the real query (WHERE tenant_id = $1, plus RLS) it only
// returns rows of the requested tenant.
type fakeArtifacts []db.VersioningArtifact

func (f fakeArtifacts) ArtifactsBySHA(_ context.Context, arg db.ArtifactsBySHAParams) ([]db.VersioningArtifact, error) {
	want := map[string]bool{}
	for _, h := range arg.Hashes {
		want[h] = true
	}
	var out []db.VersioningArtifact
	for _, a := range f {
		if a.TenantID == arg.TenantID && want[a.ContentSha256] {
			out = append(out, a)
		}
	}
	return out, nil
}

func art(tenant, sha string, size int64, status string) db.VersioningArtifact {
	return db.VersioningArtifact{ID: tenant[:8] + "-" + sha[:8], TenantID: tenant, ContentSha256: sha, SizeBytes: size,
		MediaType: "image/png", Status: status}
}

func manifestWith(objs ...manifests.ObjectRef) *manifests.Manifest {
	m := &manifests.Manifest{SchemaVersion: "1"}
	for i, o := range objs {
		m.Samples = append(m.Samples, manifests.Sample{SampleID: "s" + string(rune('a'+i)), Modality: "image2d", Objects: []manifests.ObjectRef{o}})
	}
	return m
}

func obj(sha string, size int64) manifests.ObjectRef {
	return manifests.ObjectRef{Role: "image", SHA256: sha, SizeBytes: size, MediaType: "image/png"}
}

func TestCheckArtifactsOwnTenant(t *testing.T) {
	own := sha64("own")
	store := fakeArtifacts{art(tenantA, own, 10, "available")}
	found, err := (&Service{}).checkArtifacts(context.Background(), store, tenantA, manifestWith(obj(own, 10)))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := found[own]; !ok || len(found) != 1 {
		t.Fatalf("found %v", found)
	}
}

// Knowing another tenant's content hash is not enough to reference it
// (spec §2; acceptance row 8): the artifact is treated as unregistered.
func TestCheckArtifactsRejectsForeignTenant(t *testing.T) {
	own, foreign := sha64("own"), sha64("foreign")
	store := fakeArtifacts{art(tenantA, own, 10, "available"), art(tenantB, foreign, 10, "available")}
	for name, m := range map[string]*manifests.Manifest{
		"sample object": manifestWith(obj(own, 10), obj(foreign, 10)),
		"annotation ref": {SchemaVersion: "1", Samples: manifestWith(obj(own, 10)).Samples,
			Annotations: []manifests.Annotation{{AnnotationID: "a1", SampleID: "sa", Ref: "sha256:" + foreign}}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := (&Service{}).checkArtifacts(context.Background(), store, tenantA, m)
			e, ok := AsError(err)
			if !ok || e.Status != http.StatusUnprocessableEntity || e.Code != "validation_failed" {
				t.Fatalf("want 422 validation_failed, got %v", err)
			}
			if len(e.Problems) != 1 || !strings.Contains(e.Problems[0], "not registered for tenant: "+foreign) {
				t.Fatalf("problems: %v", e.Problems)
			}
		})
	}
	// The same hash is fine for the tenant that owns it.
	if _, err := (&Service{}).checkArtifacts(context.Background(), store, tenantB, manifestWith(obj(foreign, 10))); err != nil {
		t.Fatalf("owner rejected: %v", err)
	}
}

func TestCheckArtifactsPurgedAndSize(t *testing.T) {
	gone, ok := sha64("gone"), sha64("ok")
	store := fakeArtifacts{art(tenantA, gone, 10, "purged"), art(tenantA, ok, 10, "available")}
	_, err := (&Service{}).checkArtifacts(context.Background(), store, tenantA, manifestWith(obj(gone, 10)))
	if e, isErr := AsError(err); !isErr || e.Status != http.StatusGone || e.Code != "purged" {
		t.Fatalf("purged: want 410, got %v", err)
	}
	_, err = (&Service{}).checkArtifacts(context.Background(), store, tenantA, manifestWith(obj(ok, 11)))
	if e, isErr := AsError(err); !isErr || e.Status != http.StatusUnprocessableEntity || !strings.Contains(e.Problems[0], "size_bytes") {
		t.Fatalf("size mismatch: want 422, got %v", err)
	}
}
