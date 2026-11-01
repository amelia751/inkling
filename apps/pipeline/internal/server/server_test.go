package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func get(t *testing.T, h http.Handler, path string) (int, map[string]any) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return rr.Code, body
}

func TestProbes(t *testing.T) {
	ok := func(context.Context) error { return nil }
	bad := func(context.Context) error { return errors.New("dial tcp 10.0.0.5:5432: secret-host") }
	h := New(Info{GitSHA: "abc", AppVersion: "sha256:wf", ExecutorID: "pipeline-0", Engine: EngineVersion()},
		map[string]Check{"database": ok, "engine_database": ok})
	if code, b := get(t, h, "/healthz"); code != 200 || b["status"] != "ok" {
		t.Fatalf("healthz %d %v", code, b)
	}
	if code, b := get(t, h, "/readyz"); code != 200 || b["status"] != "ok" {
		t.Fatalf("readyz %d %v", code, b)
	}
	if code, b := get(t, h, "/version"); code != 200 || b["app_version"] != "sha256:wf" || b["git_sha"] != "abc" {
		t.Fatalf("version %d %v", code, b)
	}
	h = New(Info{}, map[string]Check{"database": ok, "engine_database": bad})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rr.Code != http.StatusServiceUnavailable || strings.Contains(rr.Body.String(), "secret-host") {
		t.Fatalf("degraded readyz %d %s", rr.Code, rr.Body.String())
	}
}
