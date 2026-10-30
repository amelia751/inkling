//go:build integration

package integration

import (
	"context"
	"fmt"
	"sort"
	"testing"

	"studio.local/versioning/internal/manifests"
)

// Every published version is retrievable and verified (acceptance row 5):
// create several releases, some small (single JSON manifest) and some
// chunked, on main and on a work branch, then iterate every listed release
// and verify its commit, its manifest root (hash-verified load, matching the
// Git snapshot) and the bytes of every object it references.
func TestEveryReleaseVerifies(t *testing.T) {
	e := newEnv(t, with("CHUNK_THRESHOLD", "4"))
	repo, main := e.createRepo("releases")
	type want struct {
		commit  string
		samples []string
		anns    []string
	}
	wants := map[string]want{}
	release := func(tag, commit string, samples []manifests.Sample, anns []manifests.Annotation) {
		e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": tag, "commit_oid": commit},
			"Idempotency-Key", idem()), 201)
		w := want{commit: commit}
		for _, s := range samples {
			w.samples = append(w.samples, s.SampleID)
		}
		for _, a := range anns {
			w.anns = append(w.anns, a.AnnotationID)
		}
		sort.Strings(w.samples)
		sort.Strings(w.anns)
		wants[tag] = w
	}

	release("v0-empty", main, nil, nil)
	samples := []manifests.Sample{e.image("s00", "a"), e.image("s01", "a")}
	anns := []manifests.Annotation{e.ann(box("a1", "s00", "cat", 10))}
	main = e.seed(repo, main, manifest(samples, anns...))
	release("v1", main, samples, anns)

	head := e.branch(repo, "work/grow", main)
	for i := 2; i <= 9; i++ { // crosses the chunk threshold
		samples = append(samples, e.image(fmt.Sprintf("s%02d", i), "a"))
		if i%3 == 0 {
			anns = append(anns, e.ann(box(fmt.Sprintf("a%d", i), samples[i].SampleID, "dog", float64(i))))
		}
		head = e.must(e.commit(alice, repo, "work/grow", head, e.putManifest(repo, manifest(samples, anns...))), 201).str("commit_oid")
		if i%2 == 1 {
			release(fmt.Sprintf("v1.%d-rc", i), head, append([]manifests.Sample(nil), samples...), append([]manifests.Annotation(nil), anns...))
		}
	}
	// Replace one object (new bytes, same sample id) and release again.
	samples[0] = e.image("s00", "b")
	head = e.must(e.commit(alice, repo, "work/grow", head, e.putManifest(repo, manifest(samples, anns...))), 201).str("commit_oid")
	release("v2-rc", head, samples, anns)

	list := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/releases", nil), 200)
	var rels []map[string]any
	if err := jsonArray(list.Raw, &rels); err != nil {
		t.Fatal(err)
	}
	if len(rels) != len(wants) {
		t.Fatalf("listed %d releases, created %d", len(rels), len(wants))
	}
	ctx := context.Background()
	formats := map[string]int{}
	for _, rel := range rels {
		tag, _ := rel["tag"].(string)
		w, ok := wants[tag]
		if !ok {
			t.Fatalf("unexpected release %q", tag)
		}
		if rel["commit_oid"] != w.commit {
			t.Fatalf("release %s pins %v, want %s", tag, rel["commit_oid"], w.commit)
		}
		root, _ := rel["manifest_root"].(string)
		// The release, the commit row and the Git snapshot agree on the root.
		c := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+w.commit, nil), 200)
		if c.str("manifest_root") != root {
			t.Fatalf("release %s root %s, commit row %s", tag, root, c.str("manifest_root"))
		}
		cv, err := e.app.Svc.GetCommit(ctx, e.principal(alice), repo, w.commit)
		if err != nil {
			t.Fatal(err)
		}
		if cv.Commit.Snapshot.Dataset.ManifestRoot != root {
			t.Fatalf("release %s: Git snapshot root %s, want %s", tag, cv.Commit.Snapshot.Dataset.ManifestRoot, root)
		}
		// Hash-verified load of the root and every chunk.
		mr, err := e.app.Svc.Manifests.LoadRoot(ctx, e.tenant, repo, root)
		if err != nil {
			t.Fatalf("release %s root: %v", tag, err)
		}
		formats[mr.Format]++
		m, err := e.app.Svc.Manifests.Load(ctx, e.tenant, repo, root)
		if err != nil {
			t.Fatalf("release %s manifest: %v", tag, err)
		}
		if got := sampleIDs(m); fmt.Sprint(got) != fmt.Sprint(w.samples) {
			t.Fatalf("release %s samples %v, want %v", tag, got, w.samples)
		}
		if got := annotationIDs(m); fmt.Sprint(got) != fmt.Sprint(w.anns) {
			t.Fatalf("release %s annotations %v, want %v", tag, got, w.anns)
		}
		if mr.Format == manifests.FormatJSON {
			if _, h, err := manifests.Encode(m); err != nil || h != root {
				t.Fatalf("release %s: re-encoded manifest hashes to %s, want %s (%v)", tag, h, root, err)
			}
		}
		// The checkout of the tag resolves to the same commit and root, and
		// every signed object's bytes match its hash.
		co := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts", map[string]any{"ref": "tag:" + tag, "limit": 1000}), 200)
		if co.str("commit_oid") != w.commit || co.str("manifest_root") != root {
			t.Fatalf("checkout of %s: commit %s root %s", tag, co.str("commit_oid"), co.str("manifest_root"))
		}
		verifyCheckout(t, e, repo, "tag:"+tag, len(w.samples))
		// The objects signed are exactly the manifest's sample objects and
		// annotation revisions: nothing missing, nothing extra.
		wantObjs := map[string]bool{}
		for _, h := range m.ArtifactHashes() {
			wantObjs[h] = true
		}
		gotObjs := map[string]bool{}
		for _, o := range co.Body["objects"].([]any) {
			sha := o.(map[string]any)["sha256"].(string)
			if !wantObjs[sha] {
				t.Fatalf("release %s checkout signed an object outside its manifest: %s", tag, sha)
			}
			gotObjs[sha] = true
		}
		if len(gotObjs) != len(wantObjs) {
			t.Fatalf("release %s checkout signed %d of %d manifest objects", tag, len(gotObjs), len(wantObjs))
		}
	}
	if formats[manifests.FormatJSON] == 0 || formats[manifests.FormatChunked] == 0 {
		t.Fatalf("want both manifest formats among releases, got %v", formats)
	}
}

func sampleIDs(m *manifests.Manifest) []string {
	out := []string{}
	for _, s := range m.Samples {
		out = append(out, s.SampleID)
	}
	sort.Strings(out)
	return out
}

func annotationIDs(m *manifests.Manifest) []string {
	out := []string{}
	for _, a := range m.Annotations {
		out = append(out, a.AnnotationID)
	}
	sort.Strings(out)
	return out
}
