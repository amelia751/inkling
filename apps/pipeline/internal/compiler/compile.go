// Package compiler turns a pipeline graph (docs/pipeline.md §4) into a frozen
// execution plan: schema check, unique ids, known dependencies, cycle
// detection, reference and port-type checks, resolution of every step to one
// signed immutable version, bounded fan-out, and a plan digest over the
// RFC 8785 canonical form. A run pins the plan; nothing is re-resolved later.
package compiler

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"studio.local/pipeline/internal/contracts"
)

// Diagnostic codes (packages/contracts/src/pipeline/plan.ts COMPILE_CODES).
const (
	CodeSchema                 = "schema"
	CodeDuplicateStep          = "duplicate_step"
	CodeUnknownStep            = "unknown_step"
	CodeCycle                  = "cycle"
	CodeUnknownRef             = "unknown_ref"
	CodeRefNotUpstream         = "ref_not_upstream"
	CodeTypeMismatch           = "type_mismatch"
	CodeMissingInput           = "missing_input"
	CodeUnknownPort            = "unknown_port"
	CodeUnresolvedStep         = "unresolved_step"
	CodeUnsignedStep           = "unsigned_step"
	CodeModalityMismatch       = "modality_mismatch"
	CodeFanOutUnbounded        = "fan_out_unbounded"
	CodeFanOutNotPartitionable = "fan_out_not_partitionable"
	CodeLimitExceeded          = "limit_exceeded"
	CodeUnknownOutput          = "unknown_output"
)

// Defaults the compiler applies when neither the graph nor the contract says.
const (
	DefaultTimeoutSeconds = 1800
	DefaultMaxAttempts    = 3
	maxDiagnostics        = 200
)

// Options tune one compilation.
type Options struct {
	// DefinitionID is recorded in the plan.
	DefinitionID string
}

// Result is a plan or the reasons there isn't one.
type Result struct {
	Plan        *contracts.Plan
	Graph       *contracts.Graph // normalised: defaults applied
	Diagnostics []contracts.Diagnostic
}

// OK reports whether compilation produced a plan.
func (r *Result) OK() bool { return r.Plan != nil && len(r.Diagnostics) == 0 }

// Report is the validate route's answer.
func (r *Result) Report() contracts.ValidationReport {
	out := contracts.ValidationReport{OK: r.OK(), Diagnostics: r.Diagnostics}
	if out.Diagnostics == nil {
		out.Diagnostics = []contracts.Diagnostic{}
	}
	if r.Plan != nil {
		out.DefinitionDigest, out.PlanDigest = r.Plan.DefinitionDigest, r.Plan.Digest
	}
	return out
}

// Err summarises the diagnostics as an error, or nil.
func (r *Result) Err() error {
	if r.OK() {
		return nil
	}
	parts := make([]string, 0, len(r.Diagnostics))
	for _, d := range r.Diagnostics {
		parts = append(parts, d.Code+" at "+d.Path+": "+d.Message)
	}
	return errors.New("pipeline graph: " + strings.Join(parts, "; "))
}

type diags struct{ list []contracts.Diagnostic }

func (d *diags) add(code, path, format string, a ...any) {
	if len(d.list) >= maxDiagnostics {
		return
	}
	msg := fmt.Sprintf(format, a...)
	if len(msg) > 300 {
		msg = msg[:300]
	}
	d.list = append(d.list, contracts.Diagnostic{Code: code, Path: path, Message: msg})
}

var (
	usesRE     = regexp.MustCompile(`^([a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)@([0-9]{1,4})$`)
	inputRefRE = regexp.MustCompile(`^\$\{inputs\.([a-z][a-z0-9_]*)\}$`)
	stepRefRE  = regexp.MustCompile(`^\$\{steps\.([a-z][a-z0-9_-]*)\.outputs\.([a-z][a-z0-9_]*)\}$`)
)

// ref is a parsed reference.
type ref struct {
	input      string
	step, port string
}

func parseRef(s string) (ref, bool) {
	if m := inputRefRE.FindStringSubmatch(s); m != nil {
		return ref{input: m[1]}, true
	}
	if m := stepRefRE.FindStringSubmatch(s); m != nil {
		return ref{step: m[1], port: m[2]}, true
	}
	return ref{}, false
}

// inputPortType maps a graph input type to the port type it feeds.
func inputPortType(t string) string {
	switch t {
	case "dataset":
		return contracts.PortDatasetCommit
	default: // upload_session, artifact_set share their name
		return t
	}
}

// Compile validates raw graph JSON and builds its plan.
func Compile(raw []byte, res Resolver, opt Options) *Result {
	out := &Result{}
	d := &diags{}
	defer func() { out.Diagnostics = d.list }()

	if err := contracts.Validate(contracts.SchemaGraph, raw); err != nil {
		var ve *contracts.ValidationError
		if !errors.As(err, &ve) {
			d.add(CodeSchema, "", "%v", err)
			return out
		}
		for _, v := range ve.Violations {
			d.add(CodeSchema, v.Path, "%s", v.Message)
		}
		return out
	}
	g, err := normalize(raw)
	if err != nil {
		d.add(CodeSchema, "", "%v", err)
		return out
	}
	out.Graph = g

	index := map[string]int{}
	for i, s := range g.Steps {
		if _, dup := index[s.ID]; dup {
			d.add(CodeDuplicateStep, fmt.Sprintf("/steps/%d/id", i), "step %s is defined twice", s.ID)
			continue
		}
		index[s.ID] = i
	}
	for i, s := range g.Steps {
		for j, n := range s.Needs {
			if _, ok := index[n]; !ok {
				d.add(CodeUnknownStep, fmt.Sprintf("/steps/%d/needs/%d", i, j), "step %s needs unknown step %s", s.ID, n)
			} else if n == s.ID {
				d.add(CodeCycle, fmt.Sprintf("/steps/%d/needs/%d", i, j), "step %s needs itself", s.ID)
			}
		}
	}
	if len(g.Steps) > g.Limits.MaxSteps {
		d.add(CodeLimitExceeded, "/steps", "%d steps exceed the limit of %d", len(g.Steps), g.Limits.MaxSteps)
	}
	if len(d.list) > 0 {
		return out
	}

	order, cyc := topoSort(g.Steps, index)
	if cyc != nil {
		d.add(CodeCycle, fmt.Sprintf("/steps/%d/needs", index[cyc[0]]), "dependency cycle: %s", strings.Join(cyc, " → "))
		return out
	}
	ancestors := closure(g.Steps, order, index)

	contractsByStep := make([]*Resolution, len(g.Steps))
	for i, s := range g.Steps {
		m := usesRE.FindStringSubmatch(s.Uses)
		major, _ := strconv.Atoi(m[2])
		r, err := res.Resolve(m[1], major)
		switch {
		case errors.Is(err, ErrUnsigned):
			d.add(CodeUnsignedStep, fmt.Sprintf("/steps/%d/uses", i), "%s resolves only to an unsigned version", s.Uses)
		case err != nil:
			d.add(CodeUnresolvedStep, fmt.Sprintf("/steps/%d/uses", i), "%s is not an installed, approved, signed version", s.Uses)
		default:
			r := r
			contractsByStep[i] = &r
		}
	}

	planned := make(map[string]contracts.PlannedStep, len(g.Steps))
	totalPartitions := 0
	for i, s := range g.Steps {
		r := contractsByStep[i]
		if r == nil {
			continue
		}
		c := r.Contract
		base := fmt.Sprintf("/steps/%d", i)
		ps := contracts.PlannedStep{ID: s.ID, Uses: s.Uses, Resolved: r.Resolved, Runtime: c.Runtime, JobKind: c.JobKind,
			Plugin: c.Plugin, Needs: append([]string{}, s.Needs...), Inputs: map[string]contracts.PlannedInput{},
			Outputs: map[string]string{}, Params: s.With, Optional: s.Optional, OnFailure: s.OnFailure}
		if ps.Params == nil {
			ps.Params = map[string]json.RawMessage{}
		}
		for _, name := range sortedKeys(c.Outputs) {
			ps.Outputs[name] = c.Outputs[name].Type
		}
		for _, name := range sortedKeys(s.Inputs) {
			path := base + "/inputs/" + name
			spec, ok := c.Inputs[name]
			if !ok {
				d.add(CodeUnknownPort, path, "%s has no input %s", s.Uses, name)
				continue
			}
			typ, mods, ok := refType(g, index, contractsByStep, ancestors, s.ID, s.Inputs[name], path, d)
			if !ok {
				continue
			}
			if typ != spec.Type {
				d.add(CodeTypeMismatch, path, "input %s wants %s, got %s", name, spec.Type, typ)
				continue
			}
			if len(spec.Modalities) > 0 && len(mods) > 0 && !subset(mods, spec.Modalities) {
				d.add(CodeModalityMismatch, path, "input %s accepts %s, the source produces %s", name,
					strings.Join(spec.Modalities, ","), strings.Join(mods, ","))
				continue
			}
			ps.Inputs[name] = contracts.PlannedInput{Ref: s.Inputs[name], Type: typ}
		}
		for _, name := range sortedKeys(c.Inputs) {
			if _, bound := s.Inputs[name]; !bound && c.Inputs[name].IsRequired() {
				d.add(CodeMissingInput, base+"/inputs", "required input %s of %s is not bound", name, s.Uses)
			}
		}

		partitions := 1
		if s.FanOut != nil {
			fp := base + "/fan_out"
			bound := false
			for _, v := range s.Inputs {
				bound = bound || v == s.FanOut.Over
			}
			switch {
			case !bound:
				d.add(CodeFanOutUnbounded, fp+"/over", "fan-out source must be one of the step's own inputs")
			case !c.Partitionable:
				d.add(CodeFanOutNotPartitionable, fp, "%s can't run per partition", s.Uses)
			default:
				for _, name := range sortedKeys(s.Inputs) {
					if s.Inputs[name] == s.FanOut.Over {
						if t := c.Inputs[name].Type; t != contracts.PortItemSet && t != contracts.PortArtifactSet {
							d.add(CodeTypeMismatch, fp+"/over", "fan-out needs an item or artifact set, got %s", t)
						}
						break
					}
				}
			}
			if s.FanOut.MaxPartitions > g.Limits.MaxPartitionsPerStep {
				d.add(CodeLimitExceeded, fp+"/max_partitions", "%d partitions exceed the per-step limit of %d",
					s.FanOut.MaxPartitions, g.Limits.MaxPartitionsPerStep)
			}
			partitions = s.FanOut.MaxPartitions
			fo := *s.FanOut
			ps.FanOut = &fo
		}
		totalPartitions += partitions

		ps.ResourceClass = resourceClass(s, c)
		ps.TimeoutSeconds = c.DefaultTimeoutSeconds
		ps.MaxAttempts = DefaultMaxAttempts
		if c.Runtime == contracts.RuntimeBuiltin {
			ps.MaxAttempts = 1
		}
		if s.Execution != nil {
			if s.Execution.TimeoutSeconds > 0 {
				ps.TimeoutSeconds = s.Execution.TimeoutSeconds
			}
			if s.Execution.MaxAttempts > 0 {
				ps.MaxAttempts = s.Execution.MaxAttempts
			}
		}
		if ps.TimeoutSeconds == 0 {
			ps.TimeoutSeconds = DefaultTimeoutSeconds
		}
		if ps.TimeoutSeconds > g.Policy.DeadlineSeconds {
			d.add(CodeLimitExceeded, base+"/execution/timeout_seconds", "timeout %ds exceeds the run deadline of %ds",
				ps.TimeoutSeconds, g.Policy.DeadlineSeconds)
		}
		pd, err := Digest(ps.Params)
		if err != nil {
			d.add(CodeSchema, base+"/with", "parameters aren't canonical JSON: %v", err)
			continue
		}
		ps.ParamsDigest = pd
		planned[s.ID] = ps
	}
	if totalPartitions > g.Limits.MaxTotalPartitions {
		d.add(CodeLimitExceeded, "/steps", "%d partitions in total exceed the limit of %d", totalPartitions, g.Limits.MaxTotalPartitions)
	}

	outputs := map[string]contracts.PlannedInput{}
	for _, name := range sortedKeys(g.Outputs) {
		path := "/outputs/" + name
		r, ok := parseRef(g.Outputs[name])
		if !ok || r.step == "" {
			d.add(CodeUnknownOutput, path, "pipeline outputs must be step outputs")
			continue
		}
		i, known := index[r.step]
		if !known {
			d.add(CodeUnknownOutput, path, "unknown step %s", r.step)
			continue
		}
		if contractsByStep[i] == nil {
			continue
		}
		spec, ok := contractsByStep[i].Contract.Outputs[r.port]
		if !ok {
			d.add(CodeUnknownOutput, path, "step %s has no output %s", r.step, r.port)
			continue
		}
		outputs[name] = contracts.PlannedInput{Ref: g.Outputs[name], Type: spec.Type}
	}
	if len(d.list) > 0 {
		return out
	}

	defDigest, err := Digest(g)
	if err != nil {
		d.add(CodeSchema, "", "graph isn't canonical JSON: %v", err)
		return out
	}
	levels := map[string]int{}
	p := &contracts.Plan{Schema: contracts.PlanSchema, DefinitionID: opt.DefinitionID, DefinitionDigest: defDigest,
		Name: g.Metadata.Name, Inputs: g.Inputs, Order: order, Outputs: outputs, Policy: *g.Policy, Limits: *g.Limits}
	if p.Inputs == nil {
		p.Inputs = map[string]contracts.Input{}
	}
	for _, id := range order {
		ps := planned[id]
		for _, n := range ps.Needs {
			if levels[n]+1 > ps.Level {
				ps.Level = levels[n] + 1
			}
		}
		levels[id] = ps.Level
		p.Steps = append(p.Steps, ps)
	}
	if p.Digest, err = PlanDigest(p); err != nil {
		d.add(CodeSchema, "", "plan isn't canonical JSON: %v", err)
		return out
	}
	out.Plan = p
	return out
}

// PlanDigest is the digest of a plan with its digest field left out.
func PlanDigest(p *contracts.Plan) (string, error) {
	c := *p
	c.Digest = ""
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return "", err
	}
	delete(m, "digest")
	return Digest(m)
}

// refType resolves a reference's port type and declared modalities.
func refType(g *contracts.Graph, index map[string]int, cs []*Resolution, anc map[string]map[string]bool,
	self, raw, path string, d *diags) (string, []string, bool) {
	r, ok := parseRef(raw)
	if !ok {
		d.add(CodeUnknownRef, path, "not a reference")
		return "", nil, false
	}
	if r.input != "" {
		in, ok := g.Inputs[r.input]
		if !ok {
			d.add(CodeUnknownRef, path, "unknown pipeline input %s", r.input)
			return "", nil, false
		}
		return inputPortType(in.Type), nil, true
	}
	i, ok := index[r.step]
	if !ok {
		d.add(CodeUnknownRef, path, "unknown step %s", r.step)
		return "", nil, false
	}
	if !anc[self][r.step] {
		d.add(CodeRefNotUpstream, path, "step %s reads %s without depending on it (add it to needs)", self, r.step)
		return "", nil, false
	}
	if cs[i] == nil {
		return "", nil, false // reported at its uses
	}
	spec, ok := cs[i].Contract.Outputs[r.port]
	if !ok {
		d.add(CodeUnknownRef, path, "step %s has no output %s", r.step, r.port)
		return "", nil, false
	}
	return spec.Type, spec.Modalities, true
}

func resourceClass(s contracts.Step, c contracts.StepContract) string {
	switch {
	case s.Resources != nil && s.Resources.Class != "":
		return s.Resources.Class
	case s.Resources != nil && s.Resources.GPU > 0, s.Execution != nil && s.Execution.Class == "gpu":
		return "gpu"
	case c.ResourceClass != "":
		return c.ResourceClass
	}
	return "cpu"
}

// topoSort is Kahn's algorithm, ties broken by declaration order so the plan
// is deterministic. On a cycle it returns one cycle, closed (a → b → a).
func topoSort(steps []contracts.Step, index map[string]int) ([]string, []string) {
	indeg := make([]int, len(steps))
	children := make([][]int, len(steps))
	for i, s := range steps {
		seen := map[string]bool{}
		for _, n := range s.Needs {
			if seen[n] {
				continue
			}
			seen[n] = true
			indeg[i]++
			children[index[n]] = append(children[index[n]], i)
		}
	}
	var ready []int
	for i := range steps {
		if indeg[i] == 0 {
			ready = append(ready, i)
		}
	}
	order := make([]string, 0, len(steps))
	for len(ready) > 0 {
		sort.Ints(ready)
		i := ready[0]
		ready = ready[1:]
		order = append(order, steps[i].ID)
		for _, c := range children[i] {
			if indeg[c]--; indeg[c] == 0 {
				ready = append(ready, c)
			}
		}
	}
	if len(order) == len(steps) {
		return order, nil
	}
	return nil, findCycle(steps, index, indeg)
}

func findCycle(steps []contracts.Step, index map[string]int, indeg []int) []string {
	const (
		white = iota
		grey
		black
	)
	color := make([]int, len(steps))
	var stack []int
	var cyc []string
	var visit func(i int) bool
	visit = func(i int) bool {
		color[i] = grey
		stack = append(stack, i)
		for _, n := range steps[i].Needs {
			j := index[n]
			if color[j] == grey {
				start := 0
				for k, x := range stack {
					if x == j {
						start = k
					}
				}
				for _, x := range stack[start:] {
					cyc = append(cyc, steps[x].ID)
				}
				cyc = append(cyc, steps[j].ID)
				return true
			}
			if color[j] == white && visit(j) {
				return true
			}
		}
		stack = stack[:len(stack)-1]
		color[i] = black
		return false
	}
	for i := range steps {
		if indeg[i] > 0 && color[i] == white && visit(i) {
			return cyc
		}
	}
	return []string{"?"}
}

// closure maps each step to the set of its transitive dependencies.
func closure(steps []contracts.Step, order []string, index map[string]int) map[string]map[string]bool {
	anc := make(map[string]map[string]bool, len(steps))
	for _, id := range order {
		set := map[string]bool{}
		for _, n := range steps[index[id]].Needs {
			set[n] = true
			for a := range anc[n] {
				set[a] = true
			}
		}
		anc[id] = set
	}
	return anc
}

func subset(a, b []string) bool {
	in := map[string]bool{}
	for _, x := range b {
		in[x] = true
	}
	for _, x := range a {
		if !in[x] {
			return false
		}
	}
	return true
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
