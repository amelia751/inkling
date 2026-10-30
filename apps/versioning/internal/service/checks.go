package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
)

type checkResult struct {
	name    string
	outcome string
	details map[string]any
}

// RunChecks computes the built-in checks for an immutable (source, target)
// pair. Results never come from user-supplied flags (spec §9). A job for
// superseded oids is a no-op.
func (s *Service) RunChecks(ctx context.Context, a ReviewChecksArgs) error {
	p := systemPrincipal(a.TenantID)
	var r db.VersioningReviewRequest
	if err := s.read(ctx, a.TenantID, func(q *db.Queries) error {
		var err error
		r, err = s.reviewRow(ctx, q, a.RepoID, a.ReviewID, false)
		return err
	}); err != nil {
		return err
	}
	if r.Status != StChecking || r.SourceOid != a.SourceOID || deref(r.CheckedTargetOid) != a.TargetOID {
		return nil
	}
	var results []checkResult
	var conflicts []db.UpsertConflictParams
	pl, err := s.planMerge(ctx, a.TenantID, a.RepoID, a.TargetOID, a.SourceOID)
	var se *Error
	switch {
	case errors.As(err, &se) && se.Code == "multiple_merge_bases":
		results = append(results, checkResult{CheckMergeBase, outcomeFailed, map[string]any{"code": se.Code}})
		for _, n := range []string{CheckReferential, CheckArtifacts, CheckSchema, CheckGeometry} {
			results = append(results, checkResult{n, outcomeFailed, map[string]any{"code": "skipped_no_merge_base"}})
		}
	case err != nil:
		return err
	default:
		results = append(results, checkResult{CheckMergeBase, outcomePassed, map[string]any{"base_oid": pl.base}})
		for _, c := range pl.outcome.Conflicts {
			conflicts = append(conflicts, db.UpsertConflictParams{TenantID: a.TenantID, ReviewID: r.ID, SourceOid: a.SourceOID,
				TargetOid: a.TargetOID, ConflictKey: c.Key, Kind: string(c.Situation), SampleID: strOrNil(c.SampleID),
				AnnotationID: strOrNil(c.AnnotationID), Field: strOrNil(c.Field), BaseRef: strOrNil(c.BaseRef),
				OursRef: strOrNil(c.OursRef), TheirsRef: strOrNil(c.TheirsRef)})
		}
		more, err := s.sourceChecks(ctx, a.TenantID, a.RepoID, pl)
		if err != nil {
			return err
		}
		results = append(results, more...)
	}
	return s.tx(ctx, a.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		cur, err := s.reviewRow(ctx, q, a.RepoID, a.ReviewID, true)
		if err != nil {
			return err
		}
		if cur.Status != StChecking || cur.SourceOid != a.SourceOID || deref(cur.CheckedTargetOid) != a.TargetOID {
			return nil
		}
		for _, c := range conflicts {
			if err := q.UpsertConflict(ctx, c); err != nil {
				return err
			}
		}
		for _, c := range results {
			b, _ := json.Marshal(c.details)
			if err := q.UpsertCheck(ctx, db.UpsertCheckParams{TenantID: a.TenantID, ReviewID: r.ID, SourceOid: a.SourceOID,
				TargetOid: a.TargetOID, Name: c.name, Mandatory: isMandatory(c.name), Outcome: c.outcome, Details: b}); err != nil {
				return err
			}
		}
		_, err = s.evaluate(ctx, q, p, cur)
		return err
	})
}

// sourceChecks validates what the review introduces: entries that changed
// between the merge base and the source.
func (s *Service) sourceChecks(ctx context.Context, tenant, repoID string, pl *mergePlan) ([]checkResult, error) {
	base, src := pl.input.Base, pl.input.Theirs
	var out []checkResult

	// Referential integrity of the changed partitions (annotations share their
	// sample's bucket, so a partition is self-contained).
	if err := manifests.Validate(src, 0); err != nil {
		out = append(out, checkResult{CheckReferential, outcomeFailed, problems(err)})
	} else {
		out = append(out, checkResult{CheckReferential, outcomePassed, map[string]any{}})
	}

	d := &semanticdiff.Differ{Revisions: s.revisions(tenant), Rules: s.Rules}
	diff, err := d.DiffManifests(ctx, base, src)
	if err != nil {
		return nil, err
	}
	samples := map[string]*manifests.Sample{}
	for i := range src.Samples {
		samples[src.Samples[i].SampleID] = &src.Samples[i]
	}
	var hashes []string
	var changedAnns []manifests.Annotation
	anns := map[string]manifests.Annotation{}
	for _, a := range src.Annotations {
		anns[a.AnnotationID] = a
	}
	for _, c := range diff.Changes {
		switch c.Type {
		case semanticdiff.SampleAdded, semanticdiff.SampleReplaced:
			for _, o := range samples[c.SampleID].Objects {
				hashes = append(hashes, o.SHA256)
			}
		case semanticdiff.AnnotationAdded, semanticdiff.AnnotationChanged:
			a := anns[c.AnnotationID]
			changedAnns = append(changedAnns, a)
			hashes = append(hashes, manifests.RefHex(a.Ref))
		}
	}
	out = append(out, s.checkObjects(ctx, tenant, hashes))

	// Schema compatibility: the merged result must still validate against the
	// merged ontology (class removals, required fields). Conflicts gate
	// separately, so a conflicted preview is not a schema failure.
	if len(pl.outcome.Conflicts) == 0 {
		if err := manifests.Validate(pl.outcome.Merged, 0); err != nil {
			out = append(out, checkResult{CheckSchema, outcomeFailed, problems(err)})
		} else {
			out = append(out, checkResult{CheckSchema, outcomePassed, map[string]any{}})
		}
	} else {
		out = append(out, checkResult{CheckSchema, outcomePassed, map[string]any{"note": "conflicts pending"}})
	}

	out = append(out, s.checkGeometry(ctx, tenant, changedAnns, samples))
	out = append(out, leakageCheck(src), checkResult{CheckClassBalance, outcomePassed,
		map[string]any{"class_balance_delta": diff.Aggregates.ClassBalanceDelta, "split_delta": diff.Aggregates.SplitDelta}})
	return out, nil
}

func problems(err error) map[string]any {
	var ve *manifests.ValidationError
	if errors.As(err, &ve) {
		return map[string]any{"problems": cap10(ve.Problems)}
	}
	return map[string]any{"error": "invalid"}
}

func (s *Service) checkObjects(ctx context.Context, tenant string, hashes []string) checkResult {
	var bad []string
	_ = s.read(ctx, tenant, func(q *db.Queries) error {
		for i := 0; i < len(hashes); i += artifactBatch {
			chunk := hashes[i:min(i+artifactBatch, len(hashes))]
			rows, err := q.ArtifactsBySHA(ctx, db.ArtifactsBySHAParams{TenantID: tenant, Hashes: chunk})
			if err != nil {
				return err
			}
			byHash := map[string]db.VersioningArtifact{}
			for _, r := range rows {
				byHash[r.ContentSha256] = r
			}
			for _, h := range chunk {
				a, ok := byHash[h]
				if !ok || (a.Status != "available" && a.Status != "staged" && a.Status != "unreferenced") {
					bad = append(bad, h)
					continue
				}
				info, err := s.Blobs.Head(ctx, tenant, h)
				if err != nil || info.Size != a.SizeBytes {
					bad = append(bad, h)
				}
			}
		}
		return nil
	})
	if len(bad) > 0 {
		return checkResult{CheckArtifacts, outcomeFailed, map[string]any{"missing_or_mismatched": cap10(bad), "count": len(bad)}}
	}
	return checkResult{CheckArtifacts, outcomePassed, map[string]any{"verified": len(hashes)}}
}

func (s *Service) checkGeometry(ctx context.Context, tenant string, anns []manifests.Annotation, samples map[string]*manifests.Sample) checkResult {
	var bad []string
	loader := s.revisions(tenant)
	for _, a := range anns {
		rev, err := loader.LoadRevision(ctx, a.Ref)
		if err != nil {
			bad = append(bad, a.AnnotationID+": revision unreadable")
			continue
		}
		if msg := geometryProblem(a, rev, samples[a.SampleID]); msg != "" {
			bad = append(bad, a.AnnotationID+": "+msg)
		}
	}
	if len(bad) > 0 {
		return checkResult{CheckGeometry, outcomeFailed, map[string]any{"problems": cap10(bad), "count": len(bad)}}
	}
	return checkResult{CheckGeometry, outcomePassed, map[string]any{"checked": len(anns)}}
}

// geometryProblem checks a revision is well formed, matches its manifest
// entry, is inside the sample's bounds and is not degenerate.
func geometryProblem(a manifests.Annotation, r *manifests.AnnotationRevision, smp *manifests.Sample) string {
	if err := manifests.ValidateRevision(r); err != nil {
		return "invalid revision"
	}
	if r.AnnotationID != a.AnnotationID || r.SampleID != a.SampleID || r.Kind != a.Kind || r.ClassID != a.ClassID {
		return "manifest entry does not match revision"
	}
	if smp == nil {
		return "unknown sample"
	}
	w, h := float64(smp.Width), float64(smp.Height)
	in := func(x, y float64) bool {
		return (w == 0 || (x >= -0.5 && x <= w+0.5)) && (h == 0 || (y >= -0.5 && y <= h+0.5))
	}
	g := r.Geometry
	switch r.Kind {
	case manifests.KindBox2D:
		if g.Box[2] <= 0 || g.Box[3] <= 0 {
			return "degenerate box"
		}
		if !in(g.Box[0], g.Box[1]) || !in(g.Box[0]+g.Box[2], g.Box[1]+g.Box[3]) {
			return "box out of bounds"
		}
	case manifests.KindPolygon2D:
		area := 0.0
		for i := range g.Points {
			j := (i + 1) % len(g.Points)
			area += g.Points[i][0]*g.Points[j][1] - g.Points[j][0]*g.Points[i][1]
			if !in(g.Points[i][0], g.Points[i][1]) {
				return "polygon out of bounds"
			}
		}
		if math.Abs(area) < 1e-9 {
			return "degenerate polygon"
		}
	case manifests.KindMask2D:
		if smp.Width > 0 && (g.Mask.Size[0] != smp.Height || g.Mask.Size[1] != smp.Width) {
			return "mask size does not match sample"
		}
		fg := 0
		for i, c := range g.Mask.Counts {
			if i%2 == 1 {
				fg += c
			}
		}
		if fg == 0 {
			return "empty mask"
		}
	case manifests.KindRegion3D:
		for k := 0; k < 3; k++ {
			if g.Box3D[k+3] <= g.Box3D[k] {
				return "degenerate 3-D region"
			}
		}
	case manifests.KindTimespan:
		if *g.End <= *g.Start || *g.Start < 0 || (smp.Duration > 0 && *g.End > smp.Duration+1e-6) {
			return "timespan out of range"
		}
	case manifests.KindTextspan:
		if *g.End <= *g.Start || *g.Start < 0 {
			return "empty text span"
		}
	case manifests.KindMeasurement:
		for _, pt := range g.Points {
			if len(pt) >= 2 && !in(pt[0], pt[1]) {
				return "measurement out of bounds"
			}
		}
	}
	return ""
}

// leakageCheck reports studies whose samples sit in more than one split.
func leakageCheck(m *manifests.Manifest) checkResult {
	splits := map[string]map[string]bool{}
	for _, smp := range m.Samples {
		if smp.Group == nil || smp.Group.StudyUIDHash == "" || smp.Split == "" {
			continue
		}
		if splits[smp.Group.StudyUIDHash] == nil {
			splits[smp.Group.StudyUIDHash] = map[string]bool{}
		}
		splits[smp.Group.StudyUIDHash][smp.Split] = true
	}
	var leaking []string
	for study, ss := range splits {
		if len(ss) > 1 {
			leaking = append(leaking, study)
		}
	}
	if len(leaking) > 0 {
		return checkResult{CheckLeakage, outcomeFailed, map[string]any{"studies_across_splits": cap10(leaking), "count": len(leaking)}}
	}
	return checkResult{CheckLeakage, outcomePassed, map[string]any{}}
}
