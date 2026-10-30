// Package gitengine is the only package that calls go-git (todo4 research
// table: a v6 migration touches this package alone). It writes and reads the
// small metadata commits that describe dataset snapshots.
package gitengine

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/versioning/internal/storage"
)

// Engine opens per-repository Git storers backed by Postgres.
type Engine struct {
	pool  *pgxpool.Pool
	cache *storage.ObjectCache
}

// New returns an Engine sharing one object cache across repositories.
func New(pool *pgxpool.Pool, cacheObjects int) *Engine {
	return &Engine{pool: pool, cache: storage.NewObjectCache(cacheObjects)}
}

// Repo is a handle on one dataset repository's Git objects.
type Repo struct {
	st *storage.GitStorer
}

// Open returns a handle bound to ctx.
func (e *Engine) Open(ctx context.Context, tenant, repoID string) *Repo {
	return &Repo{st: storage.NewGitStorer(ctx, e.pool, e.cache, tenant, repoID)}
}

// Version is the pinned go-git module version, reported by /version.
const Version = "github.com/go-git/go-git/v5 v5.19.3"
