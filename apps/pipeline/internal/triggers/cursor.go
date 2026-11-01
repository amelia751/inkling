package triggers

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MemoryCursor keeps the cursor in process (tests; a single short-lived consumer).
type MemoryCursor struct {
	mu sync.Mutex
	v  string
}

func (m *MemoryCursor) Load(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.v, nil
}

func (m *MemoryCursor) Save(_ context.Context, c string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.v = c
	return nil
}

// PGCursor keeps a named feed cursor in the engine database, behind a lease so one
// replica consumes at a time (any number may run; the others wait for the lease). The
// table is engine-adjacent state, like DBOS's own, and is created on first use.
type PGCursor struct {
	Pool  *pgxpool.Pool
	Name  string        // feed name, e.g. "kernel-jobs"
	Owner string        // this replica (executor ID)
	TTL   time.Duration // lease length (default 60s); renewed by every Save
}

// ErrLeaseLost: another replica holds the cursor.
var ErrLeaseLost = errors.New("triggers: cursor lease held by another replica")

const cursorDDL = `CREATE TABLE IF NOT EXISTS trigger_cursors (
	name        text PRIMARY KEY,
	cursor      text NOT NULL DEFAULT '',
	owner       text NOT NULL DEFAULT '',
	lease_until timestamptz NOT NULL DEFAULT 'epoch',
	updated_at  timestamptz NOT NULL DEFAULT now()
)`

func (p *PGCursor) ttl() time.Duration {
	if p.TTL <= 0 {
		return 60 * time.Second // > the feed's 25 s long-poll, so an idle feed keeps its lease
	}
	return p.TTL
}

// Acquire takes or renews the lease. false means another live replica holds it.
func (p *PGCursor) Acquire(ctx context.Context) (bool, error) {
	if _, err := p.Pool.Exec(ctx, cursorDDL); err != nil {
		return false, err
	}
	if _, err := p.Pool.Exec(ctx, `INSERT INTO trigger_cursors (name) VALUES ($1) ON CONFLICT DO NOTHING`, p.Name); err != nil {
		return false, err
	}
	tag, err := p.Pool.Exec(ctx, `UPDATE trigger_cursors SET owner = $2, lease_until = now() + $3::interval
		WHERE name = $1 AND (owner = $2 OR lease_until < now())`, p.Name, p.Owner, p.ttl().String())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Load waits for the lease, then returns the saved cursor.
func (p *PGCursor) Load(ctx context.Context) (string, error) {
	for {
		ok, err := p.Acquire(ctx)
		if err != nil {
			return "", err
		}
		if ok {
			break
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(p.ttl() / 3):
		}
	}
	var c string
	err := p.Pool.QueryRow(ctx, `SELECT cursor FROM trigger_cursors WHERE name = $1`, p.Name).Scan(&c)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return c, err
}

// Save stores the cursor and renews the lease; ErrLeaseLost if it moved.
func (p *PGCursor) Save(ctx context.Context, c string) error {
	tag, err := p.Pool.Exec(ctx, `UPDATE trigger_cursors SET cursor = $3, lease_until = now() + $4::interval, updated_at = now()
		WHERE name = $1 AND owner = $2`, p.Name, p.Owner, c, p.ttl().String())
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}
