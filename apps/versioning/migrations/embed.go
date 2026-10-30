// Package migrations embeds the goose SQL migrations for the versioning schema.
package migrations

import "embed"

// FS holds the migration files.
//
//go:embed *.sql
var FS embed.FS
