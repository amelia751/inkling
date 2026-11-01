package server

import "testing"

func TestPipelineRouteAllowlist(t *testing.T) {
	const repo = "/internal/v1/repos/33333333-3333-4333-8333-333333333333"
	const review = repo + "/reviews/44444444-4444-4444-8444-444444444444"
	allowed := [][2]string{
		{"GET", repo}, {"POST", repo + "/branches"}, {"POST", repo + "/manifests"}, {"POST", repo + "/commits"},
		{"POST", repo + "/reviews"}, {"GET", review}, {"POST", review + "/merge"}, {"POST", review + "/publish"}, {"POST", repo + "/checkouts"},
	}
	denied := [][2]string{
		{"POST", "/internal/v1/repos"}, {"DELETE", repo + "/branches"}, {"POST", repo + "/reverts"},
		{"POST", review + "/approve"}, {"POST", review + "/close"}, {"POST", review + "/checks/deidentification"},
		{"POST", review + "/resolutions"}, {"POST", repo + "/releases"}, {"DELETE", repo + "/releases/v1"},
		{"POST", repo + "/legal-holds"}, {"POST", "/internal/v1/artifacts/" + "ab/purge"},
	}
	for _, r := range allowed {
		if !PipelineAllowed(r[0], r[1]) {
			t.Errorf("%s %s should be allowed", r[0], r[1])
		}
	}
	for _, r := range denied {
		if PipelineAllowed(r[0], r[1]) {
			t.Errorf("%s %s should be denied", r[0], r[1])
		}
	}
}
