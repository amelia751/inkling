package dbos_test

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"studio.local/pipeline/internal/engine"
	enginedbos "studio.local/pipeline/internal/engine/dbos"
	"studio.local/pipeline/internal/engine/enginetest"
	"studio.local/pipeline/internal/testdb"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestConformance(t *testing.T) {
	enginetest.Run(t, enginetest.Harness{
		NewDB: func(t testing.TB) string { return testdb.New(t) },
		New: func(t testing.TB, db, ver, exec string) (engine.Engine, error) {
			return enginedbos.New(context.Background(), enginedbos.Options{
				DatabaseURL: db, AppVersion: ver, ExecutorID: exec, PoolMax: 10, Logger: quietLogger(),
			})
		},
	})
}

func TestRequiresOurConfig(t *testing.T) {
	if _, err := enginedbos.New(context.Background(), enginedbos.Options{DatabaseURL: "postgres://x/y"}); err == nil {
		t.Fatal("want an error without an app version and executor ID")
	}
}
