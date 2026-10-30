// Command gc sweeps unreachable objects. It is dry-run unless --apply is
// given AND GC_SWEEP_ENABLED is true (gated until retention is signed off,
// todo4 V9).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"studio.local/versioning/internal/app"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/observability"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gc:", err)
		os.Exit(1)
	}
}

func run() error {
	apply := flag.Bool("apply", false, "delete instead of planning")
	tenant := flag.String("tenant", "", "limit to one tenant id")
	flag.Parse()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if *apply && !cfg.GCSweepEnable {
		return fmt.Errorf("--apply refused: GC_SWEEP_ENABLED is false")
	}
	ctx := context.Background()
	a, err := app.Build(ctx, cfg, observability.Logger(), app.Options{})
	if err != nil {
		return err
	}
	defer a.Close()
	tenants := []string{*tenant}
	if *tenant == "" {
		rows, err := a.DB.Pool.Query(ctx, "SELECT id FROM versioning.tenants ORDER BY id")
		if err != nil {
			return err
		}
		tenants = nil
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err != nil {
				return err
			}
			tenants = append(tenants, t)
		}
		rows.Close()
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	for _, t := range tenants {
		plan, err := a.GC.Sweep(ctx, t, cfg.GCGrace, !*apply)
		if err != nil {
			return err
		}
		if err := enc.Encode(plan); err != nil {
			return err
		}
	}
	return nil
}
