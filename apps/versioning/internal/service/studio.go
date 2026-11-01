package service

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gowebpki/jcs"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
)

// The Studio definition (todo10 §3.2, Phase 2) travels with the dataset: a
// commit's tree may carry a `.studio/` subtree with
//
//	plugins.lock.json                  exact plugin versions, pinned by digest
//	tasks/<taskId>/environment.json    each task's environment spec
//	tasks/<taskId>/README.md           intent and notes
//	structure.json                     the dataset's structure (DatasetStructure v1, todo13 D8)
//
// JSON files are stored in RFC 8785 canonical form (the API refuses any other
// bytes), so equal definitions are equal blobs and the tree id names the
// definition. A commit that doesn't send `studio` keeps its parent's tree, so
// annotation saves never drop the Studio; a revert restores the target's; a
// merge takes the side that changed it (the source when both did: that is
// the change the reviewers approved).

var studioPathRE = regexp.MustCompile(`^(plugins\.lock\.json|structure\.json|tasks/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/(environment\.json|README\.md))$`)

const (
	maxStudioFiles     = 512
	maxStudioFileBytes = 1 << 20
	maxStudioBytes     = 8 << 20
)

// StudioInput replaces a commit's whole `.studio/` tree (an empty map removes it).
type StudioInput struct {
	Files map[string]string `json:"files"`
}

func validateStudio(in *StudioInput) (map[string][]byte, error) {
	if in == nil {
		return nil, nil
	}
	if len(in.Files) > maxStudioFiles {
		return nil, errf(http.StatusRequestEntityTooLarge, "too_large", "at most %d .studio files", maxStudioFiles)
	}
	out, total := make(map[string][]byte, len(in.Files)), 0
	for path, text := range in.Files {
		if !studioPathRE.MatchString(path) || strings.Contains(path, "..") {
			return nil, errf(http.StatusBadRequest, "bad_request", "%q isn't a .studio path (plugins.lock.json, structure.json, tasks/<id>/environment.json, tasks/<id>/README.md)", path)
		}
		if len(text) > maxStudioFileBytes {
			return nil, errf(http.StatusRequestEntityTooLarge, "too_large", "%s is over %d bytes", path, maxStudioFileBytes)
		}
		if total += len(text); total > maxStudioBytes {
			return nil, errf(http.StatusRequestEntityTooLarge, "too_large", ".studio is over %d bytes", maxStudioBytes)
		}
		b := []byte(text)
		if !utf8.Valid(b) {
			return nil, errf(http.StatusBadRequest, "bad_request", "%s isn't UTF-8", path)
		}
		if strings.HasSuffix(path, ".json") {
			if !json.Valid(b) {
				return nil, errf(http.StatusBadRequest, "bad_request", "%s isn't JSON", path)
			}
			c, err := jcs.Transform(b)
			if err != nil || !bytes.Equal(c, b) {
				return nil, errf(http.StatusBadRequest, "not_canonical", "%s must be RFC 8785 canonical JSON", path)
			}
		}
		out[path] = b
	}
	return out, nil
}

// studioOf returns the `.studio/` tree id of a commit ("" if none).
func (s *Service) studioOf(ctx context.Context, tenant, repoID, oid string) (string, error) {
	if oid == "" {
		return "", nil
	}
	c, err := s.Git.Open(ctx, tenant, repoID).ReadCommit(oid)
	if err != nil {
		return "", err
	}
	return c.Snapshot.Studio.OID, nil
}

// mergeStudio picks the merged `.studio/` tree from the merge base, target and source.
func mergeStudio(base, target, source string) string {
	if source == base {
		return target
	}
	return source
}

// StudioView is a commit's Studio definition.
type StudioView struct {
	CommitOID  string            `json:"commit_oid"`
	StudioTree string            `json:"studio_tree,omitempty"`
	Files      map[string]string `json:"files"`
}

// GetStudio returns the `.studio/` files at a branch, commit oid or `tag:<release>`.
func (s *Service) GetStudio(ctx context.Context, p *authn.Principal, repoID, ref string) (*StudioView, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var oid string
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		if tag, ok := strings.CutPrefix(ref, "tag:"); ok {
			r, err := q.GetRelease(ctx, db.GetReleaseParams{RepoID: repoID, Tag: tag})
			if err != nil {
				return notFound(err, "release")
			}
			oid = r.CommitOid
			return nil
		}
		var err error
		oid, err = resolveRef(ctx, q, repoID, ref)
		return err
	}); err != nil {
		return nil, err
	}
	g := s.Git.Open(ctx, p.TenantID, repoID)
	c, err := g.ReadCommit(oid)
	if err != nil {
		return nil, err
	}
	files, err := g.ReadStudio(c.Snapshot.Studio.OID)
	if err != nil {
		return nil, err
	}
	out := &StudioView{CommitOID: oid, StudioTree: c.Snapshot.Studio.OID, Files: make(map[string]string, len(files))}
	for k, v := range files {
		out.Files[k] = string(v)
	}
	return out, nil
}
