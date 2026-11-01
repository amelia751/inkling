package server

import (
	"net/http"
	"regexp"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/service"
)

// pipelineRoutes is everything the pipeline service may call (todo12
// Milestone 1): read what it needs, stage artifacts and manifests, create
// branches and commits, open reviews and merge them. The service layer then
// confines writes to pipeline/* branches and merges to reviews with a current
// approval. Every other route is 403 for it, the way kernel/agent_scope.py
// fences agents in apps/api.
var pipelineRoutes = []struct {
	method string
	path   *regexp.Regexp
}{
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+/branches$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/branches$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/artifacts/[0-9a-f]{64}$`)},
	{http.MethodHead, regexp.MustCompile(`^/internal/v1/artifacts/[0-9a-f]{64}$`)},
	{http.MethodPut, regexp.MustCompile(`^/internal/v1/artifacts/[0-9a-f]{64}$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/annotation-revisions$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/manifests$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+/commits$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/commits$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+/commits/[0-9a-f]{40}$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+/reviews$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/reviews$`)},
	{http.MethodGet, regexp.MustCompile(`^/internal/v1/repos/[^/]+/reviews/[^/]+$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/reviews/[^/]+/publish$`)},
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/reviews/[^/]+/merge$`)},
	// Manifest-only: the service refuses the pipeline a checkout with signed URLs.
	{http.MethodPost, regexp.MustCompile(`^/internal/v1/repos/[^/]+/checkouts$`)},
}

// PipelineAllowed reports whether the pipeline service may call method path.
func PipelineAllowed(method, path string) bool {
	for _, r := range pipelineRoutes {
		if r.method == method && r.path.MatchString(path) {
			return true
		}
	}
	return false
}

func pipelineScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := authn.FromContext(r.Context()); p.IsPipeline() && !PipelineAllowed(r.Method, r.URL.Path) {
			writeProblem(w, r, &service.Error{Status: http.StatusForbidden, Code: "forbidden", Detail: "not available to the pipeline service"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
