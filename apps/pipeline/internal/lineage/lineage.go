// Package lineage records and queries the materialization graph
// (docs/pipeline.md §8): for every staged artifact and candidate commit, the
// source sessions/commits, the step (and its resolved digest) that produced
// it, and the approval that published it. It lives in the pipeline schema,
// independent of engine state, so it survives DBOS retention.
package lineage

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"studio.local/pipeline/internal/contracts"
)

// Node kinds.
const (
	KindUploadSession   = "upload_session"
	KindDatasetCommit   = "dataset_commit"
	KindArtifact        = "artifact"
	KindCandidateCommit = "candidate_commit"
	KindMergeCommit     = "merge_commit"
	KindApproval        = "approval"
)

// Edge is one from → to derivation.
type Edge struct {
	WorkspaceID string
	RunID       string
	StepID      string
	FromKind    string
	FromRef     string
	ToKind      string
	ToRef       string
	Attributes  map[string]string
}

// Node is a lineage vertex.
type Node struct {
	Kind string
	Ref  string
}

// DBTX is what lineage needs from a pool or transaction.
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ForStep links a step's inputs to its outputs. Inputs are port values the
// step read; outputs the artifacts it staged. The resolved step version and
// parameters digest go on every edge so a wrong rule can be traced (§12).
func ForStep(ws, run string, ps *contracts.PlannedStep, inputs map[string]contracts.PortValue, outputs []contracts.ArtifactRef) []Edge {
	attrs := map[string]string{"uses": ps.Resolved.ID + "@" + ps.Resolved.Version, "digest": ps.Resolved.Digest,
		"params_digest": ps.ParamsDigest}
	var from []Node
	for _, name := range sortedKeys(inputs) {
		from = append(from, nodesOf(inputs[name])...)
	}
	var edges []Edge
	for _, f := range from {
		for _, o := range outputs {
			edges = append(edges, Edge{WorkspaceID: ws, RunID: run, StepID: ps.ID, FromKind: f.Kind, FromRef: f.Ref,
				ToKind: KindArtifact, ToRef: o.Digest, Attributes: attrs})
		}
	}
	return edges
}

// ForCandidate links the staged output manifest (and every pinned source) to
// the candidate commit.
func ForCandidate(ws, run, step string, manifest contracts.ArtifactRef, env contracts.Envelope, commit string) []Edge {
	edges := []Edge{{WorkspaceID: ws, RunID: run, StepID: step, FromKind: KindArtifact, FromRef: manifest.Digest,
		ToKind: KindCandidateCommit, ToRef: commit}}
	for _, s := range env.InputSources {
		edges = append(edges, Edge{WorkspaceID: ws, RunID: run, StepID: step, FromKind: KindUploadSession, FromRef: s.SessionID,
			ToKind: KindCandidateCommit, ToRef: commit, Attributes: map[string]string{"manifest_digest": s.ManifestDigest}})
	}
	for _, c := range env.InputDatasetCommits {
		edges = append(edges, Edge{WorkspaceID: ws, RunID: run, StepID: step, FromKind: KindDatasetCommit, FromRef: c.Commit,
			ToKind: KindCandidateCommit, ToRef: commit, Attributes: map[string]string{"repo_id": c.RepoID}})
	}
	return edges
}

// ForMerge links the candidate and the approval to the published merge commit.
func ForMerge(ws, run, candidate, approvalID, mergeCommit string) []Edge {
	return []Edge{
		{WorkspaceID: ws, RunID: run, FromKind: KindCandidateCommit, FromRef: candidate, ToKind: KindMergeCommit, ToRef: mergeCommit},
		{WorkspaceID: ws, RunID: run, FromKind: KindApproval, FromRef: approvalID, ToKind: KindMergeCommit, ToRef: mergeCommit},
	}
}

func nodesOf(v contracts.PortValue) []Node {
	var out []Node
	if v.Manifest != nil {
		out = append(out, Node{Kind: KindArtifact, Ref: v.Manifest.Digest})
	}
	if v.Commit != nil {
		out = append(out, Node{Kind: KindDatasetCommit, Ref: v.Commit.Commit})
	}
	if v.SessionID != "" {
		out = append(out, Node{Kind: KindUploadSession, Ref: v.SessionID})
	}
	return out
}

// Insert writes edges idempotently (a retried step writes the same edges).
func Insert(ctx context.Context, q DBTX, edges []Edge) error {
	for _, e := range edges {
		attrs := e.Attributes
		if attrs == nil {
			attrs = map[string]string{}
		}
		b, err := json.Marshal(attrs)
		if err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `INSERT INTO pipeline.lineage_edges
			(workspace_id, run_id, step_id, from_kind, from_ref, to_kind, to_ref, attributes)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
			e.WorkspaceID, e.RunID, e.StepID, e.FromKind, e.FromRef, e.ToKind, e.ToRef, b); err != nil {
			return fmt.Errorf("lineage: %w", err)
		}
	}
	return nil
}

// MaxDepth bounds a lineage walk.
const MaxDepth = 32

// Downstream lists everything derived from (kind, ref) in a workspace, e.g.
// every candidate and merge built from an input commit (P§20 test 16).
func Downstream(ctx context.Context, q DBTX, ws, kind, ref string) ([]Edge, error) {
	return walk(ctx, q, `
		WITH RECURSIVE down(from_kind, from_ref, to_kind, to_ref, run_id, step_id, depth) AS (
			SELECT from_kind, from_ref, to_kind, to_ref, run_id, step_id, 1 FROM pipeline.lineage_edges
			 WHERE workspace_id = $1 AND from_kind = $2 AND from_ref = $3
			UNION
			SELECT e.from_kind, e.from_ref, e.to_kind, e.to_ref, e.run_id, e.step_id, d.depth + 1
			  FROM pipeline.lineage_edges e JOIN down d ON e.from_kind = d.to_kind AND e.from_ref = d.to_ref
			 WHERE e.workspace_id = $1 AND d.depth < $4)
		SELECT DISTINCT from_kind, from_ref, to_kind, to_ref, run_id, step_id FROM down`, ws, kind, ref)
}

// Upstream lists everything (kind, ref) was derived from.
func Upstream(ctx context.Context, q DBTX, ws, kind, ref string) ([]Edge, error) {
	return walk(ctx, q, `
		WITH RECURSIVE up(from_kind, from_ref, to_kind, to_ref, run_id, step_id, depth) AS (
			SELECT from_kind, from_ref, to_kind, to_ref, run_id, step_id, 1 FROM pipeline.lineage_edges
			 WHERE workspace_id = $1 AND to_kind = $2 AND to_ref = $3
			UNION
			SELECT e.from_kind, e.from_ref, e.to_kind, e.to_ref, e.run_id, e.step_id, u.depth + 1
			  FROM pipeline.lineage_edges e JOIN up u ON e.to_kind = u.from_kind AND e.to_ref = u.from_ref
			 WHERE e.workspace_id = $1 AND u.depth < $4)
		SELECT DISTINCT from_kind, from_ref, to_kind, to_ref, run_id, step_id FROM up`, ws, kind, ref)
}

func walk(ctx context.Context, q DBTX, sql, ws, kind, ref string) ([]Edge, error) {
	rows, err := q.Query(ctx, sql, ws, kind, ref, MaxDepth)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Edge
	for rows.Next() {
		e := Edge{WorkspaceID: ws}
		if err := rows.Scan(&e.FromKind, &e.FromRef, &e.ToKind, &e.ToRef, &e.RunID, &e.StepID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		return a.FromKind+a.FromRef+a.ToKind+a.ToRef < b.FromKind+b.FromRef+b.ToKind+b.ToRef
	})
	return out, rows.Err()
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
