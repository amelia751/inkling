package merge

import "strings"

// KeyParts splits a conflict key into its kind, id and optional field.
func KeyParts(key string) (kind, id, field string) {
	parts := strings.SplitN(key, ":", 3)
	switch len(parts) {
	case 3:
		return parts[0], parts[1], parts[2]
	case 2:
		return parts[0], parts[1], ""
	default:
		return key, "", ""
	}
}

// Keys returns the stable keys of the given conflicts.
func Keys(cs []ConflictRecord) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Key
	}
	return out
}
