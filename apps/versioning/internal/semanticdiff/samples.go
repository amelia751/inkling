package semanticdiff

import (
	"reflect"
	"sort"

	"studio.local/versioning/internal/manifests"
)

// SampleFields compares two versions of a sample. Content fields (objects,
// modality, dimensions) make it a replacement; grouping fields (study,
// series, sequence, split) a grouping change.
func SampleFields(a, b *manifests.Sample) (content, grouping []string) {
	ao, bo := map[string]manifests.ObjectRef{}, map[string]manifests.ObjectRef{}
	for _, o := range a.Objects {
		ao[o.Role] = o
	}
	for _, o := range b.Objects {
		bo[o.Role] = o
	}
	roles := map[string]bool{}
	for r := range ao {
		roles[r] = true
	}
	for r := range bo {
		roles[r] = true
	}
	for r := range roles {
		if ao[r] != bo[r] {
			content = append(content, "objects."+r)
		}
	}
	sort.Strings(content)
	if a.Modality != b.Modality {
		content = append(content, "modality")
	}
	if a.Width != b.Width || a.Height != b.Height || a.Depth != b.Depth || a.Duration != b.Duration {
		content = append(content, "dimensions")
	}
	ag, bg := groupOf(a), groupOf(b)
	if ag.StudyUIDHash != bg.StudyUIDHash {
		grouping = append(grouping, "study_uid_hash")
	}
	if ag.SeriesUIDHash != bg.SeriesUIDHash {
		grouping = append(grouping, "series_uid_hash")
	}
	if ag.Sequence != bg.Sequence {
		grouping = append(grouping, "sequence")
	}
	if a.Split != b.Split {
		grouping = append(grouping, "split")
	}
	return content, grouping
}

func groupOf(s *manifests.Sample) manifests.Grouping {
	if s.Group == nil {
		return manifests.Grouping{}
	}
	return *s.Group
}

// SampleEqual reports whether two sample entries are identical.
func SampleEqual(a, b *manifests.Sample) bool {
	return reflect.DeepEqual(normSample(a), normSample(b))
}

func normSample(s *manifests.Sample) manifests.Sample {
	c := *s
	if c.Group != nil && *c.Group == (manifests.Grouping{}) {
		c.Group = nil
	}
	c.Objects = append([]manifests.ObjectRef(nil), s.Objects...)
	sort.Slice(c.Objects, func(i, j int) bool { return c.Objects[i].Role < c.Objects[j].Role })
	return c
}
