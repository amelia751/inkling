// Package migrate owns the versioning schema lifecycle: role bootstrap,
// goose migrations and River's queue tables, all inside the versioning schema.
package migrate

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver for goose
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"studio.local/versioning/migrations"
)

// Schema is the Postgres schema the service owns (todo4 V2).
const Schema = "versioning"

// Bootstrap creates the owner and app roles and the schema. It needs a
// superuser (or CREATEROLE) connection; in production a DBA runs it once.
// versioning_app gets no BYPASSRLS, so row-level security always applies.
func Bootstrap(ctx context.Context, adminURL, ownerPassword, appPassword string) error {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("connect admin: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	stmts := []string{
		fmt.Sprintf(`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'versioning_owner') THEN
				CREATE ROLE versioning_owner LOGIN PASSWORD %s;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'versioning_app') THEN
				CREATE ROLE versioning_app LOGIN NOBYPASSRLS PASSWORD %s;
			END IF;
		END $$`, quoteLiteral(ownerPassword), quoteLiteral(appPassword)),
		`ALTER ROLE versioning_app NOBYPASSRLS`,
		`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO versioning_owner', current_database()); END $$`,
		`CREATE SCHEMA IF NOT EXISTS versioning AUTHORIZATION versioning_owner`,
		`GRANT USAGE ON SCHEMA versioning TO versioning_app`,
		`ALTER ROLE versioning_app SET search_path = versioning`,
		`ALTER ROLE versioning_owner SET search_path = versioning`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s); err != nil {
			return fmt.Errorf("bootstrap: %w", err)
		}
	}
	return nil
}

func quoteLiteral(s string) string { return "'" + escape(s) + "'" }

func escape(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\'' {
			out = append(out, '\'')
		}
		out = append(out, r)
	}
	return string(out)
}

func gooseProvider(db *sql.DB) (*goose.Provider, error) {
	return goose.NewProvider(goose.DialectPostgres, db, migrations.FS,
		goose.WithTableName(Schema+".goose_db_version"))
}

// Up applies all goose migrations and River's migrations. Run as the owner.
func Up(ctx context.Context, ownerURL string) error {
	db, err := sql.Open("pgx", ownerURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	p, err := gooseProvider(db)
	if err != nil {
		return err
	}
	if _, err := p.Up(ctx); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	pool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	m, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: Schema})
	if err != nil {
		return err
	}
	if _, err := m.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("river migrate: %w", err)
	}
	// River's tables are not tenant data; the app role needs plain DML on them.
	if _, err := pool.Exec(ctx, `DO $$ BEGIN
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'versioning_app') THEN
			GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA versioning TO versioning_app;
			GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA versioning TO versioning_app;
			GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA versioning TO versioning_app;
		END IF; END $$`); err != nil {
		return fmt.Errorf("grant: %w", err)
	}
	return nil
}

// Down rolls back the most recent goose migration.
func Down(ctx context.Context, ownerURL string) error {
	db, err := sql.Open("pgx", ownerURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	p, err := gooseProvider(db)
	if err != nil {
		return err
	}
	_, err = p.Down(ctx)
	return err
}

// Status reports the current goose version.
func Status(ctx context.Context, ownerURL string) (int64, error) {
	db, err := sql.Open("pgx", ownerURL)
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	p, err := gooseProvider(db)
	if err != nil {
		return 0, err
	}
	return p.GetDBVersion(ctx)
}
