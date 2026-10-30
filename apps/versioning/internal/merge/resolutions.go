package merge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
)

// Resolution choices.
const (
	ChooseOurs   = "ours"
	ChooseTheirs = "theirs"
	ChooseCustom = "custom"
)

// Resolution resolves one conflict. Custom carries a replacement entry: a
// Sample for sample:<id>, an Annotation (pointing at a new, already uploaded
// annotation revision) for annotation:<id>:<field>, or an OntologyClass.
type Resolution struct {
	Key    string          `json:"conflict_key"`
	Choice string          `json:"choice"`
	Custom json.RawMessage `json:"custom,omitempty"`
}

// ErrUnresolved is returned when conflicts remain without a resolution.
var ErrUnresolved = errors.New("unresolved conflicts")

// Apply resolves every conflict in out and returns the final manifest. The
// caller must validate the result again before committing it.
func Apply(ctx context.Context, in Input, out *Outcome, res []Resolution) (*manifests.Manifest, error) {
	byKey := map[string]Resolution{}
	for _, r := range res {
		byKey[r.Key] = r
	}
	var missing []string
	for _, c := range out.Conflicts {
		if _, ok := byKey[c.Key]; !ok {
			missing = append(missing, c.Key)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("%w: %v", ErrUnresolved, missing)
	}
	samples := map[string]manifests.Sample{}
	for _, s := range out.Merged.Samples {
		samples[s.SampleID] = s
	}
	anns := map[string]manifests.Annotation{}
	for _, a := range out.Merged.Annotations {
		anns[a.AnnotationID] = a
	}
	classes := map[string]manifests.OntologyClass{}
	for _, c := range out.Ontology.Classes {
		classes[c.ClassID] = c
	}
	// Field conflicts on one annotation are applied to one working revision.
	working := map[string]*manifests.AnnotationRevision{}
	srcAnn := map[string]manifests.Annotation{}

	for _, c := range out.Conflicts {
		r := byKey[c.Key]
		if r.Choice != ChooseOurs && r.Choice != ChooseTheirs && r.Choice != ChooseCustom {
			return nil, fmt.Errorf("conflict %s: invalid choice %q", c.Key, r.Choice)
		}
		kind, id, field := KeyParts(c.Key)
		switch kind {
		case "sample":
			var pick *manifests.Sample
			switch r.Choice {
			case ChooseOurs:
				pick, _ = c.ours.(*manifests.Sample)
			case ChooseTheirs:
				pick, _ = c.theirs.(*manifests.Sample)
			case ChooseCustom:
				var s manifests.Sample
				if err := strictJSON(r.Custom, &s); err != nil || s.SampleID != id {
					return nil, fmt.Errorf("conflict %s: custom must be a sample with sample_id %s", c.Key, id)
				}
				pick = &s
			}
			if pick == nil {
				delete(samples, id)
			} else {
				samples[id] = *pick
			}
		case "ontology":
			var pick *manifests.OntologyClass
			switch r.Choice {
			case ChooseOurs:
				pick, _ = c.ours.(*manifests.OntologyClass)
			case ChooseTheirs:
				pick, _ = c.theirs.(*manifests.OntologyClass)
			case ChooseCustom:
				var oc manifests.OntologyClass
				if err := strictJSON(r.Custom, &oc); err != nil || oc.ClassID != id {
					return nil, fmt.Errorf("conflict %s: custom must be a class with class_id %s", c.Key, id)
				}
				pick = &oc
			}
			if pick == nil {
				delete(classes, id)
			} else {
				classes[id] = *pick
			}
		case "annotation":
			oa, _ := c.ours.(*manifests.Annotation)
			ta, _ := c.theirs.(*manifests.Annotation)
			if r.Choice == ChooseCustom {
				var a manifests.Annotation
				if err := strictJSON(r.Custom, &a); err != nil || a.AnnotationID != id {
					return nil, fmt.Errorf("conflict %s: custom must be an annotation with annotation_id %s", c.Key, id)
				}
				anns[id] = a
				delete(working, id)
				continue
			}
			pick := oa
			if r.Choice == ChooseTheirs {
				pick = ta
			}
			switch field {
			case "deleted", "sample_deleted", "duplicate_geometry", semanticdiff.FieldClass + "_removed":
				if pick == nil {
					delete(anns, id)
					continue
				}
				anns[id] = *pick
				if _, ok := samples[pick.SampleID]; !ok {
					restored := findSample(pick.SampleID, in.Ours, in.Theirs, in.Base)
					if restored == nil {
						return nil, fmt.Errorf("conflict %s: sample %s not found on any side", c.Key, pick.SampleID)
					}
					samples[pick.SampleID] = *restored
				}
			default: // a field conflict: copy that field from the chosen side
				if oa == nil || ta == nil {
					return nil, fmt.Errorf("conflict %s: missing side", c.Key)
				}
				w := working[id]
				if w == nil {
					cur, ok := anns[id]
					if !ok {
						cur = *oa
					}
					rev, err := in.Revisions.LoadRevision(ctx, cur.Ref)
					if err != nil {
						return nil, err
					}
					cp := *rev
					w = &cp
					working[id] = w
					srcAnn[id] = cur
				}
				chosen, err := in.Revisions.LoadRevision(ctx, pick.Ref)
				if err != nil {
					return nil, err
				}
				semanticdiff.SetField(w, chosen, field)
			}
		default:
			return nil, fmt.Errorf("conflict %s: unknown kind", c.Key)
		}
	}
	for id, w := range working {
		base := srcAnn[id]
		w.Provenance = manifests.Provenance{ActorID: "merge", Tool: "versioning.resolution", ParentRevision: base.Ref}
		_, ref, err := manifests.EncodeRevision(w)
		if err != nil {
			return nil, err
		}
		out.NewRevisions[ref] = w
		base.Ref, base.ClassID, base.OntologyRev = ref, w.ClassID, w.OntologyRev
		base.RevisionID = "r" + manifests.RefHex(ref)[:25]
		anns[id] = base
	}
	final := &manifests.Manifest{SchemaVersion: manifests.SchemaVersion, Ontology: out.Ontology}
	final.Ontology.Classes = nil
	for _, c := range classes {
		final.Ontology.Classes = append(final.Ontology.Classes, c)
	}
	final.Sort()
	if !reflect.DeepEqual(final.Ontology.Classes, out.Ontology.Classes) {
		final.Ontology.RevisionID = "resolved-" + manifests.EntryHash(final.Ontology.Classes)[:22]
	}
	for _, s := range samples {
		final.Samples = append(final.Samples, s)
	}
	for _, a := range anns {
		if _, ok := samples[a.SampleID]; ok {
			final.Annotations = append(final.Annotations, a)
		}
	}
	if final.Samples == nil {
		final.Samples = []manifests.Sample{}
	}
	if final.Annotations == nil {
		final.Annotations = []manifests.Annotation{}
	}
	final.Sort()
	return final, nil
}

func findSample(id string, ms ...*manifests.Manifest) *manifests.Sample {
	for _, m := range ms {
		if m == nil {
			continue
		}
		for i := range m.Samples {
			if m.Samples[i].SampleID == id {
				return &m.Samples[i]
			}
		}
	}
	return nil
}

func strictJSON(b []byte, v any) error {
	if len(b) == 0 {
		return errors.New("empty")
	}
	return json.Unmarshal(b, v)
}
