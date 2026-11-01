package compiler

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"studio.local/pipeline/internal/contracts"
)

// The namespace and apiVersion come from the generated files, never a literal.
var apiVersion, ns = func() (string, string) {
	var g struct {
		APIVersion string `json:"apiVersion"`
	}
	if err := json.Unmarshal(contracts.IngestDefinition(), &g); err != nil {
		panic(err)
	}
	return g.APIVersion, strings.TrimSuffix(g.APIVersion, ".dev/v1")
}()

func id(local string) string { return ns + "." + local }

func port(t string, mods ...string) contracts.PortSpec {
	return contracts.PortSpec{Type: t, Modalities: mods}
}

func optional(t string) contracts.PortSpec {
	f := false
	return contracts.PortSpec{Type: t, Required: &f}
}

func sha(c string) string { return "sha256:" + strings.Repeat(c, 64) }

// testResolver: the platform steps plus a few signed plugin versions and one
// unsigned build (P§20 test 10).
func testResolver(t *testing.T, extra ...Entry) Resolver {
	t.Helper()
	b, err := BuiltinResolver()
	if err != nil {
		t.Fatal(err)
	}
	job := func(local, version string, in, out map[string]contracts.PortSpec, partitionable bool) contracts.StepContract {
		return contracts.StepContract{ID: id(local), Version: version, Runtime: contracts.RuntimeKernelJob, JobKind: "plugin_tool",
			Plugin: id(local), Description: local, Inputs: in, Outputs: out, ResourceClass: "cpu", Partitionable: partitionable}
	}
	items := map[string]contracts.PortSpec{"items": port(contracts.PortItemSet)}
	entries := []Entry{
		{Contract: job("normalize-imaging", "2.1.0", map[string]contracts.PortSpec{"source": port(contracts.PortItemSet, "volume", "image")},
			map[string]contracts.PortSpec{"valid_scans": port(contracts.PortItemSet, "volume")}, true), Digest: sha("1"), Signer: "ed25519:k1"},
		{Contract: job("normalize-imaging", "2.0.0", map[string]contracts.PortSpec{"source": port(contracts.PortItemSet)},
			map[string]contracts.PortSpec{"valid_scans": port(contracts.PortItemSet)}, true), Digest: sha("2"), Signer: "ed25519:k1"},
		{Contract: job("segmentation", "3.0.2", map[string]contracts.PortSpec{"source": port(contracts.PortItemSet, "volume")},
			map[string]contracts.PortSpec{"masks": port(contracts.PortArtifactSet)}, true), Digest: sha("3"), Signer: "ed25519:k1"},
		{Contract: job("slice-2d", "1.0.0", map[string]contracts.PortSpec{"source": port(contracts.PortItemSet, "image")},
			map[string]contracts.PortSpec{"items": port(contracts.PortItemSet, "image")}, false), Digest: sha("4"), Signer: "ed25519:k1"},
		{Contract: job("extract", "1.0.0", map[string]contracts.PortSpec{"source": port(contracts.PortUploadSession)},
			items, false), Digest: sha("5"), Signer: "ed25519:k1"},
		{Contract: job("transform-a", "1.0.0", items, items, true), Digest: sha("6"), Signer: "ed25519:k1"},
		{Contract: job("transform-b", "1.0.0", items, items, true), Digest: sha("7"), Signer: "ed25519:k1"},
		{Contract: job("agent-step", "1.0.0", items, items, false), Digest: sha("8"), Signer: SignerUnsigned},
		{Contract: job("publish", "1.0.0", map[string]contracts.PortSpec{"a": port(contracts.PortItemSet), "b": port(contracts.PortItemSet),
			"extra": optional(contracts.PortReport)}, map[string]contracts.PortSpec{"candidate": port(contracts.PortCandidateCommit)}, false),
			Digest: sha("9"), Signer: "ed25519:k1"},
	}
	p, err := NewStaticResolver(append(entries, extra...)...)
	if err != nil {
		t.Fatal(err)
	}
	return Chain{b, p}
}

type obj = map[string]any

func graph(steps []obj, more ...obj) obj {
	g := obj{"apiVersion": apiVersion, "kind": "Pipeline", "metadata": obj{"name": "test"},
		"inputs": obj{"upload": obj{"type": "upload_session"}, "scans": obj{"type": "dataset", "selector": obj{"repository": "cardiac-mri", "branch": "main"}}},
		"steps":  steps}
	for _, m := range more {
		for k, v := range m {
			g[k] = v
		}
	}
	return g
}

func step(sid, uses string, kv ...any) obj {
	s := obj{"id": sid, "uses": uses}
	for i := 0; i+1 < len(kv); i += 2 {
		s[kv[i].(string)] = kv[i+1]
	}
	return s
}

func compileObj(t *testing.T, g obj, r Resolver) *Result {
	t.Helper()
	b, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	return Compile(b, r, Options{DefinitionID: "test"})
}

// The P§4 example, without its human-review step (no workflow waits for a
// human; review is the run policy). Its dataset input feeds item sets through
// an extract step here, since a dataset commit isn't an item set.
func cardiac() []obj {
	return []obj{
		step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
		step("normalize", id("normalize-imaging")+"@2", "needs", []string{"extract"},
			"inputs", obj{"source": "${steps.extract.outputs.items}"}, "execution", obj{"class": "trusted-python", "timeout_seconds": 1800}),
		step("segment", id("segmentation")+"@3", "needs", []string{"normalize"},
			"inputs", obj{"source": "${steps.normalize.outputs.valid_scans}"}, "resources", obj{"gpu": 1}),
	}
}

func TestCompileTable(t *testing.T) {
	cases := []struct {
		name  string
		graph obj
		codes []string // expected diagnostic codes, in order; empty means it compiles
		check func(t *testing.T, p *contracts.Plan)
	}{
		{name: "P§4 cardiac preprocessing", graph: graph(cardiac()), check: func(t *testing.T, p *contracts.Plan) {
			if got := strings.Join(p.Order, ","); got != "extract,normalize,segment" {
				t.Fatalf("order %s", got)
			}
			if s := p.Step("normalize"); s.Resolved.Version != "2.1.0" || s.Resolved.Digest != sha("1") {
				t.Fatalf("normalize resolved to %+v, want the newest signed 2.x", s.Resolved)
			}
			if s := p.Step("segment"); s.ResourceClass != "gpu" || s.Level != 2 {
				t.Fatalf("segment: %+v", s)
			}
		}},
		{name: "P§4 human-review step is not a step", graph: graph(append(cardiac(),
			step("review", id("human-review")+"@1", "needs", []string{"segment"}))), codes: []string{CodeUnresolvedStep}},
		{name: "fan-out / fan-in: extract → A + B → publish", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${steps.extract.outputs.items}", "batch_size": 100, "max_partitions": 50}),
			step("b", id("transform-b")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"}),
			step("publish", id("publish")+"@1", "needs", []string{"a", "b"}, "inputs", obj{"a": "${steps.a.outputs.items}", "b": "${steps.b.outputs.items}"}),
		}, obj{"outputs": obj{"candidate": "${steps.publish.outputs.candidate}"}}), check: func(t *testing.T, p *contracts.Plan) {
			levels := []int{}
			for _, s := range p.Steps {
				levels = append(levels, s.Level)
			}
			if got, _ := json.Marshal(levels); string(got) != "[0,1,1,2]" {
				t.Fatalf("levels %s", got)
			}
			if p.Outputs["candidate"].Type != contracts.PortCandidateCommit {
				t.Fatalf("outputs %+v", p.Outputs)
			}
		}},
		{name: "duplicate step ids", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
		}), codes: []string{CodeDuplicateStep}},
		{name: "needs an unknown step", graph: graph([]obj{
			step("x", id("extract")+"@1", "needs", []string{"ghost"}, "inputs", obj{"source": "${inputs.upload}"}),
		}), codes: []string{CodeUnknownStep}},
		{name: "self loop", graph: graph([]obj{
			step("x", id("extract")+"@1", "needs", []string{"x"}, "inputs", obj{"source": "${inputs.upload}"}),
		}), codes: []string{CodeCycle}},
		{name: "cycle a → b → c → a", graph: graph([]obj{
			step("a", id("transform-a")+"@1", "needs", []string{"c"}, "inputs", obj{"items": "${steps.c.outputs.items}"}),
			step("b", id("transform-a")+"@1", "needs", []string{"a"}, "inputs", obj{"items": "${steps.a.outputs.items}"}),
			step("c", id("transform-a")+"@1", "needs", []string{"b"}, "inputs", obj{"items": "${steps.b.outputs.items}"}),
		}), codes: []string{CodeCycle}},
		{name: "reads a step it doesn't depend on", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "inputs", obj{"items": "${steps.extract.outputs.items}"}),
		}), codes: []string{CodeRefNotUpstream}},
		{name: "transitive dependency is upstream", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"}),
			step("b", id("transform-b")+"@1", "needs", []string{"a"}, "inputs", obj{"items": "${steps.extract.outputs.items}"}),
		})},
		{name: "unknown input and output references", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.nope}"}),
			step("y", id("transform-a")+"@1", "needs", []string{"x"}, "inputs", obj{"items": "${steps.x.outputs.nope}"}),
		}), codes: []string{CodeUnknownRef, CodeUnknownRef}},
		{name: "type mismatch: a dataset commit into an upload port", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.scans}"}),
		}), codes: []string{CodeTypeMismatch}},
		{name: "unknown port and missing required input", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"src": "${inputs.upload}"}),
		}), codes: []string{CodeUnknownPort, CodeMissingInput}},
		{name: "3D never reaches a 2D-only step", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("norm", id("normalize-imaging")+"@2", "needs", []string{"extract"}, "inputs", obj{"source": "${steps.extract.outputs.items}"}),
			step("slice", id("slice-2d")+"@1", "needs", []string{"norm"}, "inputs", obj{"source": "${steps.norm.outputs.valid_scans}"}),
		}), codes: []string{CodeModalityMismatch}},
		{name: "P§20 test 10: a step outside the signed set", graph: graph([]obj{
			step("x", id("not-installed")+"@1"),
		}), codes: []string{CodeUnresolvedStep}},
		{name: "P§20 test 10: an unsigned agent build", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("x", id("agent-step")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"}),
		}), codes: []string{CodeUnsignedStep}},
		{name: "no such major", graph: graph([]obj{
			step("x", id("extract")+"@2", "inputs", obj{"source": "${inputs.upload}"}),
		}), codes: []string{CodeUnresolvedStep}},
		{name: "fan-out over something the step doesn't read", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${inputs.upload}", "batch_size": 10, "max_partitions": 10}),
		}), codes: []string{CodeFanOutUnbounded}},
		{name: "fan-out on a step that can't be partitioned", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"},
				"fan_out", obj{"over": "${inputs.upload}", "batch_size": 10, "max_partitions": 10}),
		}), codes: []string{CodeFanOutNotPartitionable}},
		{name: "P§20 test 12: fan-out above the platform maximum is a schema error", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${steps.extract.outputs.items}", "batch_size": 1, "max_partitions": 10001}),
		}), codes: []string{CodeSchema}},
		{name: "P§20 test 12: fan-out bounded by the graph's own limits", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${steps.extract.outputs.items}", "batch_size": 1, "max_partitions": 5000}),
			step("b", id("transform-b")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${steps.extract.outputs.items}", "batch_size": 1, "max_partitions": 5000}),
		}, obj{"limits": obj{"max_partitions_per_step": 10000}}), codes: []string{CodeLimitExceeded}},
		{name: "default per-step partition limit", graph: graph([]obj{
			step("extract", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("a", id("transform-a")+"@1", "needs", []string{"extract"}, "inputs", obj{"items": "${steps.extract.outputs.items}"},
				"fan_out", obj{"over": "${steps.extract.outputs.items}", "batch_size": 1, "max_partitions": 2000}),
		}), codes: []string{CodeLimitExceeded}},
		{name: "more steps than the graph allows", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
			step("y", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
		}, obj{"limits": obj{"max_steps": 1}}), codes: []string{CodeLimitExceeded}},
		{name: "a step timeout past the run deadline", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}, "execution", obj{"timeout_seconds": 7200}),
		}, obj{"policy": obj{"deadline_seconds": 3600}}), codes: []string{CodeLimitExceeded}},
		{name: "pipeline output that isn't a step output", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
		}, obj{"outputs": obj{"a": "${inputs.upload}", "b": "${steps.x.outputs.nope}"}}), codes: []string{CodeUnknownOutput, CodeUnknownOutput}},
		{name: "unknown field (a privileged knob) is a schema error", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}, "shell", "rm -rf /"),
		}), codes: []string{CodeSchema}},
		{name: "a literal apiVersion from another namespace", graph: graph([]obj{
			step("x", id("extract")+"@1", "inputs", obj{"source": "${inputs.upload}"}),
		}, obj{"apiVersion": "other.dev/v1"}), codes: []string{CodeSchema}},
	}
	r := testResolver(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := compileObj(t, tc.graph, r)
			var got []string
			for _, d := range res.Diagnostics {
				got = append(got, d.Code)
			}
			if len(tc.codes) == 0 {
				if !res.OK() {
					t.Fatalf("want a plan, got %v", res.Diagnostics)
				}
				if err := contracts.ValidateValue(contracts.SchemaPlan, res.Plan); err != nil {
					t.Fatalf("plan doesn't match plan.v1.json: %v", err)
				}
				if tc.check != nil {
					tc.check(t, res.Plan)
				}
				return
			}
			if res.OK() {
				t.Fatalf("want %v, got a plan", tc.codes)
			}
			if tc.codes[0] == CodeSchema {
				if got[0] != CodeSchema {
					t.Fatalf("want schema diagnostics, got %v", res.Diagnostics)
				}
				return
			}
			if strings.Join(got, ",") != strings.Join(tc.codes, ",") {
				t.Fatalf("want %v, got %v", tc.codes, res.Diagnostics)
			}
			for _, d := range res.Diagnostics {
				if !strings.HasPrefix(d.Path, "/") {
					t.Fatalf("diagnostic without a pointer: %+v", d)
				}
			}
		})
	}
}

// The implicit ingest definition (registry/pipelines/ingest.json, P§20 test 1)
// compiles against the platform steps alone.
func TestIngestDefinitionCompiles(t *testing.T) {
	b, err := BuiltinResolver()
	if err != nil {
		t.Fatal(err)
	}
	res := Compile(contracts.IngestDefinition(), b, Options{DefinitionID: "ingest"})
	if !res.OK() {
		t.Fatal(res.Err())
	}
	p := res.Plan
	if got := strings.Join(p.Order, ","); got != "inspect,derivatives,validate,propose" {
		t.Fatalf("order %s", got)
	}
	if s := p.Step("derivatives"); s.FanOut == nil || s.Runtime != contracts.RuntimeKernelJob || s.JobKind != "derivatives" || s.MaxAttempts != DefaultMaxAttempts {
		t.Fatalf("derivatives: %+v", s)
	}
	if s := p.Step("propose"); s.Runtime != contracts.RuntimeBuiltin || s.Resolved.Signer != SignerFirstParty || s.MaxAttempts != 1 {
		t.Fatalf("propose: %+v", s)
	}
	if p.Policy.Review != "required" || !p.Policy.PartialSuccess.Allowed {
		t.Fatalf("policy %+v", p.Policy)
	}
	if err := contracts.ValidateValue(contracts.SchemaPlan, p); err != nil {
		t.Fatal(err)
	}
}

// Same graph, reordered keys, whitespace and explicit defaults: same digests.
// A changed parameter changes the plan digest (P§20 test 4: a pinned plan
// keeps its versions even after a newer one is installed).
func TestDigestsAreCanonical(t *testing.T) {
	r := testResolver(t)
	a := compileObj(t, graph(cardiac()), r)
	steps := cardiac()
	steps[0]["needs"] = []string{}
	steps[0]["on_failure"] = "fail"
	steps[0]["with"] = obj{}
	b := compileObj(t, graph(steps, obj{"policy": obj{"review": "required"}, "limits": obj{"max_steps": 64}}), r)
	if !a.OK() || !b.OK() {
		t.Fatal(a.Err(), b.Err())
	}
	if a.Plan.DefinitionDigest != b.Plan.DefinitionDigest || a.Plan.Digest != b.Plan.Digest {
		t.Fatalf("explicit defaults changed the digest: %s/%s vs %s/%s", a.Plan.DefinitionDigest, a.Plan.Digest, b.Plan.DefinitionDigest, b.Plan.Digest)
	}
	raw, _ := json.Marshal(graph(cardiac()))
	var pretty map[string]any
	_ = json.Unmarshal(raw, &pretty)
	indented, _ := json.MarshalIndent(pretty, "", "    ")
	if c := Compile(indented, r, Options{DefinitionID: "test"}); c.Plan.Digest != a.Plan.Digest {
		t.Fatal("whitespace changed the digest")
	}
	steps = cardiac()
	steps[1]["with"] = obj{"window": 400}
	c := compileObj(t, graph(steps), r)
	if c.Plan.Digest == a.Plan.Digest || c.Plan.DefinitionDigest == a.Plan.DefinitionDigest {
		t.Fatal("a parameter change kept the digest")
	}
	if c.Plan.Step("normalize").ParamsDigest == a.Plan.Step("normalize").ParamsDigest {
		t.Fatal("params digest unchanged")
	}

	// A newer signed 2.x appears: recompiling picks it, the stored plan doesn't change.
	stored, _ := json.Marshal(a.Plan)
	newer := testResolver(t, Entry{Contract: contracts.StepContract{ID: id("normalize-imaging"), Version: "2.2.0",
		Runtime: contracts.RuntimeKernelJob, Description: "n", Inputs: map[string]contracts.PortSpec{"source": port(contracts.PortItemSet)},
		Outputs: map[string]contracts.PortSpec{"valid_scans": port(contracts.PortItemSet, "volume")}, Partitionable: true}, Digest: sha("a"), Signer: "ed25519:k1"})
	d := compileObj(t, graph(cardiac()), newer)
	if d.Plan.Step("normalize").Resolved.Version != "2.2.0" || d.Plan.Digest == a.Plan.Digest {
		t.Fatal("recompiling didn't resolve the newer version")
	}
	var again contracts.Plan
	if err := json.Unmarshal(stored, &again); err != nil {
		t.Fatal(err)
	}
	if dg, _ := PlanDigest(&again); dg != a.Plan.Digest || again.Step("normalize").Resolved.Version != "2.1.0" {
		t.Fatal("a stored plan isn't stable")
	}
}

// RFC 8785 vectors shared with the TypeScript and Python implementations.
func TestCanonicalVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/contracts/test-vectors/canonical.json")
	if err != nil {
		t.Skip("repo test vectors not available:", err)
	}
	var doc struct {
		Vectors []struct {
			Input     string `json:"input"`
			Canonical string `json:"canonical"`
			Hash      string `json:"hash"`
			Error     bool   `json:"error"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Vectors) < 10 {
		t.Fatalf("only %d vectors", len(doc.Vectors))
	}
	for _, v := range doc.Vectors {
		got, err := CanonicalJSON([]byte(v.Input))
		if v.Error {
			if err == nil {
				t.Errorf("%s: want an error", v.Input)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", v.Input, err)
			continue
		}
		if string(got) != v.Canonical {
			t.Errorf("%s: got %s want %s", v.Input, got, v.Canonical)
		}
		if v.Hash != "" && HashBytes(got) != v.Hash {
			t.Errorf("%s: hash %s want %s", v.Input, HashBytes(got), v.Hash)
		}
	}
}

func TestResolverPicksNewestSignedWithinMajor(t *testing.T) {
	r, err := NewStaticResolver(
		Entry{Contract: contracts.StepContract{ID: id("p"), Version: "1.2.0"}, Digest: sha("1"), Signer: "ed25519:k"},
		Entry{Contract: contracts.StepContract{ID: id("p"), Version: "1.10.0"}, Digest: sha("2"), Signer: "ed25519:k"},
		Entry{Contract: contracts.StepContract{ID: id("p"), Version: "1.11.0-rc.1"}, Digest: sha("3"), Signer: "ed25519:k"},
		Entry{Contract: contracts.StepContract{ID: id("p"), Version: "2.0.0"}, Digest: sha("4"), Signer: "ed25519:k"},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Resolve(id("p"), 1)
	if err != nil || got.Resolved.Version != "1.10.0" {
		t.Fatalf("got %+v %v", got.Resolved, err)
	}
}
