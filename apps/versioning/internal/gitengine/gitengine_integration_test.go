//go:build integration

package gitengine_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/testenv"
)

const tenant = "00000000-0000-0000-0000-000000000002"

var pool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	t := &testing.T{}
	pg := testenv.StartPostgres(ctx, tb{t})
	var err error
	if pool, err = pgxpool.New(ctx, pg.AppURL); err != nil {
		panic(err)
	}
	code := m.Run()
	pool.Close()
	for _, f := range cleanups {
		f()
	}
	os.Exit(code)
}

var cleanups []func()

type tb struct{ *testing.T }

func (tb) Helper()                   {}
func (tb) Cleanup(f func())          { cleanups = append(cleanups, f) }
func (tb) Fatal(a ...any)            { panic(a) }
func (tb) Fatalf(f string, a ...any) { panic(f) }

func snap() gitengine.Snapshot {
	return gitengine.Snapshot{Dataset: gitengine.DatasetDoc{RepoID: "r", SchemaVersion: "1",
		ManifestRoot: "sha256:0000000000000000000000000000000000000000000000000000000000000000", ManifestFormat: "json-v1"},
		Provenance: gitengine.ProvenanceDoc{Operation: "commit", ActorID: "u", ActorKind: "user"}}
}

func chain(t testing.TB, g *gitengine.Repo, n int, parent string) []string {
	out := make([]string, 0, n)
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < n; i++ {
		var parents []string
		if parent != "" {
			parents = []string{parent}
		}
		oid, err := g.WriteCommit(snap(), parents, "u", "c", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, oid)
		parent = oid
	}
	return out
}

func TestMergeBaseAndCrissCross(t *testing.T) {
	ctx := context.Background()
	g := gitengine.New(pool, 1000).Open(ctx, tenant, ids.New())
	root := chain(t, g, 1, "")[0]
	now := time.Unix(1_800_000_000, 0)
	x, _ := g.WriteCommit(snap(), []string{root}, "a", "x", now)
	y, _ := g.WriteCommit(snap(), []string{root}, "b", "y", now.Add(time.Second))
	if b, err := g.MergeBase(x, y); err != nil || b != root {
		t.Fatalf("merge base %s %v", b, err)
	}
	mx, _ := g.WriteCommit(snap(), []string{x, y}, "a", "mx", now.Add(2*time.Second))
	my, _ := g.WriteCommit(snap(), []string{y, x}, "b", "my", now.Add(3*time.Second))
	if _, err := g.MergeBase(mx, my); !errors.Is(err, gitengine.ErrMultipleMergeBases) {
		t.Fatalf("criss-cross: want ErrMultipleMergeBases, got %v", err)
	}
	if ok, _ := g.IsAncestor(root, mx); !ok {
		t.Fatal("root should be an ancestor")
	}
	c, err := g.ReadCommit(mx)
	if err != nil || len(c.Parents) != 2 || c.AuthorID != "a" {
		t.Fatalf("read merge commit: %+v %v", c, err)
	}
}

// BenchmarkWrite10kCommits writes a 10k-commit chain (4 blobs + tree + commit each).
func BenchmarkWrite10kCommits(b *testing.B) {
	ctx := context.Background()
	for i := 0; i < b.N; i++ {
		g := gitengine.New(pool, 100_000).Open(ctx, tenant, ids.New())
		chain(b, g, 10_000, "")
	}
}

// BenchmarkRead10kCommitsCold reads every commit of a 10k chain with a cold cache.
func BenchmarkRead10kCommitsCold(b *testing.B) {
	ctx := context.Background()
	repo := ids.New()
	oids := chain(b, gitengine.New(pool, 100_000).Open(ctx, tenant, repo), 10_000, "")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		g := gitengine.New(pool, 100_000).Open(ctx, tenant, repo)
		for _, o := range oids {
			if _, err := g.ReadCommit(o); err != nil {
				b.Fatal(err)
			}
		}
	}
}

// BenchmarkWalk10kAncestry walks the full ancestry of a 10k chain, cold and warm.
func BenchmarkWalk10kAncestry(b *testing.B) {
	ctx := context.Background()
	repo := ids.New()
	oids := chain(b, gitengine.New(pool, 100_000).Open(ctx, tenant, repo), 10_000, "")
	head := oids[len(oids)-1]
	b.Run("cold", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			g := gitengine.New(pool, 100_000).Open(ctx, tenant, repo)
			if got, err := g.Log(head, 0, 20_000, 20_000); err != nil || len(got) != 10_000 {
				b.Fatal(len(got), err)
			}
		}
	})
	b.Run("warm", func(b *testing.B) {
		g := gitengine.New(pool, 100_000).Open(ctx, tenant, repo)
		_, _ = g.Log(head, 0, 20_000, 20_000)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if got, err := g.Log(head, 0, 20_000, 20_000); err != nil || len(got) != 10_000 {
				b.Fatal(len(got), err)
			}
		}
	})
}
