// Package authz re-checks tenant/repo scope and review policy inside the
// service (spec §2: service-token authentication alone is insufficient).
package authz

import (
	"errors"
	"fmt"

	"studio.local/versioning/internal/authn"
)

// ErrOutOfScope means the principal may not touch the resource.
var ErrOutOfScope = errors.New("resource outside the caller's tenant/project scope")

// RequireScope checks a JWT scope.
func RequireScope(p *authn.Principal, scope string) error {
	if p == nil {
		return authn.ErrUnauthenticated
	}
	if !p.Has(scope) {
		return fmt.Errorf("missing scope %s", scope)
	}
	return nil
}

// RepoInScope checks a repository row against the principal. Row-level
// security already filters by tenant; this is the application-level layer and
// also enforces the project boundary.
func RepoInScope(p *authn.Principal, tenantID, projectID string) error {
	if p == nil || p.TenantID != tenantID || p.ProjectID != projectID {
		return ErrOutOfScope
	}
	return nil
}
