// Package migrations embeds the goose migrations for schema `pipeline` in database studio.
package migrations

import "embed"

// FS holds the *.sql migrations, applied by cmd/migrate.
//
//go:embed *.sql
var FS embed.FS
