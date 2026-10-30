// Package ids generates opaque, time-sortable identifiers: ULIDs rendered in
// UUID form so they fit Postgres uuid columns and sort by creation time.
package ids

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"

	"github.com/oklog/ulid/v2"
)

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// New returns a new ULID formatted as a lowercase UUID string.
func New() string {
	id := ulid.MustNew(ulid.Now(), rand.Reader)
	b := id[:]
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Valid reports whether s is a canonical lowercase UUID string.
func Valid(s string) bool { return uuidRE.MatchString(strings.ToLower(s)) && s == strings.ToLower(s) }
