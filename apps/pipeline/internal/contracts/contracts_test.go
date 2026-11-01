package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const repoSchemas = "../../../../schemas/pipeline"

// The embedded copies equal the emitted files (run `go generate ./internal/contracts`).
func TestEmbeddedSchemasMatchRepo(t *testing.T) {
	entries, err := os.ReadDir(repoSchemas)
	if err != nil {
		t.Skip("repo schemas not available (built outside the repo):", err)
	}
	want := map[string][]byte{}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(repoSchemas, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		want[e.Name()] = b
	}
	ingest, err := os.ReadFile("../../../../registry/pipelines/ingest.json")
	if err != nil {
		t.Fatal(err)
	}
	want["ingest.json"] = ingest
	names, err := EmbeddedNames()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != len(want) {
		t.Fatalf("embedded %v, repo has %d files: run go generate ./internal/contracts", names, len(want))
	}
	for _, n := range names {
		got, _ := Files.ReadFile("schemas/" + n)
		if !bytes.Equal(got, want[n]) {
			t.Fatalf("%s is stale: run go generate ./internal/contracts", n)
		}
	}
}

func TestEverySchemaCompiles(t *testing.T) {
	for _, n := range SchemaNames {
		err := Validate(n, []byte(`{}`))
		var ve *ValidationError
		if err != nil && !errors.As(err, &ve) {
			t.Fatalf("%s doesn't compile: %v", n, err)
		}
	}
}

func sha(c string) string { return "sha256:" + strings.Repeat(c, 64) }

func ptr[T any](v T) *T { return &v }

// Documents the Go side produces match the TypeScript-emitted schemas.
func TestGoDocumentsMatchSchemas(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	env := Envelope{RunID: "run_1", WorkspaceID: "ws_1", DefinitionID: "ingest", DefinitionRevision: sha("1"), PlanDigest: sha("2"),
		InputDatasetCommits: []DatasetCommitPin{}, InputSources: []SourcePin{{SessionID: "imp_1", ManifestDigest: sha("3")}},
		ResolvedStepVersions: map[string]string{"inspect": "x.ingest.inspect@1.0.0"}, CodeArtifactDigests: map[string]string{},
		ContainerImageDigests: map[string]string{}, ParametersDigest: sha("4"), ExecutionPolicyVersion: "policy_1", Engine: "dbos",
		ApplicationVersion: sha("5"), CreatedAt: now}
	run := RunRecord{RunID: "run_1", WorkspaceID: "ws_1", ProjectID: "p_1", DefinitionID: "ingest", DefinitionRevision: sha("1"),
		PlanDigest: sha("2"), State: "awaiting_review", Trigger: RunTrigger{Type: "upload.completed", IdempotencyKey: "upload/imp_1"},
		Envelope: env, Steps: []StepExecution{{StepID: "inspect", PartitionID: "0", State: "succeeded", Attempts: 1, JobID: "job_1",
			StartedAt: &now, FinishedAt: &now, ItemsIn: ptr(10), ItemsOut: ptr(9), ItemsQuarantined: ptr(1)}},
		Candidate: &Candidate{RepoID: "repo_1", Branch: "pipeline/run_1", TargetBranch: "main", Commit: strings.Repeat("a", 40),
			BaseCommit: strings.Repeat("b", 40), ReviewID: "rev_1", OutputManifestDigest: sha("6")},
		CreatedAt: now, UpdatedAt: now, DeadlineAt: now.Add(24 * time.Hour)}
	payload, _ := json.Marshal(map[string]any{"project_id": "p_1", "run_id": "run_1", "state": "awaiting_review"})
	ev := Event{EventID: "evt_1", WorkspaceID: "ws_1", Type: EvRunCompleted, Source: EventSource, Depth: 0,
		IdempotencyKey: "run_1/" + EvRunCompleted, Payload: payload}
	in := StepInput{RunID: "run_1", WorkspaceID: "ws_1", ProjectID: "p_1", StepID: "derivatives", PartitionID: "2",
		IdempotencyKey: "run_1/derivatives/2", Uses: "x.ingest.derivatives@1.0.0",
		Inputs: map[string]PortValue{"items": {Type: PortItemSet, Manifest: &ArtifactRef{Key: "pipeline/run_1/inspect/0.1/items.json",
			Digest: sha("7"), Size: 12, MediaType: "application/json"}, Count: ptr(10)}},
		Params: map[string]json.RawMessage{}, ParamsDigest: sha("8"), OutputPrefix: "pipeline/run_1/derivatives/", Range: &Range{Offset: 128, Limit: 64}}
	out := StepOutput{RunID: "run_1", StepID: "inspect", PartitionID: "0", Attempt: 1, Outputs: map[string]PortValue{},
		Items: []ItemReport{{ItemID: "item_1", State: "quarantined", Error: &ErrorEnvelope{Class: "invalid_input", Code: "corrupt_file",
			Message: "The file could not be read.", Retryable: false}}}, Metrics: &StepMetrics{ItemsIn: 1, ItemsQuarantined: 1}}
	for name, v := range map[string]any{SchemaRun: run, SchemaReproducibility: env, SchemaEvent: ev, SchemaStepInput: in,
		SchemaStepOutput: out, SchemaApproval: ApprovalRequest{RunID: "run_1", ApprovalID: "apr_1", CandidateDigest: sha("9")}} {
		if err := ValidateValue(name, v); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// And the schemas still reject what they should: an event payload with a file name.
	bad, _ := json.Marshal(map[string]any{"project_id": "p_1", "run_id": "run_1", "state": "awaiting_review", "file_name": "jane.dcm"})
	ev.Payload = bad
	if err := ValidateValue(SchemaEvent, ev); err == nil {
		t.Fatal("a free-text payload field passed")
	}
}

func TestBuiltinSteps(t *testing.T) {
	steps, err := BuiltinSteps()
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) < 4 {
		t.Fatalf("%d builtin steps", len(steps))
	}
	for _, s := range steps {
		if err := ValidateValue(SchemaStepContract, s); err != nil {
			t.Fatalf("%s: %v", s.ID, err)
		}
	}
}
