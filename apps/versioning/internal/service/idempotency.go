package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

// zeroRepo scopes idempotency records for operations that have no repo yet.
const zeroRepo = "00000000-0000-0000-0000-000000000000"

// idem identifies one idempotent request: UNIQUE(tenant, repo, branch, key).
// For non-commit writes "branch" holds an "@op/..." scope, which can never
// collide with a real branch name.
type idem struct {
	repo, scope, key, hash string
}

func newIdem(repo, scope, key string, req any) (idem, error) {
	if len(key) < 8 || len(key) > 128 {
		return idem{}, errf(http.StatusBadRequest, "bad_request", "Idempotency-Key must be 8-128 characters")
	}
	b, err := manifests.Canonical(req)
	if err != nil {
		return idem{}, err
	}
	return idem{repo: repo, scope: scope, key: key, hash: manifests.HashHex(b)}, nil
}

// lookup returns the stored response for a replay, or 422 if the key was
// used with a different request.
func lookupIdem(ctx context.Context, q *db.Queries, tenant string, k idem) (json.RawMessage, bool, error) {
	rec, err := q.GetIdempotency(ctx, db.GetIdempotencyParams{TenantID: tenant, RepoID: k.repo, Branch: k.scope, IdempotencyKey: k.key})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if rec.RequestHash != k.hash {
		return nil, false, errf(http.StatusUnprocessableEntity, "idempotency_mismatch",
			"idempotency key was already used with a different request")
	}
	return rec.ResponseJson, true, nil
}

func (s *Service) storeIdem(ctx context.Context, q *db.Queries, tenant string, k idem, status int, resp any) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	return q.InsertIdempotency(ctx, db.InsertIdempotencyParams{TenantID: tenant, RepoID: k.repo, Branch: k.scope,
		IdempotencyKey: k.key, RequestHash: k.hash, StatusCode: int32(status), ResponseJson: b,
		ExpiresAt: s.Now().Add(s.Cfg.IdempotencyTTL)})
}

// idempotent runs fn once per key: a replay returns the stored response, a
// concurrent duplicate loses the unique-constraint race and then replays.
func idempotent[T any](ctx context.Context, s *Service, p *authn.Principal, k idem, status int,
	fn func(q *db.Queries, tx pgx.Tx) (T, error)) (T, error) {
	var out T
	replayed := false
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
		raw, ok, err := lookupIdem(ctx, q, p.TenantID, k)
		if err != nil {
			return err
		}
		if ok {
			replayed = true
			return json.Unmarshal(raw, &out)
		}
		if out, err = fn(q, tx); err != nil {
			return err
		}
		return s.storeIdem(ctx, q, p.TenantID, k, status, out)
	})
	if err != nil && storage.IsUniqueViolation(err) {
		// Either a concurrent duplicate request (replay it) or a real
		// uniqueness conflict inside fn (report it as such).
		err2 := s.read(ctx, p.TenantID, func(q *db.Queries) error {
			raw, ok, err := lookupIdem(ctx, q, p.TenantID, k)
			if err != nil {
				return err
			}
			if !ok {
				return errf(http.StatusConflict, "conflict", "already exists")
			}
			replayed = true
			return json.Unmarshal(raw, &out)
		})
		return out, err2
	}
	_ = replayed
	return out, err
}
