package service

import (
	"context"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
)

// PromoteRoot is commit step 7: staged artifacts referenced by a published
// root become available. Idempotent; run by a River job after each commit.
func (s *Service) PromoteRoot(ctx context.Context, a ReconcileRootArgs) (int64, error) {
	var n int64
	err := s.tx(ctx, a.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		var err error
		n, err = q.PromoteReferencedArtifacts(ctx, db.PromoteReferencedArtifactsParams{RepoID: a.RepoID, RootHash: a.RootHash})
		return err
	})
	return n, err
}
