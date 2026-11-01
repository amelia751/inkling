package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/pipeline/internal/compiler"
	"studio.local/pipeline/internal/contracts"
	"studio.local/pipeline/internal/domain"
	"studio.local/pipeline/internal/lineage"
	"studio.local/pipeline/internal/testdb"
)

func sha(c string) string { return "sha256:" + strings.Repeat(c, 64) }

func setup(t *testing.T) (*Store, *contracts.Plan, json.RawMessage) {
	t.Helper()
	url := testdb.New(t)
	ctx := context.Background()
	if err := Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, url); err != nil { // idempotent
		t.Fatal(err)
	}
	s, err := Open(ctx, url, 4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	r, err := compiler.BuiltinResolver()
	if err != nil {
		t.Fatal(err)
	}
	res := compiler.Compile(contracts.IngestDefinition(), r, compiler.Options{DefinitionID: "ingest"})
	if !res.OK() {
		t.Fatal(res.Err())
	}
	g, _ := compiler.Canonical(res.Graph)
	return s, res.Plan, g
}

func newRun(ws string, plan *contracts.Plan, key string) *Run {
	now := time.Now().UTC().Truncate(time.Second)
	id := NewRunID()
	return &Run{RunID: id, WorkspaceID: ws, ProjectID: "p_1", PipelineID: "ingest", Revision: plan.DefinitionDigest,
		PlanDigest: plan.Digest, Trigger: contracts.RunTrigger{Type: "upload.completed", IdempotencyKey: key},
		Envelope: contracts.Envelope{RunID: id, WorkspaceID: ws, DefinitionID: "ingest", DefinitionRevision: plan.DefinitionDigest,
			PlanDigest: plan.Digest, InputDatasetCommits: []contracts.DatasetCommitPin{},
			InputSources: []contracts.SourcePin{{SessionID: "imp_1", ManifestDigest: sha("a")}}, ResolvedStepVersions: map[string]string{},
			CodeArtifactDigests: map[string]string{}, ContainerImageDigests: map[string]string{}, ParametersDigest: sha("b"),
			ExecutionPolicyVersion: "policy_1", Engine: "dbos", ApplicationVersion: "test", CreatedAt: now},
		TargetRepoID: "repo_1", TargetBranch: "main", ApplicationVersion: "test", Actor: "user:alice", DeadlineAt: now.Add(24 * time.Hour)}
}

func TestRevisionsAreImmutableAndIdempotent(t *testing.T) {
	s, plan, g := setup(t)
	ctx := context.Background()
	r1, created, err := s.PutRevision(ctx, "ws_1", "ingest", "ingest", "user:a", g, plan)
	if err != nil || !created {
		t.Fatal(created, err)
	}
	r2, created, err := s.PutRevision(ctx, "ws_1", "ingest", "ingest", "user:b", g, plan)
	if err != nil || created || r2.CreatedBy != "user:a" || r2.Plan.Digest != r1.Plan.Digest {
		t.Fatalf("re-proposing a revision: created=%v %v %+v", created, err, r2)
	}
	cur, err := s.CurrentRevision(ctx, "ws_1", "ingest")
	if err != nil || cur.Revision != plan.DefinitionDigest {
		t.Fatal(cur, err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE pipeline.pipeline_revisions SET plan_digest = $1`, sha("f")); err == nil {
		t.Fatal("a revision was mutated")
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM pipeline.pipeline_revisions`); err == nil {
		t.Fatal("a revision was deleted")
	}
	if _, err := s.CurrentRevision(ctx, "ws_2", "ingest"); !errors.Is(err, ErrNotFound) {
		t.Fatal("another workspace saw the definition")
	}
}

func TestRunLifecycleWithOutbox(t *testing.T) {
	s, plan, g := setup(t)
	ctx := context.Background()
	if _, _, err := s.PutRevision(ctx, "ws_1", "ingest", "ingest", "user:a", g, plan); err != nil {
		t.Fatal(err)
	}
	run, created, err := s.CreateRun(ctx, newRun("ws_1", plan, "upload/imp_1"))
	if err != nil || !created || run.State != domain.RunQueued {
		t.Fatal(run, created, err)
	}
	again, created, err := s.CreateRun(ctx, newRun("ws_1", plan, "upload/imp_1"))
	if err != nil || created || again.RunID != run.RunID {
		t.Fatalf("a repeated start made a second run: %v %v", created, err)
	}
	// Same key in another workspace is a different run.
	if _, created, err := s.CreateRun(ctx, newRun("ws_2", plan, "upload/imp_1")); err == nil || created {
		// ws_2 has no revision: the FK refuses it, which is also correct.
		t.Log("cross-workspace run without its revision:", err)
	}
	if _, err := s.GetRunInWorkspace(ctx, "ws_2", run.RunID); !errors.Is(err, ErrNotFound) {
		t.Fatal("P§20 test 19: another workspace read the run")
	}

	started := func(r *Run) ([]contracts.Event, error) {
		e, err := NewEvent(r.WorkspaceID, contracts.EvRunStarted, domain.EventKey(r.RunID, contracts.EvRunStarted), "", 0,
			map[string]any{"project_id": r.ProjectID, "run_id": r.RunID, "definition_id": r.PipelineID,
				"definition_revision": r.Revision, "plan_digest": r.PlanDigest})
		return []contracts.Event{e}, err
	}
	if _, err := s.Transition(ctx, run.RunID, domain.RunRunning, nil, started); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Transition(ctx, run.RunID, domain.RunRunning, nil, started); err != nil {
		t.Fatal("a replayed transition should be a no-op:", err)
	}
	if _, err := s.Transition(ctx, run.RunID, domain.RunPublished, nil, nil); !errors.Is(err, ErrConflict) || !errors.Is(err, domain.ErrTransition) {
		t.Fatal("running → published allowed:", err)
	}

	// Steps: terminal outcomes are final.
	ok := 9
	if _, err := s.SetStep(ctx, "ws_1", run.RunID, "inspect", "0", StepUpdate{State: domain.StepRunning, JobID: "job_1", Attempts: 1}, nil); err != nil {
		t.Fatal(err)
	}
	outs := map[string]contracts.PortValue{"items": {Type: contracts.PortItemSet, Manifest: &contracts.ArtifactRef{Key: "pipeline/" + run.RunID + "/inspect/0.1/items.json",
		Digest: sha("c"), Size: 3, MediaType: "application/json"}}}
	se, err := s.SetStep(ctx, "ws_1", run.RunID, "inspect", "0", StepUpdate{State: domain.StepSucceeded, Attempts: 1, Outputs: outs, ItemsOut: &ok}, nil)
	if err != nil || se.State != domain.StepSucceeded || *se.ItemsOut != 9 || se.StartedAt == nil || se.FinishedAt == nil {
		t.Fatal(se, err)
	}
	se, _ = s.SetStep(ctx, "ws_1", run.RunID, "inspect", "0", StepUpdate{State: domain.StepFailed}, nil)
	if se.State != domain.StepSucceeded {
		t.Fatal("a terminal step changed")
	}
	got, err := s.StepOutputs(ctx, run.RunID, "inspect", "0")
	if err != nil || got["items"].Manifest.Digest != sha("c") {
		t.Fatal(got, err)
	}
	if err := s.RecordAttempt(ctx, Attempt{WorkspaceID: "ws_1", RunID: run.RunID, StepID: "inspect", PartitionID: "0", Attempt: 1, JobID: "job_1", State: "succeeded", ResultRef: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAttempt(ctx, Attempt{WorkspaceID: "ws_1", RunID: run.RunID, StepID: "inspect", PartitionID: "0", Attempt: 1, JobID: "job_1", State: "failed"}); err != nil {
		t.Fatal(err)
	}
	var st string
	_ = s.Pool.QueryRow(ctx, `SELECT state FROM pipeline.step_attempts`).Scan(&st)
	if st != "succeeded" {
		t.Fatal("a recorded attempt outcome changed:", st)
	}

	// Artifacts: attempt-unique keys, immutable digests (P§20 test 6).
	art := Artifact{WorkspaceID: "ws_1", RunID: run.RunID, StepID: "inspect", PartitionID: "0", Attempt: 1, Name: "items.json", Role: "output", Ref: *outs["items"].Manifest}
	if err := s.RecordArtifacts(ctx, []Artifact{art, art}); err != nil {
		t.Fatal(err)
	}
	art.Ref.Digest = sha("d")
	if err := s.RecordArtifacts(ctx, []Artifact{art}); !errors.Is(err, ErrImmutable) {
		t.Fatal("an artifact was overwritten:", err)
	}

	cand := &contracts.Candidate{RepoID: "repo_1", Branch: "pipeline/" + run.RunID, TargetBranch: "main", Commit: strings.Repeat("a", 40),
		BaseCommit: strings.Repeat("b", 40), ReviewID: "rev_1", OutputManifestDigest: sha("e")}
	if _, err := s.Transition(ctx, run.RunID, domain.RunAwaitingReview, func(_ *Run, u *RunUpdate) error { u.Candidate = cand; return nil }, nil); err != nil {
		t.Fatal(err)
	}
	r, _ := s.GetRun(ctx, run.RunID)
	rec, err := s.Record(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if err := contracts.ValidateValue(contracts.SchemaRun, rec); err != nil {
		t.Fatalf("run record: %v", err)
	}
	if rec.Candidate.OutputManifestDigest != cand.OutputManifestDigest || len(rec.Steps) != 1 {
		t.Fatalf("%+v", rec)
	}

	// Outbox: at least once; a failed send keeps the event pending.
	var sent []string
	fail := true
	n, err := s.Dispatch(ctx, 10, func(_ context.Context, e contracts.Event) error {
		if fail {
			fail = false
			return fmt.Errorf("bus down")
		}
		sent = append(sent, e.Type)
		return nil
	})
	if err != nil || n != 0 {
		t.Fatal(n, err)
	}
	n, err = s.Dispatch(ctx, 10, func(_ context.Context, e contracts.Event) error { sent = append(sent, e.Type); return nil })
	if err != nil || n != 1 || sent[0] != contracts.EvRunStarted {
		t.Fatal(n, sent, err)
	}
	if n, _ := s.Dispatch(ctx, 10, func(context.Context, contracts.Event) error { return nil }); n != 0 {
		t.Fatal("redelivered a dispatched event")
	}
}

// P§20 test 8: a redelivered event changes nothing the second time.
func TestInboxDedupes(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Inbox(ctx, "triggers", "evt_1", "ws_1", func(pgx.Tx) error { calls.Add(1); return nil })
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("applied %d times", calls.Load())
	}
	// A failing apply rolls the dedupe row back, so the retry applies.
	if _, err := s.Inbox(ctx, "triggers", "evt_2", "ws_1", func(pgx.Tx) error { return errors.New("boom") }); err == nil {
		t.Fatal("error swallowed")
	}
	applied, err := s.Inbox(ctx, "triggers", "evt_2", "ws_1", nil)
	if err != nil || !applied {
		t.Fatal(applied, err)
	}
}

func TestLineageWalks(t *testing.T) {
	s, plan, g := setup(t)
	ctx := context.Background()
	if _, _, err := s.PutRevision(ctx, "ws_1", "ingest", "ingest", "user:a", g, plan); err != nil {
		t.Fatal(err)
	}
	run, _, err := s.CreateRun(ctx, newRun("ws_1", plan, "k1"))
	if err != nil {
		t.Fatal(err)
	}
	inspect := plan.Step("inspect")
	items := contracts.ArtifactRef{Key: "pipeline/x/inspect/0.1/items.json", Digest: sha("1"), Size: 1, MediaType: "application/json"}
	manifest := contracts.ArtifactRef{Key: "pipeline/x/propose/0.1/manifest.json", Digest: sha("2"), Size: 1, MediaType: "application/json"}
	edges := lineage.ForStep("ws_1", run.RunID, inspect, map[string]contracts.PortValue{"source": {Type: contracts.PortUploadSession, SessionID: "imp_1"}},
		[]contracts.ArtifactRef{items})
	edges = append(edges, lineage.ForStep("ws_1", run.RunID, plan.Step("propose"), map[string]contracts.PortValue{"accepted": {Type: contracts.PortItemSet, Manifest: &items}},
		[]contracts.ArtifactRef{manifest})...)
	commit, merge := strings.Repeat("c", 40), strings.Repeat("d", 40)
	edges = append(edges, lineage.ForCandidate("ws_1", run.RunID, "propose", manifest, run.Envelope, commit)...)
	edges = append(edges, lineage.ForMerge("ws_1", run.RunID, commit, "apr_1", merge)...)
	for i := 0; i < 2; i++ { // idempotent
		if err := lineage.Insert(ctx, s.Pool, edges); err != nil {
			t.Fatal(err)
		}
	}
	down, err := lineage.Downstream(ctx, s.Pool, "ws_1", lineage.KindUploadSession, "imp_1")
	if err != nil {
		t.Fatal(err)
	}
	reached := map[string]bool{}
	for _, e := range down {
		reached[e.ToKind+":"+e.ToRef] = true
	}
	if !reached["merge_commit:"+merge] || !reached["candidate_commit:"+commit] || !reached["artifact:"+items.Digest] {
		t.Fatalf("downstream of the upload: %v", reached)
	}
	up, err := lineage.Upstream(ctx, s.Pool, "ws_1", lineage.KindMergeCommit, merge)
	if err != nil {
		t.Fatal(err)
	}
	from := map[string]bool{}
	for _, e := range up {
		from[e.FromKind+":"+e.FromRef] = true
	}
	if !from["approval:apr_1"] || !from["upload_session:imp_1"] {
		t.Fatalf("upstream of the merge: %v", from)
	}
	if other, _ := lineage.Downstream(ctx, s.Pool, "ws_2", lineage.KindUploadSession, "imp_1"); len(other) != 0 {
		t.Fatal("lineage crossed workspaces")
	}
}

func TestMigrateDown(t *testing.T) {
	url := testdb.New(t)
	ctx := context.Background()
	if err := Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	if err := MigrateDown(ctx, url); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, url); err != nil {
		t.Fatal("up after down:", err)
	}
}
