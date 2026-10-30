// Command reconcile runs one reconciliation pass (the hourly CronJob) and
// prints the findings as JSON. Exit code 2 means something pages.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"studio.local/versioning/internal/app"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/observability"
)

func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reconcile:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run() (int, error) {
	cfg, err := config.Load()
	if err != nil {
		return 1, err
	}
	ctx := context.Background()
	a, err := app.Build(ctx, cfg, observability.Logger(), app.Options{})
	if err != nil {
		return 1, err
	}
	defer a.Close()
	findings, err := a.Reconcile.RunOnce(ctx)
	if err != nil {
		return 1, err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(findings); err != nil {
		return 1, err
	}
	for _, f := range findings {
		if f.Severity == "page" {
			return 2, nil
		}
	}
	return 0, nil
}
