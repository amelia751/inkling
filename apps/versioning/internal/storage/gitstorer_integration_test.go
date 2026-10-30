//go:build integration

package storage_test

import (
	"context"
	"testing"

	"github.com/go-git/go-git/v5/storage/test"
	"github.com/jackc/pgx/v5/pgxpool"
	. "gopkg.in/check.v1"

	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/storage"
	"studio.local/versioning/internal/testenv"
)

const tenant = "00000000-0000-0000-0000-000000000001"

var pool *pgxpool.Pool

func TestStorerConformance(t *testing.T) {
	ctx := context.Background()
	pg := testenv.StartPostgres(ctx, t)
	var err error
	pool, err = pgxpool.New(ctx, pg.AppURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	Suite(&storerSuite{})
	TestingT(t)
}

type storerSuite struct {
	test.BaseStorageSuite
}

func (s *storerSuite) SetUpTest(c *C) {
	// A fresh repo id per test gives each test an empty store; the cache is
	// per-test too so no object leaks between cases.
	st := storage.NewGitStorer(context.Background(), pool, storage.NewObjectCache(1024), tenant, ids.New())
	s.BaseStorageSuite = test.NewBaseStorageSuite(st)
}
