package service

// River job arguments. Workers live in internal/jobs and call back into the
// service; args carry ids only.

// ReconcileRootArgs promotes staged artifacts of a newly published root.
type ReconcileRootArgs struct {
	TenantID string `json:"tenant_id"`
	RepoID   string `json:"repo_id"`
	RootHash string `json:"root_hash"`
}

// Kind implements river.JobArgs.
func (ReconcileRootArgs) Kind() string { return "versioning.reconcile_root" }

// ReviewChecksArgs runs the built-in checks for one (source, target) pair.
type ReviewChecksArgs struct {
	TenantID  string `json:"tenant_id"`
	RepoID    string `json:"repo_id"`
	ReviewID  string `json:"review_id"`
	SourceOID string `json:"source_oid"`
	TargetOID string `json:"target_oid"`
}

// Kind implements river.JobArgs.
func (ReviewChecksArgs) Kind() string { return "versioning.review_checks" }

// DiffJobArgs computes a large diff in the background.
type DiffJobArgs struct {
	TenantID string `json:"tenant_id"`
	RepoID   string `json:"repo_id"`
	JobID    string `json:"job_id"`
	BaseOID  string `json:"base_oid"`
	HeadOID  string `json:"head_oid"`
}

// Kind implements river.JobArgs.
func (DiffJobArgs) Kind() string { return "versioning.diff" }

// OutboxRelayArgs is the periodic outbox relay.
type OutboxRelayArgs struct{}

// Kind implements river.JobArgs.
func (OutboxRelayArgs) Kind() string { return "versioning.outbox_relay" }

// ReconcileArgs is the periodic reconciler.
type ReconcileArgs struct{}

// Kind implements river.JobArgs.
func (ReconcileArgs) Kind() string { return "versioning.reconcile" }

// GCMarkArgs is the periodic GC mark (sweep is a separate command).
type GCMarkArgs struct{}

// Kind implements river.JobArgs.
func (GCMarkArgs) Kind() string { return "versioning.gc_mark" }
