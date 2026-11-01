package compiler

import (
	"encoding/json"
	"fmt"

	"studio.local/pipeline/internal/contracts"
)

// normalize decodes a schema-valid graph and applies the zod defaults, so an
// omitted default and an explicit one produce the same graph and digest.
func normalize(raw []byte) (*contracts.Graph, error) {
	var g contracts.Graph
	if err := contracts.DecodeStrict(raw, &g); err != nil {
		return nil, fmt.Errorf("decode graph: %w", err)
	}
	var rest struct {
		Policy json.RawMessage `json:"policy"`
		Limits json.RawMessage `json:"limits"`
	}
	if err := json.Unmarshal(raw, &rest); err != nil {
		return nil, err
	}
	pol, err := normPolicy(rest.Policy)
	if err != nil {
		return nil, err
	}
	lim, err := normLimits(rest.Limits)
	if err != nil {
		return nil, err
	}
	g.Policy, g.Limits = &pol, &lim
	if g.Inputs == nil {
		g.Inputs = map[string]contracts.Input{}
	}
	for k, in := range g.Inputs {
		if in.PinAtRunStart == nil {
			t := true
			in.PinAtRunStart = &t
		}
		g.Inputs[k] = in
	}
	if g.Outputs == nil {
		g.Outputs = map[string]string{}
	}
	for i := range g.Steps {
		s := &g.Steps[i]
		if s.Needs == nil {
			s.Needs = []string{}
		}
		if s.Inputs == nil {
			s.Inputs = map[string]string{}
		}
		if s.With == nil {
			s.With = map[string]json.RawMessage{}
		}
		if s.OnFailure == "" {
			s.OnFailure = "fail"
		}
	}
	return &g, nil
}

func normPolicy(raw json.RawMessage) (contracts.Policy, error) {
	p := contracts.DefaultPolicy()
	if len(raw) == 0 || string(raw) == "null" {
		return p, nil
	}
	var in struct {
		Review         *string `json:"review"`
		PartialSuccess *struct {
			Allowed         *bool    `json:"allowed"`
			MinSuccessRatio *float64 `json:"min_success_ratio"`
		} `json:"partial_success"`
		DeadlineSeconds *int    `json:"deadline_seconds"`
		Compatibility   *string `json:"compatibility"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return p, err
	}
	if in.Review != nil {
		p.Review = *in.Review
	}
	if in.PartialSuccess != nil {
		if in.PartialSuccess.Allowed != nil {
			p.PartialSuccess.Allowed = *in.PartialSuccess.Allowed
		}
		if in.PartialSuccess.MinSuccessRatio != nil {
			p.PartialSuccess.MinSuccessRatio = *in.PartialSuccess.MinSuccessRatio
		}
	}
	if in.DeadlineSeconds != nil {
		p.DeadlineSeconds = *in.DeadlineSeconds
	}
	if in.Compatibility != nil {
		p.Compatibility = *in.Compatibility
	}
	return p, nil
}

func normLimits(raw json.RawMessage) (contracts.Limits, error) {
	l := contracts.DefaultLimits()
	if len(raw) == 0 || string(raw) == "null" {
		return l, nil
	}
	var in struct {
		MaxSteps             *int `json:"max_steps"`
		MaxPartitionsPerStep *int `json:"max_partitions_per_step"`
		MaxTotalPartitions   *int `json:"max_total_partitions"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return l, err
	}
	if in.MaxSteps != nil {
		l.MaxSteps = *in.MaxSteps
	}
	if in.MaxPartitionsPerStep != nil {
		l.MaxPartitionsPerStep = *in.MaxPartitionsPerStep
	}
	if in.MaxTotalPartitions != nil {
		l.MaxTotalPartitions = *in.MaxTotalPartitions
	}
	return l, nil
}
