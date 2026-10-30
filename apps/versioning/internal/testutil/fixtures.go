// Package testutil builds manifests and revisions for tests.
package testutil

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"

	"studio.local/versioning/internal/manifests"
)

// Revisions is an in-memory RevisionLoader.
type Revisions struct {
	mu sync.Mutex
	m  map[string]*manifests.AnnotationRevision
}

// NewRevisions returns an empty loader.
func NewRevisions() *Revisions { return &Revisions{m: map[string]*manifests.AnnotationRevision{}} }

// Put stores r and returns its ref.
func (r *Revisions) Put(rev *manifests.AnnotationRevision) string {
	_, ref, err := manifests.EncodeRevision(rev)
	if err != nil {
		panic(err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *rev
	r.m[ref] = &cp
	return ref
}

// LoadRevision implements semanticdiff.RevisionLoader.
func (r *Revisions) LoadRevision(_ context.Context, ref string) (*manifests.AnnotationRevision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rev, ok := r.m[ref]
	if !ok {
		return nil, fmt.Errorf("revision %s not found", ref)
	}
	cp := *rev
	return &cp, nil
}

// SHA returns a deterministic fake content hash for a label.
func SHA(label string) string {
	s := sha256.Sum256([]byte(label))
	return hex.EncodeToString(s[:])
}

// Sample builds an image sample with one object.
func Sample(id string) manifests.Sample {
	return manifests.Sample{SampleID: id, Modality: "image2d", Width: 100, Height: 100,
		Objects: []manifests.ObjectRef{{Role: "image", SHA256: SHA("img-" + id), SizeBytes: 10, MediaType: "image/png"}}}
}

// Box returns a box2d revision.
func Box(annID, sampleID, class string, x, y, w, h float64) *manifests.AnnotationRevision {
	return &manifests.AnnotationRevision{SchemaVersion: "1", AnnotationID: annID, SampleID: sampleID,
		Kind: manifests.KindBox2D, ClassID: class, OntologyRev: "ont-1", CoordinateFrame: "pixel",
		Status: "submitted", Geometry: manifests.Geometry{Box: []float64{x, y, w, h}},
		Provenance: manifests.Provenance{ActorID: "user-1"}}
}

// Ann builds a manifest entry for rev stored in revs.
func Ann(revs *Revisions, rev *manifests.AnnotationRevision) manifests.Annotation {
	ref := revs.Put(rev)
	return manifests.Annotation{AnnotationID: rev.AnnotationID, RevisionID: "r" + manifests.RefHex(ref)[:20],
		SampleID: rev.SampleID, Kind: rev.Kind, ClassID: rev.ClassID, OntologyRev: rev.OntologyRev, Ref: ref}
}

// Ontology returns a two-class ontology.
func Ontology() manifests.Ontology {
	return manifests.Ontology{RevisionID: "ont-1", Classes: []manifests.OntologyClass{
		{ClassID: "cat", Name: "Cat"}, {ClassID: "dog", Name: "Dog"}}}
}

// Manifest assembles a manifest.
func Manifest(samples []manifests.Sample, anns ...manifests.Annotation) *manifests.Manifest {
	if anns == nil {
		anns = []manifests.Annotation{}
	}
	m := &manifests.Manifest{SchemaVersion: "1", Ontology: Ontology(), Samples: samples, Annotations: anns}
	m.Sort()
	return m
}
