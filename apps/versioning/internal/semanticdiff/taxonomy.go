package semanticdiff

import (
	"sort"

	"studio.local/versioning/internal/manifests"
)

// DiffOntology reports class additions, removals, renames (stable class_id,
// new name: the mapping is the id itself) and newly required fields. Names
// are not emitted; ids and field tokens only.
func DiffOntology(base, head manifests.Ontology) []Change {
	bm := map[string]manifests.OntologyClass{}
	for _, c := range base.Classes {
		bm[c.ClassID] = c
	}
	hm := map[string]manifests.OntologyClass{}
	for _, c := range head.Classes {
		hm[c.ClassID] = c
	}
	var out []Change
	for id, h := range hm {
		b, ok := bm[id]
		if !ok {
			out = append(out, Change{Type: OntologyClassAdded, ClassID: id})
			continue
		}
		if b.Name != h.Name {
			out = append(out, Change{Type: OntologyClassRename, ClassID: id})
		}
		had := map[string]bool{}
		for _, f := range b.RequiredFields {
			had[f] = true
		}
		var added []string
		for _, f := range h.RequiredFields {
			if !had[f] {
				added = append(added, f)
			}
		}
		if len(added) > 0 {
			sort.Strings(added)
			out = append(out, Change{Type: OntologyRequiredAdd, ClassID: id, Fields: added})
		}
	}
	for id := range bm {
		if _, ok := hm[id]; !ok {
			out = append(out, Change{Type: OntologyClassRemove, ClassID: id})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ClassID != out[j].ClassID {
			return out[i].ClassID < out[j].ClassID
		}
		return out[i].Type < out[j].Type
	})
	return out
}
