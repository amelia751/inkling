package service

import (
	"strings"
	"testing"
)

func TestValidateStudio(t *testing.T) {
	lock := `{"lockfileVersion":1,"plugins":[]}`
	env := `{"extends":"preset:x","task":"t"}`
	structure := `{"annotations":[],"collections":[],"relationships":[],"schemaVersion":1}`
	ok := map[string]string{"plugins.lock.json": lock, "structure.json": structure, "tasks/ws-a/environment.json": env, "tasks/ws-a/README.md": "# Notes\n"}
	files, err := validateStudio(&StudioInput{Files: ok})
	if err != nil || len(files) != 4 || string(files["tasks/ws-a/environment.json"]) != env {
		t.Fatalf("valid tree refused: %v %v", files, err)
	}
	if f, err := validateStudio(nil); f != nil || err != nil {
		t.Fatalf("nil input: %v %v", f, err)
	}
	if f, err := validateStudio(&StudioInput{Files: map[string]string{}}); err != nil || f == nil || len(f) != 0 {
		t.Fatalf("empty input must be an empty (non-nil) tree: %v %v", f, err)
	}
	bad := map[string]map[string]string{
		"unknown path":            {"secrets.env": "x"},
		"traversal":               {"tasks/../plugins.lock.json": lock},
		"nested task path":        {"tasks/a/b/environment.json": env},
		"not json":                {"plugins.lock.json": "{nope"},
		"not canonical":           {"tasks/a/environment.json": `{"task":"t", "extends":"preset:x"}`},
		"unsorted keys":           {"tasks/a/environment.json": `{"task":"t","extends":"preset:x"}`},
		"too large":               {"tasks/a/README.md": strings.Repeat("x", maxStudioFileBytes+1)},
		"leading-dot task":        {"tasks/.x/environment.json": env},
		"absolute path":           {"/plugins.lock.json": lock},
		"nested structure":        {"tasks/a/structure.json": structure},
		"structure not canonical": {"structure.json": `{"schemaVersion":1, "collections":[]}`},
	}
	for name, files := range bad {
		if _, err := validateStudio(&StudioInput{Files: files}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestMergeStudio(t *testing.T) {
	cases := []struct{ base, target, source, want string }{
		{"a", "a", "a", "a"},
		{"a", "b", "a", "b"}, // only the target changed
		{"a", "a", "c", "c"}, // only the source changed
		{"a", "b", "c", "c"}, // both: the reviewed change wins
		{"", "", "c", "c"},   // the source adds a Studio
		{"a", "a", "", ""},   // the source removes it
	}
	for _, c := range cases {
		if got := mergeStudio(c.base, c.target, c.source); got != c.want {
			t.Errorf("mergeStudio(%q,%q,%q) = %q, want %q", c.base, c.target, c.source, got, c.want)
		}
	}
}
