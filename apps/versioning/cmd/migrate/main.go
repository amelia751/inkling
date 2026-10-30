// Command migrate manages the versioning schema (the versioning-migrate Job).
//
//	migrate bootstrap   # superuser: roles + schema (VERSIONING_ADMIN_DATABASE_URL)
//	migrate up|down|status
package main

import (
	"context"
	"fmt"
	"os"

	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/migrate"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
}

func env(naming config.Naming, key string) (string, error) {
	k := naming.EnvPrefix + "VERSIONING_" + key
	v := os.Getenv(k)
	if v == "" {
		return "", fmt.Errorf("missing: %s", k)
	}
	return v, nil
}

func run(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: migrate bootstrap|up|down|status")
	}
	naming, err := config.LoadNaming()
	if err != nil {
		return err
	}
	ctx := context.Background()
	if args[0] == "bootstrap" {
		admin, err := env(naming, "ADMIN_DATABASE_URL")
		if err != nil {
			return err
		}
		ownerPW, err := env(naming, "OWNER_PASSWORD")
		if err != nil {
			return err
		}
		appPW, err := env(naming, "APP_PASSWORD")
		if err != nil {
			return err
		}
		return migrate.Bootstrap(ctx, admin, ownerPW, appPW)
	}
	owner, err := env(naming, "MIGRATE_DATABASE_URL")
	if err != nil {
		return err
	}
	switch args[0] {
	case "up":
		return migrate.Up(ctx, owner)
	case "down":
		return migrate.Down(ctx, owner)
	case "status":
		v, err := migrate.Status(ctx, owner)
		if err != nil {
			return err
		}
		fmt.Println("schema version:", v)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
