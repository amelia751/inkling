// Command migrate applies the pipeline's migrations (the pipeline-migrate Job):
//
//	migrate up      goose migrations for schema `pipeline` in studio, then DBOS's system tables in pipeline_engine
//	migrate status  goose status
//
// It reads only PIPELINE_DATABASE_URL and PIPELINE_ENGINE_DATABASE_URL (config.LoadMigrate).
package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver "pgx" for goose
	"github.com/pressly/goose/v3"

	"studio.local/pipeline/internal/config"
	enginedbos "studio.local/pipeline/internal/engine/dbos"
	"studio.local/pipeline/migrations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 || (os.Args[1] != "up" && os.Args[1] != "status") {
		return fmt.Errorf("usage: migrate up|status")
	}
	cfg, err := config.LoadMigrate()
	if err != nil {
		return err
	}
	db, err := sql.Open("pgx", cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	goose.SetBaseFS(migrations.FS)
	goose.SetTableName("pipeline.goose_db_version")
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if os.Args[1] == "status" {
		return goose.StatusContext(ctx, db, ".")
	}
	// The version table lives in the schema it versions.
	if _, err := db.ExecContext(ctx, "CREATE SCHEMA IF NOT EXISTS pipeline"); err != nil {
		return fmt.Errorf("schema: %w", err)
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return err
	}
	// DBOS creates and migrates its system tables when it connects.
	eng, err := enginedbos.New(ctx, enginedbos.Options{DatabaseURL: cfg.EngineDatabaseURL, AppVersion: "migrate",
		ExecutorID: "migrate", PoolMax: 2, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		return err
	}
	return eng.Shutdown(5 * time.Second)
}
