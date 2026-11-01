package contracts

import (
	"encoding/json"
	"time"
)

// The Go mirror of packages/contracts/src/pipeline. Field names are the wire
// names; optional fields are omitempty (or pointers where zero is meaningful).
// TestGoDocumentsMatchSchemas keeps them in step with the emitted schemas.

// ---- graph (P§4) -------------------------------------------------------------

// Graph is a pipeline definition as authored.
type Graph struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   Metadata          `json:"metadata"`
	Inputs     map[string]Input  `json:"inputs,omitempty"`
	Trigger    *Trigger          `json:"trigger,omitempty"`
	Steps      []Step            `json:"steps"`
	Outputs    map[string]string `json:"outputs,omitempty"`
	Policy     *Policy           `json:"policy,omitempty"`
	Limits     *Limits           `json:"limits,omitempty"`
}

// Metadata names a graph.
type Metadata struct {
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

// Input is a graph input; runs pin it at start.
type Input struct {
	Type          string    `json:"type"`
	Description   string    `json:"description,omitempty"`
	Selector      *Selector `json:"selector,omitempty"`
	PinAtRunStart *bool     `json:"pin_at_run_start,omitempty"`
}

// Selector picks a dataset input.
type Selector struct {
	Repository string `json:"repository,omitempty"`
	Branch     string `json:"branch,omitempty"`
}

// Trigger says what starts runs.
type Trigger struct {
	Type   string `json:"type"`
	Branch string `json:"branch,omitempty"`
	Cron   string `json:"cron,omitempty"`
}

// Step is one node of the graph.
type Step struct {
	ID          string                     `json:"id"`
	Uses        string                     `json:"uses"`
	Description string                     `json:"description,omitempty"`
	Needs       []string                   `json:"needs,omitempty"`
	Inputs      map[string]string          `json:"inputs,omitempty"`
	With        map[string]json.RawMessage `json:"with,omitempty"`
	Execution   *Execution                 `json:"execution,omitempty"`
	Resources   *Resources                 `json:"resources,omitempty"`
	FanOut      *FanOut                    `json:"fan_out,omitempty"`
	Optional    bool                       `json:"optional,omitempty"`
	OnFailure   string                     `json:"on_failure,omitempty"`
}

// Execution overrides how a step runs.
type Execution struct {
	Class          string `json:"class,omitempty"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
	MaxAttempts    int    `json:"max_attempts,omitempty"`
}

// Resources a step asks for.
type Resources struct {
	Class    string `json:"class,omitempty"`
	GPU      int    `json:"gpu,omitempty"`
	MemoryGB int    `json:"memory_gb,omitempty"`
}

// FanOut runs a step once per bounded batch.
type FanOut struct {
	Over          string `json:"over"`
	BatchSize     int    `json:"batch_size"`
	MaxPartitions int    `json:"max_partitions"`
}

// Policy is the run policy.
type Policy struct {
	Review          string         `json:"review"`
	PartialSuccess  PartialSuccess `json:"partial_success"`
	DeadlineSeconds int            `json:"deadline_seconds"`
	Compatibility   string         `json:"compatibility"`
}

// PartialSuccess lets good items proceed when some fail.
type PartialSuccess struct {
	Allowed         bool    `json:"allowed"`
	MinSuccessRatio float64 `json:"min_success_ratio"`
}

// Limits bound a graph.
type Limits struct {
	MaxSteps             int `json:"max_steps"`
	MaxPartitionsPerStep int `json:"max_partitions_per_step"`
	MaxTotalPartitions   int `json:"max_total_partitions"`
}

// Platform maximums (packages/contracts PIPELINE_LIMITS).
const (
	MaxSteps             = 256
	MaxPartitionsPerStep = 10_000
	MaxTotalPartitions   = 100_000
	MaxDeadlineSeconds   = 86_400
)

// DefaultPolicy is what an omitted policy means.
func DefaultPolicy() Policy {
	return Policy{Review: "required", PartialSuccess: PartialSuccess{Allowed: false, MinSuccessRatio: 1},
		DeadlineSeconds: MaxDeadlineSeconds, Compatibility: "compatible"}
}

// DefaultLimits is what omitted limits mean.
func DefaultLimits() Limits {
	return Limits{MaxSteps: 64, MaxPartitionsPerStep: 1_000, MaxTotalPartitions: 10_000}
}

// ---- step I/O ------------------------------------------------------------------

// Port types.
const (
	PortUploadSession   = "upload_session"
	PortItemSet         = "item_set"
	PortArtifactSet     = "artifact_set"
	PortReport          = "report"
	PortDatasetCommit   = "dataset_commit"
	PortCandidateCommit = "candidate_commit"
)

// Step runtimes.
const (
	RuntimeBuiltin   = "builtin"
	RuntimeKernelJob = "kernel_job"
)

// PortSpec declares one port of a step contract.
type PortSpec struct {
	Type        string   `json:"type"`
	Required    *bool    `json:"required,omitempty"`
	Modalities  []string `json:"modalities,omitempty"`
	Description string   `json:"description,omitempty"`
}

// IsRequired applies the default (true).
func (p PortSpec) IsRequired() bool { return p.Required == nil || *p.Required }

// StepContract is what a step implementation declares.
type StepContract struct {
	ID                    string              `json:"id"`
	Version               string              `json:"version"`
	Runtime               string              `json:"runtime"`
	JobKind               string              `json:"job_kind,omitempty"`
	Plugin                string              `json:"plugin,omitempty"`
	Description           string              `json:"description"`
	Inputs                map[string]PortSpec `json:"inputs"`
	Outputs               map[string]PortSpec `json:"outputs"`
	ResourceClass         string              `json:"resource_class,omitempty"`
	Partitionable         bool                `json:"partitionable,omitempty"`
	Deterministic         bool                `json:"deterministic,omitempty"`
	DefaultTimeoutSeconds int                 `json:"default_timeout_seconds,omitempty"`
}

// ArtifactRef is an immutable blob in the api's BlobStore.
type ArtifactRef struct {
	Key       string `json:"key"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
	MediaType string `json:"media_type"`
}

// CommitRef points at a versioning commit.
type CommitRef struct {
	RepoID string `json:"repo_id"`
	Commit string `json:"commit"`
	Branch string `json:"branch,omitempty"`
}

// PortValue is a value on a port, always by reference.
type PortValue struct {
	Type      string       `json:"type"`
	Manifest  *ArtifactRef `json:"manifest,omitempty"`
	Commit    *CommitRef   `json:"commit,omitempty"`
	SessionID string       `json:"session_id,omitempty"`
	Count     *int         `json:"count,omitempty"`
}

// Range is the slice of a fan-out input one partition covers.
type Range struct {
	Offset int `json:"offset"`
	Limit  int `json:"limit"`
}

// StepInput is the document at a step job's input_ref.
type StepInput struct {
	RunID          string                     `json:"run_id"`
	WorkspaceID    string                     `json:"workspace_id"`
	ProjectID      string                     `json:"project_id"`
	StepID         string                     `json:"step_id"`
	PartitionID    string                     `json:"partition_id"`
	IdempotencyKey string                     `json:"idempotency_key"`
	Uses           string                     `json:"uses"`
	Inputs         map[string]PortValue       `json:"inputs"`
	Params         map[string]json.RawMessage `json:"params"`
	ParamsDigest   string                     `json:"params_digest"`
	OutputPrefix   string                     `json:"output_prefix"`
	Range          *Range                     `json:"range,omitempty"`
}

// ItemReport is one item's outcome.
type ItemReport struct {
	ItemID    string         `json:"item_id"`
	NodeID    string         `json:"node_id,omitempty"`
	State     string         `json:"state"`
	Kind      string         `json:"kind,omitempty"`
	StepID    string         `json:"step_id,omitempty"`
	Retryable *bool          `json:"retryable,omitempty"`
	Error     *ErrorEnvelope `json:"error,omitempty"`
}

// StepMetrics counts items through a step.
type StepMetrics struct {
	ItemsIn          int `json:"items_in"`
	ItemsOut         int `json:"items_out"`
	ItemsQuarantined int `json:"items_quarantined"`
}

// StepOutput is the document at a step job's result_ref.
type StepOutput struct {
	RunID       string               `json:"run_id"`
	StepID      string               `json:"step_id"`
	PartitionID string               `json:"partition_id"`
	Attempt     int                  `json:"attempt"`
	Outputs     map[string]PortValue `json:"outputs"`
	Items       []ItemReport         `json:"items,omitempty"`
	Metrics     *StepMetrics         `json:"metrics,omitempty"`
	Error       *ErrorEnvelope       `json:"error,omitempty"`
}

// ---- errors (P§12) -------------------------------------------------------------

// ErrorEnvelope is the pipeline's error shape.
type ErrorEnvelope struct {
	Class       string `json:"class"`
	Code        string `json:"code"`
	Message     string `json:"message"`
	Retryable   bool   `json:"retryable"`
	StepID      string `json:"step_id,omitempty"`
	PartitionID string `json:"partition_id,omitempty"`
	Attempt     int    `json:"attempt,omitempty"`
	JobID       string `json:"job_id,omitempty"`
}

func (e *ErrorEnvelope) Error() string { return e.Class + "/" + e.Code + ": " + e.Message }

// ---- reproducibility envelope (P§3) ----------------------------------------------

// DatasetCommitPin is one pinned dataset input.
type DatasetCommitPin struct {
	RepoID   string `json:"repo_id"`
	Commit   string `json:"commit"`
	SchemaID string `json:"schema_id,omitempty"`
}

// SourcePin is one pinned upload session.
type SourcePin struct {
	SessionID      string `json:"session_id"`
	ManifestDigest string `json:"manifest_digest"`
}

// Envelope is everything a run pinned when it started.
type Envelope struct {
	RunID                  string             `json:"run_id"`
	WorkspaceID            string             `json:"workspace_id"`
	DefinitionID           string             `json:"definition_id"`
	DefinitionRevision     string             `json:"definition_revision"`
	PlanDigest             string             `json:"plan_digest"`
	InputDatasetCommits    []DatasetCommitPin `json:"input_dataset_commits"`
	InputSources           []SourcePin        `json:"input_sources"`
	ResolvedStepVersions   map[string]string  `json:"resolved_step_versions"`
	CodeArtifactDigests    map[string]string  `json:"code_artifact_digests"`
	ContainerImageDigests  map[string]string  `json:"container_image_digests"`
	ParametersDigest       string             `json:"parameters_digest"`
	ExecutionPolicyVersion string             `json:"execution_policy_version"`
	Engine                 string             `json:"engine"`
	ApplicationVersion     string             `json:"application_version"`
	CreatedAt              time.Time          `json:"created_at"`
}

// ---- runs ----------------------------------------------------------------------

// StepExecution is one logical step partition's state.
type StepExecution struct {
	StepID           string         `json:"step_id"`
	PartitionID      string         `json:"partition_id"`
	Label            string         `json:"label,omitempty"`
	Plugin           string         `json:"plugin,omitempty"`
	State            string         `json:"state"`
	Attempts         int            `json:"attempts"`
	MaxAttempts      int            `json:"max_attempts,omitempty"`
	JobID            string         `json:"job_id,omitempty"`
	StartedAt        *time.Time     `json:"started_at,omitempty"`
	FinishedAt       *time.Time     `json:"finished_at,omitempty"`
	ItemsIn          *int           `json:"items_in,omitempty"`
	ItemsOut         *int           `json:"items_out,omitempty"`
	ItemsQuarantined *int           `json:"items_quarantined,omitempty"`
	Error            *ErrorEnvelope `json:"error,omitempty"`
}

// Candidate is what a run proposed.
type Candidate struct {
	RepoID       string `json:"repo_id"`
	Branch       string `json:"branch"`
	TargetBranch string `json:"target_branch"`
	Commit       string `json:"commit"`
	BaseCommit   string `json:"base_commit"`
	ReviewID     string `json:"review_id"`
	// OutputManifestDigest is what approvals bind to.
	OutputManifestDigest string     `json:"output_manifest_digest"`
	ItemCount            *int       `json:"item_count,omitempty"`
	CreatedAt            *time.Time `json:"created_at,omitempty"`
}

// Publish records the publish outcome.
type Publish struct {
	ApprovalID     string `json:"approval_id"`
	MergeCommit    string `json:"merge_commit,omitempty"`
	RebaseReviewID string `json:"rebase_review_id,omitempty"`
}

// RunTrigger records why a run started.
type RunTrigger struct {
	Type           string `json:"type"`
	SourceEventID  string `json:"source_event_id,omitempty"`
	IdempotencyKey string `json:"idempotency_key"`
	ImportID       string `json:"import_id,omitempty"`
	Actor          string `json:"actor,omitempty"`
}

// RunRecord is the run as the API returns it.
type RunRecord struct {
	RunID              string          `json:"run_id"`
	WorkspaceID        string          `json:"workspace_id"`
	ProjectID          string          `json:"project_id"`
	DefinitionID       string          `json:"definition_id"`
	DefinitionName     string          `json:"definition_name,omitempty"`
	DefinitionRevision string          `json:"definition_revision"`
	PlanDigest         string          `json:"plan_digest"`
	State              string          `json:"state"`
	Trigger            RunTrigger      `json:"trigger"`
	Envelope           Envelope        `json:"envelope"`
	Steps              []StepExecution `json:"steps"`
	Candidate          *Candidate      `json:"candidate,omitempty"`
	Publish            *Publish        `json:"publish,omitempty"`
	ItemCounts         map[string]int  `json:"item_counts,omitempty"`
	ItemTotal          *int            `json:"item_total,omitempty"`
	Error              *ErrorEnvelope  `json:"error,omitempty"`
	CreatedAt          time.Time       `json:"created_at"`
	StartedAt          *time.Time      `json:"started_at,omitempty"`
	FinishedAt         *time.Time      `json:"finished_at,omitempty"`
	UpdatedAt          time.Time       `json:"updated_at"`
	DeadlineAt         time.Time       `json:"deadline_at"`
}

// ---- events (P§15) ---------------------------------------------------------------

// Event is a pipeline event in the kernel outbox envelope.
type Event struct {
	EventID        string          `json:"event_id"`
	WorkspaceID    string          `json:"workspace_id"`
	Type           string          `json:"type"`
	Source         string          `json:"source"`
	CorrelationID  string          `json:"correlation_id,omitempty"`
	Depth          int             `json:"depth"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
	PayloadRef     string          `json:"payload_ref,omitempty"`
}

// Event types (names fixed by todo12 §5).
const (
	EvRunStarted       = "pipeline.run.started"
	EvRunCompleted     = "pipeline.run.completed"
	EvRunFailed        = "pipeline.run.failed"
	EvRunPaused        = "pipeline.run.paused"
	EvStepStarted      = "pipeline.step.started"
	EvStepCompleted    = "pipeline.step.completed"
	EvStepFailed       = "pipeline.step.failed"
	EvOutputStaged     = "pipeline.output.staged"
	EvCandidateCreated = "dataset.candidate.created"
	EvReviewRequested  = "review.requested"
	EvReviewApproved   = "review.approved"
	EventSource        = "pipeline"
)

// ---- plan ----------------------------------------------------------------------

// PlanSchema is the plan document's schema tag.
const PlanSchema = "pipeline.plan/v1"

// ResolvedStep is the one signed version a step resolved to.
type ResolvedStep struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
	Signer  string `json:"signer"`
}

// PlannedInput is a bound, typed input.
type PlannedInput struct {
	Ref  string `json:"ref"`
	Type string `json:"type"`
}

// PlannedStep is a step with everything resolved and defaulted.
type PlannedStep struct {
	ID             string                     `json:"id"`
	Uses           string                     `json:"uses"`
	Resolved       ResolvedStep               `json:"resolved"`
	Runtime        string                     `json:"runtime"`
	JobKind        string                     `json:"job_kind,omitempty"`
	Plugin         string                     `json:"plugin,omitempty"`
	ResourceClass  string                     `json:"resource_class"`
	Needs          []string                   `json:"needs"`
	Level          int                        `json:"level"`
	Inputs         map[string]PlannedInput    `json:"inputs"`
	Outputs        map[string]string          `json:"outputs"`
	Params         map[string]json.RawMessage `json:"params"`
	ParamsDigest   string                     `json:"params_digest"`
	TimeoutSeconds int                        `json:"timeout_seconds"`
	MaxAttempts    int                        `json:"max_attempts"`
	FanOut         *FanOut                    `json:"fan_out,omitempty"`
	Optional       bool                       `json:"optional"`
	OnFailure      string                     `json:"on_failure"`
}

// Plan is the frozen execution plan.
type Plan struct {
	Schema           string                  `json:"schema"`
	DefinitionID     string                  `json:"definition_id,omitempty"`
	DefinitionDigest string                  `json:"definition_digest"`
	Name             string                  `json:"name"`
	Inputs           map[string]Input        `json:"inputs"`
	Order            []string                `json:"order"`
	Steps            []PlannedStep           `json:"steps"`
	Outputs          map[string]PlannedInput `json:"outputs"`
	Policy           Policy                  `json:"policy"`
	Limits           Limits                  `json:"limits"`
	Digest           string                  `json:"digest"`
}

// Step returns the planned step with id, or nil.
func (p *Plan) Step(id string) *PlannedStep {
	for i := range p.Steps {
		if p.Steps[i].ID == id {
			return &p.Steps[i]
		}
	}
	return nil
}

// Diagnostic is one compiler finding.
type Diagnostic struct {
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationReport answers POST /v1/definitions/{id}/validate.
type ValidationReport struct {
	OK               bool         `json:"ok"`
	DefinitionDigest string       `json:"definition_digest,omitempty"`
	PlanDigest       string       `json:"plan_digest,omitempty"`
	Diagnostics      []Diagnostic `json:"diagnostics"`
}

// ---- private API -------------------------------------------------------------------

// RunInputBinding binds one graph input for a run.
type RunInputBinding struct {
	SessionID             string `json:"session_id,omitempty"`
	SessionManifestDigest string `json:"session_manifest_digest,omitempty"`
	RepoID                string `json:"repo_id,omitempty"`
	Commit                string `json:"commit,omitempty"`
}

// RunTarget is where the candidate is proposed.
type RunTarget struct {
	RepoID string `json:"repo_id"`
	Branch string `json:"branch"`
}

// CreateRunTrigger is the trigger of a create-run request.
type CreateRunTrigger struct {
	Type          string `json:"type"`
	SourceEventID string `json:"source_event_id,omitempty"`
}

// CreateRunRequest is POST /v1/runs.
type CreateRunRequest struct {
	WorkspaceID    string                     `json:"workspace_id"`
	ProjectID      string                     `json:"project_id"`
	DefinitionID   string                     `json:"definition_id"`
	Revision       string                     `json:"revision,omitempty"`
	Inputs         map[string]RunInputBinding `json:"inputs"`
	Target         RunTarget                  `json:"target"`
	Trigger        CreateRunTrigger           `json:"trigger"`
	IdempotencyKey string                     `json:"idempotency_key"`
	Actor          string                     `json:"actor"`
	CorrelationID  string                     `json:"correlation_id,omitempty"`
}

// ApprovalRequest is POST /v1/approvals.
type ApprovalRequest struct {
	RunID           string `json:"run_id"`
	ApprovalID      string `json:"approval_id"`
	CandidateDigest string `json:"candidate_digest"`
}

// CancelRunRequest is POST /v1/runs/{id}/cancel.
type CancelRunRequest struct {
	Actor  string `json:"actor"`
	Reason string `json:"reason,omitempty"`
}
