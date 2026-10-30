package storage

import (
	"bytes"
	"context"
	"crypto/sha1" // #nosec G505 -- Git object ids are SHA-1 in v1 (todo4 research table)
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/format/index"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/storage"
	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotSupported is returned for go-git features a bare dataset repo never uses.
var ErrNotSupported = errors.New("gitstorer: not supported")

type cacheKey struct {
	repo string
	oid  plumbing.Hash
}

// ObjectCache is a process-wide LRU of immutable Git objects keyed by
// (repo, oid). Objects never change once written, so entries never go stale.
type ObjectCache struct {
	lru *lru.Cache[cacheKey, *plumbing.MemoryObject]
}

// NewObjectCache returns a cache holding at most size objects.
func NewObjectCache(size int) *ObjectCache {
	c, err := lru.New[cacheKey, *plumbing.MemoryObject](size)
	if err != nil {
		panic(err) // only for size <= 0, a programming error
	}
	return &ObjectCache{lru: c}
}

// GitStorer implements go-git's storage.Storer for one repository on top of
// Postgres (todo4 V1). Branch heads in repo_branches stay authoritative; the
// references kept here are a projection for interoperability (spec §4).
type GitStorer struct {
	pool   *pgxpool.Pool
	cache  *ObjectCache
	tenant string
	repo   string
	ctx    context.Context
}

var _ storage.Storer = (*GitStorer)(nil)

// NewGitStorer returns a storer for repo in tenant. ctx bounds every query the
// storer makes; go-git's interfaces carry no context of their own.
func NewGitStorer(ctx context.Context, pool *pgxpool.Pool, cache *ObjectCache, tenant, repo string) *GitStorer {
	return &GitStorer{pool: pool, cache: cache, tenant: tenant, repo: repo, ctx: ctx}
}

// WithContext returns a copy bound to ctx.
func (s *GitStorer) WithContext(ctx context.Context) *GitStorer {
	c := *s
	c.ctx = ctx
	return &c
}

// batch runs the queued statements after scoping the tenant. A pgx batch is
// one round trip and runs in an implicit transaction, so the SET LOCAL
// applies to every statement in it.
func (s *GitStorer) batch(b *pgx.Batch) pgx.BatchResults {
	nb := &pgx.Batch{}
	nb.Queue("SELECT set_config('app.tenant_id', $1, true)", s.tenant)
	nb.QueuedQueries = append(nb.QueuedQueries, b.QueuedQueries...)
	br := s.pool.SendBatch(s.ctx, nb)
	if _, err := br.Exec(); err != nil {
		_ = br.Close()
		return errBatch{err}
	}
	return br
}

type errBatch struct{ err error }

func (e errBatch) Exec() (pgconn.CommandTag, error) { return pgconn.CommandTag{}, e.err }
func (e errBatch) Query() (pgx.Rows, error)         { return nil, e.err }
func (e errBatch) QueryRow() pgx.Row                { return errRow(e) }
func (e errBatch) Close() error                     { return e.err }

type errRow struct{ err error }

func (e errRow) Scan(...any) error { return e.err }

func (s *GitStorer) exec(sql string, args ...any) error {
	b := &pgx.Batch{}
	b.Queue(sql, args...)
	br := s.batch(b)
	_, err := br.Exec()
	if cerr := br.Close(); err == nil {
		err = cerr
	}
	return err
}

func (s *GitStorer) queryRow(dest []any, sql string, args ...any) error {
	b := &pgx.Batch{}
	b.Queue(sql, args...)
	br := s.batch(b)
	err := br.QueryRow().Scan(dest...)
	if cerr := br.Close(); err == nil {
		err = cerr
	}
	return err
}

// ---- EncodedObjectStorer ----

// NewEncodedObject returns an in-memory object to be filled and stored.
func (s *GitStorer) NewEncodedObject() plumbing.EncodedObject { return &plumbing.MemoryObject{} }

// SetEncodedObject stores obj. Writing the same object twice is a no-op.
func (s *GitStorer) SetEncodedObject(obj plumbing.EncodedObject) (plumbing.Hash, error) {
	switch obj.Type() {
	case plumbing.CommitObject, plumbing.TreeObject, plumbing.BlobObject, plumbing.TagObject:
	default:
		return plumbing.ZeroHash, plumbing.ErrInvalidType
	}
	r, err := obj.Reader()
	if err != nil {
		return plumbing.ZeroHash, err
	}
	data, err := io.ReadAll(r)
	_ = r.Close()
	if err != nil {
		return plumbing.ZeroHash, err
	}
	h := obj.Hash()
	err = s.exec(`INSERT INTO versioning.git_objects (tenant_id, repo_id, oid, type, size, data)
		VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (repo_id, oid) DO NOTHING`,
		s.tenant, s.repo, h.String(), int16(obj.Type()), len(data), data)
	if err != nil {
		return plumbing.ZeroHash, fmt.Errorf("store object: %w", err)
	}
	s.cache.lru.Add(cacheKey{s.repo, h}, memObject(obj.Type(), data, h))
	return h, nil
}

// SetEncodedObjects stores several objects in one round trip (one commit's
// blobs, tree and commit object).
func (s *GitStorer) SetEncodedObjects(objs []plumbing.EncodedObject) error {
	b := &pgx.Batch{}
	mems := make([]*plumbing.MemoryObject, 0, len(objs))
	for _, obj := range objs {
		switch obj.Type() {
		case plumbing.CommitObject, plumbing.TreeObject, plumbing.BlobObject, plumbing.TagObject:
		default:
			return plumbing.ErrInvalidType
		}
		r, err := obj.Reader()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(r)
		_ = r.Close()
		if err != nil {
			return err
		}
		h := obj.Hash()
		b.Queue(`INSERT INTO versioning.git_objects (tenant_id, repo_id, oid, type, size, data)
			VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (repo_id, oid) DO NOTHING`,
			s.tenant, s.repo, h.String(), int16(obj.Type()), len(data), data)
		mems = append(mems, memObject(obj.Type(), data, h))
	}
	br := s.batch(b)
	for range objs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return fmt.Errorf("store objects: %w", err)
		}
	}
	if err := br.Close(); err != nil {
		return err
	}
	for _, m := range mems {
		s.cache.lru.Add(cacheKey{s.repo, m.Hash()}, m)
	}
	return nil
}

func memObject(t plumbing.ObjectType, data []byte, h plumbing.Hash) *plumbing.MemoryObject {
	o := &plumbing.MemoryObject{}
	o.SetType(t)
	o.SetSize(int64(len(data)))
	_, _ = o.Write(data)
	_ = h // MemoryObject recomputes the same hash from type+content
	return o
}

// EncodedObject returns the object with hash h, or ErrObjectNotFound when it
// is missing or has a different type than t.
func (s *GitStorer) EncodedObject(t plumbing.ObjectType, h plumbing.Hash) (plumbing.EncodedObject, error) {
	if o, ok := s.cache.lru.Get(cacheKey{s.repo, h}); ok {
		if t != plumbing.AnyObject && o.Type() != t {
			return nil, plumbing.ErrObjectNotFound
		}
		return o, nil
	}
	var typ int16
	var data []byte
	err := s.queryRow([]any{&typ, &data},
		`SELECT type, data FROM versioning.git_objects WHERE repo_id = $1 AND oid = $2`, s.repo, h.String())
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, plumbing.ErrObjectNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load object: %w", err)
	}
	ot := plumbing.ObjectType(typ)
	if !verifyHash(ot, data, h) {
		return nil, fmt.Errorf("gitstorer: object %s failed hash verification", h)
	}
	o := memObject(ot, data, h)
	s.cache.lru.Add(cacheKey{s.repo, h}, o)
	if t != plumbing.AnyObject && ot != t {
		return nil, plumbing.ErrObjectNotFound
	}
	return o, nil
}

func verifyHash(t plumbing.ObjectType, data []byte, h plumbing.Hash) bool {
	hh := sha1.New() // #nosec G401 -- Git object format
	_, _ = fmt.Fprintf(hh, "%s %d\x00", t.Bytes(), len(data))
	hh.Write(data)
	return hex.EncodeToString(hh.Sum(nil)) == h.String()
}

// IterEncodedObjects lists hashes eagerly and loads objects lazily.
func (s *GitStorer) IterEncodedObjects(t plumbing.ObjectType) (storer.EncodedObjectIter, error) {
	sql := `SELECT oid FROM versioning.git_objects WHERE repo_id = $1 ORDER BY oid`
	args := []any{s.repo}
	if t != plumbing.AnyObject {
		sql = `SELECT oid FROM versioning.git_objects WHERE repo_id = $1 AND type = $2 ORDER BY oid`
		args = append(args, int16(t))
	}
	b := &pgx.Batch{}
	b.Queue(sql, args...)
	br := s.batch(b)
	rows, err := br.Query()
	if err != nil {
		_ = br.Close()
		return nil, err
	}
	var hashes []plumbing.Hash
	for rows.Next() {
		var oid string
		if err := rows.Scan(&oid); err != nil {
			rows.Close()
			_ = br.Close()
			return nil, err
		}
		hashes = append(hashes, plumbing.NewHash(oid))
	}
	rows.Close()
	if err := br.Close(); err != nil {
		return nil, err
	}
	return storer.NewEncodedObjectLookupIter(s, t, hashes), nil
}

// HasEncodedObject returns nil when the object exists.
func (s *GitStorer) HasEncodedObject(h plumbing.Hash) error {
	if _, ok := s.cache.lru.Get(cacheKey{s.repo, h}); ok {
		return nil
	}
	var one int
	err := s.queryRow([]any{&one}, `SELECT 1 FROM versioning.git_objects WHERE repo_id = $1 AND oid = $2`, s.repo, h.String())
	if errors.Is(err, pgx.ErrNoRows) {
		return plumbing.ErrObjectNotFound
	}
	return err
}

// EncodedObjectSize returns the object's content length.
func (s *GitStorer) EncodedObjectSize(h plumbing.Hash) (int64, error) {
	if o, ok := s.cache.lru.Get(cacheKey{s.repo, h}); ok {
		return o.Size(), nil
	}
	var size int32
	err := s.queryRow([]any{&size}, `SELECT size FROM versioning.git_objects WHERE repo_id = $1 AND oid = $2`, s.repo, h.String())
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, plumbing.ErrObjectNotFound
	}
	return int64(size), err
}

// AddAlternate is not supported: repositories never share object stores.
func (s *GitStorer) AddAlternate(string) error { return ErrNotSupported }

// ---- ReferenceStorer (projection) ----

// SetReference upserts a reference.
func (s *GitStorer) SetReference(ref *plumbing.Reference) error {
	return s.exec(`INSERT INTO versioning.git_refs (tenant_id, repo_id, name, target) VALUES ($1, $2, $3, $4)
		ON CONFLICT (repo_id, name) DO UPDATE SET target = EXCLUDED.target`,
		s.tenant, s.repo, ref.Name().String(), refTarget(ref))
}

func refTarget(ref *plumbing.Reference) string {
	if ref.Type() == plumbing.SymbolicReference {
		return "ref: " + ref.Target().String()
	}
	return ref.Hash().String()
}

// CheckAndSetReference sets ref only if the stored value still equals old,
// using a single conditional statement.
func (s *GitStorer) CheckAndSetReference(ref, old *plumbing.Reference) error {
	if old == nil {
		return s.SetReference(ref)
	}
	var updated int
	err := s.queryRow([]any{&updated}, `WITH u AS (
			UPDATE versioning.git_refs SET target = $4 WHERE repo_id = $2 AND name = $3 AND target = $5 RETURNING 1
		), i AS (
			INSERT INTO versioning.git_refs (tenant_id, repo_id, name, target)
			SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM versioning.git_refs WHERE repo_id = $2 AND name = $3)
			RETURNING 1
		) SELECT (SELECT count(*) FROM u) + (SELECT count(*) FROM i)`,
		s.tenant, s.repo, ref.Name().String(), refTarget(ref), refTarget(old))
	if err != nil {
		return err
	}
	if updated == 0 {
		return storage.ErrReferenceHasChanged
	}
	return nil
}

// Reference returns the named reference.
func (s *GitStorer) Reference(n plumbing.ReferenceName) (*plumbing.Reference, error) {
	var target string
	err := s.queryRow([]any{&target}, `SELECT target FROM versioning.git_refs WHERE repo_id = $1 AND name = $2`, s.repo, n.String())
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, plumbing.ErrReferenceNotFound
	}
	if err != nil {
		return nil, err
	}
	return plumbing.NewReferenceFromStrings(n.String(), target), nil
}

// IterReferences lists all references.
func (s *GitStorer) IterReferences() (storer.ReferenceIter, error) {
	b := &pgx.Batch{}
	b.Queue(`SELECT name, target FROM versioning.git_refs WHERE repo_id = $1 ORDER BY name`, s.repo)
	br := s.batch(b)
	rows, err := br.Query()
	if err != nil {
		_ = br.Close()
		return nil, err
	}
	var refs []*plumbing.Reference
	for rows.Next() {
		var name, target string
		if err := rows.Scan(&name, &target); err != nil {
			rows.Close()
			_ = br.Close()
			return nil, err
		}
		refs = append(refs, plumbing.NewReferenceFromStrings(name, target))
	}
	rows.Close()
	if err := br.Close(); err != nil {
		return nil, err
	}
	return storer.NewReferenceSliceIter(refs), nil
}

// RemoveReference deletes a reference; removing a missing one is not an error.
func (s *GitStorer) RemoveReference(n plumbing.ReferenceName) error {
	return s.exec(`DELETE FROM versioning.git_refs WHERE repo_id = $1 AND name = $2`, s.repo, n.String())
}

// CountLooseRefs reports the number of references; all are "loose" here.
func (s *GitStorer) CountLooseRefs() (int, error) {
	var n int
	err := s.queryRow([]any{&n}, `SELECT count(*) FROM versioning.git_refs WHERE repo_id = $1`, s.repo)
	return n, err
}

// PackRefs is a no-op: references are rows.
func (s *GitStorer) PackRefs() error { return nil }

// ---- ShallowStorer, IndexStorer ----

// SetShallow stores the shallow commit list.
func (s *GitStorer) SetShallow(commits []plumbing.Hash) error {
	var buf bytes.Buffer
	for _, h := range commits {
		buf.WriteString(h.String())
		buf.WriteByte('\n')
	}
	return s.setAux("shallow", buf.Bytes())
}

// Shallow returns the shallow commit list.
func (s *GitStorer) Shallow() ([]plumbing.Hash, error) {
	data, _, err := s.aux("shallow")
	if err != nil || data == nil {
		return nil, err
	}
	var out []plumbing.Hash
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		if len(line) > 0 {
			out = append(out, plumbing.NewHash(string(line)))
		}
	}
	return out, nil
}

// SetIndex stores the index. Bare repos never call it; kept for conformance.
func (s *GitStorer) SetIndex(idx *index.Index) error {
	var buf bytes.Buffer
	if err := index.NewEncoder(&buf).Encode(idx); err != nil {
		return err
	}
	return s.setAux("index", buf.Bytes())
}

// Index returns the stored index, or an empty version-2 index.
func (s *GitStorer) Index() (*index.Index, error) {
	data, updated, err := s.aux("index")
	if err != nil {
		return nil, err
	}
	if data == nil {
		return &index.Index{Version: 2}, nil
	}
	idx := &index.Index{}
	if err := index.NewDecoder(bytes.NewReader(data)).Decode(idx); err != nil {
		return nil, err
	}
	idx.ModTime = updated
	return idx, nil
}

func (s *GitStorer) setAux(kind string, data []byte) error {
	return s.exec(`INSERT INTO versioning.git_aux (tenant_id, repo_id, kind, data) VALUES ($1, $2, $3, $4)
		ON CONFLICT (repo_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
		s.tenant, s.repo, kind, data)
}

func (s *GitStorer) aux(kind string) ([]byte, time.Time, error) {
	var data []byte
	var updated time.Time
	err := s.queryRow([]any{&data, &updated},
		`SELECT data, updated_at FROM versioning.git_aux WHERE repo_id = $1 AND kind = $2`, s.repo, kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, nil
	}
	return data, updated, err
}

// ---- ConfigStorer, ModuleStorer ----

// SetConfig validates and stores the repository config.
func (s *GitStorer) SetConfig(cfg *config.Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	data, err := cfg.Marshal()
	if err != nil {
		return err
	}
	return s.exec(`INSERT INTO versioning.repo_config (tenant_id, repo_id, data) VALUES ($1, $2, $3)
		ON CONFLICT (repo_id) DO UPDATE SET data = EXCLUDED.data`, s.tenant, s.repo, data)
}

// Config returns the stored config, or a new bare config.
func (s *GitStorer) Config() (*config.Config, error) {
	var data []byte
	err := s.queryRow([]any{&data}, `SELECT data FROM versioning.repo_config WHERE repo_id = $1`, s.repo)
	if errors.Is(err, pgx.ErrNoRows) {
		c := config.NewConfig()
		c.Core.IsBare = true
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	return config.ReadConfig(bytes.NewReader(data))
}

// Module returns a storer for a submodule, namespaced under a derived repo id.
// Dataset repositories never have submodules; this exists for conformance.
func (s *GitStorer) Module(name string) (storage.Storer, error) {
	c := *s
	c.repo = moduleRepoID(s.repo, name)
	return &c, nil
}

func moduleRepoID(repo, name string) string {
	h := sha1.Sum([]byte(repo + "\x00module\x00" + name)) // #nosec G401 -- id derivation, not security
	h[6] = (h[6] & 0x0f) | 0x50
	h[8] = (h[8] & 0x3f) | 0x80
	b := h[:16]
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
