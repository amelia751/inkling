package authz

import (
	"testing"

	"studio.local/versioning/internal/authn"
)

var (
	pipe = &authn.Principal{Actor: authn.Actor{ID: authn.PipelineActorID, Kind: authn.KindService}, Service: authn.ServicePipeline}
	user = &authn.Principal{Actor: authn.Actor{ID: "user-alice", Kind: authn.KindUser}}
)

func TestPipelineBranches(t *testing.T) {
	for b, ok := range map[string]bool{"pipeline/run_1": true, "main": false, "pipeline/": false, "work/agent-1": false, "pipelinex/run": false} {
		if PipelineBranchAllowed(pipe, b) != ok {
			t.Errorf("%s: want %v", b, ok)
		}
	}
	if !PipelineBranchAllowed(user, "main") {
		t.Fatal("users are unaffected")
	}
}

func TestPipelineCannotApprove(t *testing.T) {
	if err := CanApprove(pipe, "user-bob", ""); err == nil {
		t.Fatal("pipeline approved")
	}
	if err := CanApprove(&authn.Principal{Actor: authn.Actor{ID: authn.PipelineActorID, Kind: authn.KindService}}, "user-bob", ""); err == nil {
		t.Fatal("the pipeline identity approved through another key")
	}
}

func TestPipelineMergeNeedsACurrentApproval(t *testing.T) {
	const src, tgt, old = "s", "t", "o"
	cases := map[string]struct {
		apps []Approval
		ok   bool
	}{
		"unapproved":           {nil, false},
		"approved, current":    {[]Approval{{ReviewerID: "user-bob", SourceOID: src, TargetOID: tgt}}, true},
		"approved, old target": {[]Approval{{ReviewerID: "user-bob", SourceOID: src, TargetOID: old}}, false},
		"approved, old source": {[]Approval{{ReviewerID: "user-bob", SourceOID: "x", TargetOID: tgt}}, false},
		"legacy, no target":    {[]Approval{{ReviewerID: "user-bob", SourceOID: src}}, false},
		"self approval":        {[]Approval{{ReviewerID: authn.PipelineActorID, SourceOID: src, TargetOID: tgt}}, false},
	}
	for name, c := range cases {
		if got := PipelineMergeAllowed(pipe, src, tgt, c.apps); got != c.ok {
			t.Errorf("%s: got %v", name, got)
		}
	}
	if !PipelineMergeAllowed(user, src, tgt, nil) {
		t.Fatal("humans keep the repo's own rules")
	}
}
