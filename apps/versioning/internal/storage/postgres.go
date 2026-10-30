package storage

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB wraps the pool so every transaction is tenant-scoped for row-level
// security (todo4 1.2): the first statement of each transaction sets
// app.tenant_id with SET LOCAL semantics.
type DB struct {
	Pool *pgxpool.Pool
}

// Open connects to Postgres.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return &DB{Pool: pool}, nil
}

// Close closes the pool.
func (d *DB) Close() { d.Pool.Close() }

// InTenantTx runs fn in a transaction with app.tenant_id set to tenant.
func (d *DB) InTenantTx(ctx context.Context, tenant string, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
		if err := SetTenant(ctx, tx, tenant); err != nil {
			return err
		}
		return fn(tx)
	})
}

// SetTenant applies the RLS tenant to the current transaction.
func SetTenant(ctx context.Context, tx pgx.Tx, tenant string) error {
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenant); err != nil {
		return fmt.Errorf("set tenant: %w", err)
	}
	return nil
}

// IsUniqueViolation reports whether err is a Postgres unique-constraint error.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// IsCheckViolation reports whether err is a Postgres CHECK-constraint error.
func IsCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23514"
}
