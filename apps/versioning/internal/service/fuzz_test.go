package service

import (
	"strings"
	"testing"
)

// FuzzBranchName: anything accepted is a safe ref component.
func FuzzBranchName(f *testing.F) {
	for _, s := range []string{"main", "work/a/b", "HEAD", "a..b", "a@{1}", "x.lock", "a//b", "\x00", "../../etc"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if ValidateBranchName(s) != nil {
			return
		}
		if strings.Contains(s, "..") || strings.Contains(s, "//") || strings.Contains(s, "@{") ||
			strings.HasSuffix(s, ".lock") || strings.HasSuffix(s, "/") || strings.EqualFold(s, "head") ||
			strings.ContainsAny(s, " \t\n\x00~^:?*[\\") || len(s) > 128 || s == "" || strings.HasPrefix(s, "/") {
			t.Fatalf("unsafe branch name accepted: %q", s)
		}
	})
}
