// Package server is the pipeline's HTTP transport. Milestone 0 serves the probes every
// HTTP service has (AGENTS.md): /healthz (liveness), /readyz (both databases reachable),
// /version (build and engine versions). The private run API (/v1/runs, …) is mounted on
// the same mux by the pipeline workstream.
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime/debug"
	"sync"
	"time"
)

// Check is one readiness dependency.
type Check func(ctx context.Context) error

// Info is what /version reports.
type Info struct {
	GitSHA     string `json:"git_sha"`
	AppVersion string `json:"app_version"` // the workflow package digest (E3)
	ExecutorID string `json:"executor_id"`
	Engine     string `json:"engine"` // engine library and version, from the build info
}

// EngineModule is the engine library's module path.
const EngineModule = "github.com/dbos-inc/dbos-transact-golang"

// EngineVersion reads the linked engine library's version from the build info.
func EngineVersion() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, d := range bi.Deps {
		if d.Path == EngineModule {
			return "dbos-transact-golang " + d.Version
		}
	}
	return "unknown"
}

// New returns the mux with the probes mounted. checks maps a name to a readiness check.
func New(info Info, checks map[string]Check) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		results := map[string]string{}
		var mu sync.Mutex
		var wg sync.WaitGroup
		for name, check := range checks {
			wg.Add(1)
			go func() {
				defer wg.Done()
				st := "ok"
				if err := check(ctx); err != nil {
					st = "unavailable" // never the error text: it can carry hosts or DSNs
				}
				mu.Lock()
				results[name] = st
				mu.Unlock()
			}()
		}
		wg.Wait()
		status, code := "ok", http.StatusOK
		for _, v := range results {
			if v != "ok" {
				status, code = "degraded", http.StatusServiceUnavailable
			}
		}
		writeJSON(w, code, map[string]any{"status": status, "checks": results})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, info)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
