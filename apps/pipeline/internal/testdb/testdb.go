// Package testdb gives integration tests a fresh Postgres database each.
//
// Tests read <envPrefix>PIPELINE_TEST_DATABASE_URL: a Postgres URL whose role may create
// databases (the local compose superuser, or a throwaway container). Without it they skip,
// so `go test ./...` passes on a machine with no Postgres.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/pipeline/internal/config"
)

// Key is the env key (without the prefix) holding the admin URL.
const Key = "PIPELINE_TEST_DATABASE_URL"

// AdminURL returns the configured admin URL, or "" when unset.
func AdminURL() string {
	n, err := config.LoadNaming()
	if err != nil {
		return ""
	}
	return config.Env(n, Key)
}

// New creates a database for t and drops it at cleanup. It skips t when no URL is set.
func New(t testing.TB) string {
	t.Helper()
	admin := AdminURL()
	if admin == "" {
		t.Skipf("set %s (prefixed) to run Postgres-backed tests", Key)
	}
	u, err := Create(context.Background(), admin, "t")
	if err != nil {
		t.Fatalf("testdb: %v", err)
	}
	t.Cleanup(func() { _ = Drop(context.Background(), admin, u) })
	return u
}

// Create makes a fresh database named <prefix>_<random> and returns its URL.
func Create(ctx context.Context, admin, prefix string) (string, error) {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := prefix + "_" + hex.EncodeToString(b)
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		return "", err
	}
	u, err := url.Parse(admin)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}

// Drop removes a database made by Create.
func Drop(ctx context.Context, admin, dbURL string) error {
	u, err := url.Parse(dbURL)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{u.Path[1:]}.Sanitize()+" WITH (FORCE)")
	return err
}
