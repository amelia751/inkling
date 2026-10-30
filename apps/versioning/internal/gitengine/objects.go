package gitengine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"

	"studio.local/versioning/internal/manifests"
)

// ErrNotFound is returned when a commit is not in the repository.
var ErrNotFound = errors.New("commit not found")

// DatasetDoc is dataset.json: identity, schema version and manifest root.
type DatasetDoc struct {
	RepoID          string `json:"repo_id"`
	SchemaVersion   string `json:"schema_version"`
	ManifestRoot    string `json:"manifest_root"`
	ManifestFormat  string `json:"manifest_format"`
	SampleCount     int    `json:"sample_count"`
	AnnotationCount int    `json:"annotation_count"`
}

// OntologyDoc is ontology.json: a reference to the ontology revision.
type OntologyDoc struct {
	RevisionID string `json:"revision_id"`
	Hash       string `json:"hash"`
}

// PolicyDoc is policy.json: the validation/publish policy revision.
type PolicyDoc struct {
	PolicyID string `json:"policy_id"`
}

// ProvenanceDoc is provenance.json: a small reference, never full logs.
type ProvenanceDoc struct {
	Operation  string   `json:"operation"` // commit | merge | revert | init
	ActorID    string   `json:"actor_id"`
	ActorKind  string   `json:"actor_kind"`
	OnBehalfOf string   `json:"on_behalf_of,omitempty"`
	Tool       string   `json:"tool,omitempty"`
	Inputs     []string `json:"inputs,omitempty"`
	ReviewID   string   `json:"review_id,omitempty"`
}

// Snapshot is the content of one commit's tree.
type Snapshot struct {
	Dataset    DatasetDoc
	Ontology   OntologyDoc
	Policy     PolicyDoc
	Provenance ProvenanceDoc
}

// Commit is a decoded dataset commit.
type Commit struct {
	OID      string
	Parents  []string
	AuthorID string
	Message  string
	When     time.Time
	Snapshot Snapshot
}

// SanitizeMessage strips control characters and caps length. Callers must
// still keep identifiers out of messages (spec §14); this is a backstop.
func SanitizeMessage(m string) string {
	m = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, m)
	if len(m) > 2000 {
		m = m[:2000]
	}
	return strings.TrimSpace(m)
}

func blob(v any) (plumbing.EncodedObject, error) {
	b, err := manifests.Canonical(v)
	if err != nil {
		return nil, err
	}
	o := &plumbing.MemoryObject{}
	o.SetType(plumbing.BlobObject)
	o.SetSize(int64(len(b)))
	if _, err := o.Write(b); err != nil {
		return nil, err
	}
	return o, nil
}

// WriteCommit stores the four pointer blobs, the tree and a commit whose
// author and committer are the actor id (never a name or email, spec §14).
// All six objects go to Postgres in one round trip.
func (r *Repo) WriteCommit(s Snapshot, parents []string, actorID, message string, when time.Time) (string, error) {
	docs := map[string]any{
		"dataset.json": s.Dataset, "ontology.json": s.Ontology,
		"policy.json": s.Policy, "provenance.json": s.Provenance,
	}
	var objs []plumbing.EncodedObject
	var entries []object.TreeEntry
	for name, v := range docs {
		o, err := blob(v)
		if err != nil {
			return "", err
		}
		objs = append(objs, o)
		entries = append(entries, object.TreeEntry{Name: name, Mode: filemode.Regular, Hash: o.Hash()})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	to := &plumbing.MemoryObject{}
	if err := (&object.Tree{Entries: entries}).Encode(to); err != nil {
		return "", err
	}
	objs = append(objs, to)
	sig := object.Signature{Name: actorID, Email: "", When: when.UTC().Truncate(time.Second)}
	c := &object.Commit{Author: sig, Committer: sig, Message: SanitizeMessage(message), TreeHash: to.Hash()}
	for _, p := range parents {
		c.ParentHashes = append(c.ParentHashes, plumbing.NewHash(p))
	}
	co := &plumbing.MemoryObject{}
	if err := c.Encode(co); err != nil {
		return "", err
	}
	objs = append(objs, co)
	if err := r.st.SetEncodedObjects(objs); err != nil {
		return "", err
	}
	return co.Hash().String(), nil
}

func (r *Repo) commitObject(oid string) (*object.Commit, error) {
	c, err := object.GetCommit(r.st, plumbing.NewHash(oid))
	if errors.Is(err, plumbing.ErrObjectNotFound) {
		return nil, ErrNotFound
	}
	return c, err
}

// HasCommit reports whether the commit object exists.
func (r *Repo) HasCommit(oid string) bool {
	_, err := r.commitObject(oid)
	return err == nil
}

// ReadCommit decodes a commit and its snapshot.
func (r *Repo) ReadCommit(oid string) (*Commit, error) {
	c, err := r.commitObject(oid)
	if err != nil {
		return nil, err
	}
	tree, err := c.Tree()
	if err != nil {
		return nil, fmt.Errorf("commit %s tree: %w", oid, err)
	}
	out := &Commit{OID: oid, AuthorID: c.Author.Name, Message: c.Message, When: c.Author.When}
	for _, p := range c.ParentHashes {
		out.Parents = append(out.Parents, p.String())
	}
	read := func(name string, v any) error {
		f, err := tree.File(name)
		if err != nil {
			return fmt.Errorf("commit %s: %s: %w", oid, name, err)
		}
		rd, err := f.Reader()
		if err != nil {
			return err
		}
		defer func() { _ = rd.Close() }()
		b, err := io.ReadAll(rd)
		if err != nil {
			return err
		}
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		return dec.Decode(v)
	}
	s := &out.Snapshot
	for name, v := range map[string]any{"dataset.json": &s.Dataset, "ontology.json": &s.Ontology,
		"policy.json": &s.Policy, "provenance.json": &s.Provenance} {
		if err := read(name, v); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ObjectIDs returns the commit, tree and blob ids of a commit, for
// reconciliation and GC marking.
func (r *Repo) ObjectIDs(oid string) ([]string, error) {
	c, err := r.commitObject(oid)
	if err != nil {
		return nil, err
	}
	ids := []string{oid, c.TreeHash.String()}
	tree, err := c.Tree()
	if err != nil {
		return ids, err
	}
	for _, e := range tree.Entries {
		ids = append(ids, e.Hash.String())
		if err := r.st.HasEncodedObject(e.Hash); err != nil {
			return ids, fmt.Errorf("blob %s: %w", e.Name, err)
		}
	}
	return ids, nil
}
