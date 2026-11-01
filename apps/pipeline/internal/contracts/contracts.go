// Package contracts holds the pipeline's wire types and validates documents
// against the JSON Schemas emitted from packages/contracts/src/pipeline
// (`pnpm emit:schemas` writes schemas/pipeline/*.v1.json).
//
// The service embeds a copy of those files so its binary is hermetic:
// `go generate ./internal/contracts` refreshes the copy, and
// TestEmbeddedSchemasMatchRepo fails when it drifts from schemas/pipeline.
// Never edit the files under schemas/ here or at the repo root by hand.
package contracts

//go:generate sh -c "rm -rf schemas && mkdir -p schemas && cp ../../../../schemas/pipeline/*.json schemas/ && cp ../../../../registry/pipelines/ingest.json schemas/ingest.json"

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

var printer = message.NewPrinter(language.English)

// Files holds the embedded schema and document copies.
//
//go:embed schemas/*.json
var Files embed.FS

// Schema names: the emitted file names without ".v1.json".
const (
	SchemaGraph              = "graph"
	SchemaPlan               = "plan"
	SchemaStepContract       = "step-contract"
	SchemaStepInput          = "step-input"
	SchemaStepOutput         = "step-output"
	SchemaRun                = "run"
	SchemaError              = "error"
	SchemaReproducibility    = "reproducibility"
	SchemaEvent              = "event"
	SchemaCreateRun          = "create-run"
	SchemaCancelRun          = "cancel-run"
	SchemaApproval           = "approval"
	SchemaValidateDefinition = "validate-definition"
	SchemaValidationReport   = "validation-report"
)

// SchemaNames lists every schema the service validates against.
var SchemaNames = []string{SchemaGraph, SchemaPlan, SchemaStepContract, SchemaStepInput, SchemaStepOutput, SchemaRun,
	SchemaError, SchemaReproducibility, SchemaEvent, SchemaCreateRun, SchemaCancelRun, SchemaApproval,
	SchemaValidateDefinition, SchemaValidationReport}

var (
	once     sync.Once
	compiled map[string]*jsonschema.Schema
	loadErr  error
)

func load() {
	compiled = map[string]*jsonschema.Schema{}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	for _, name := range SchemaNames {
		b, err := Files.ReadFile("schemas/" + name + ".v1.json")
		if err != nil {
			loadErr = fmt.Errorf("schema %s: %w", name, err)
			return
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
		if err != nil {
			loadErr = fmt.Errorf("schema %s: %w", name, err)
			return
		}
		url := "mem://pipeline/" + name + ".v1.json"
		if err := c.AddResource(url, doc); err != nil {
			loadErr = fmt.Errorf("schema %s: %w", name, err)
			return
		}
		s, err := c.Compile(url)
		if err != nil {
			loadErr = fmt.Errorf("schema %s: %w", name, err)
			return
		}
		compiled[name] = s
	}
}

// ErrInvalid wraps every schema violation.
var ErrInvalid = errors.New("document does not match its schema")

// Violation is one schema error, located by JSON pointer.
type Violation struct {
	Path    string
	Message string
}

// ValidationError lists the violations of one document.
type ValidationError struct {
	Schema     string
	Violations []Violation
}

func (e *ValidationError) Error() string {
	parts := make([]string, 0, len(e.Violations))
	for _, v := range e.Violations {
		parts = append(parts, v.Path+": "+v.Message)
	}
	return fmt.Sprintf("%s: %s", e.Schema, strings.Join(parts, "; "))
}

func (e *ValidationError) Unwrap() error { return ErrInvalid }

// Validate checks raw JSON against the named schema.
func Validate(schema string, raw []byte) error {
	once.Do(load)
	if loadErr != nil {
		return loadErr
	}
	s, ok := compiled[schema]
	if !ok {
		return fmt.Errorf("unknown schema %q", schema)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return &ValidationError{Schema: schema, Violations: []Violation{{Path: "", Message: "not JSON"}}}
	}
	if err := s.Validate(inst); err != nil {
		var ve *jsonschema.ValidationError
		if !errors.As(err, &ve) {
			return err
		}
		out := &ValidationError{Schema: schema}
		collect(ve, &out.Violations)
		sort.Slice(out.Violations, func(i, j int) bool { return out.Violations[i].Path < out.Violations[j].Path })
		if len(out.Violations) > 50 {
			out.Violations = out.Violations[:50]
		}
		return out
	}
	return nil
}

// ValidateValue marshals v and validates it.
func ValidateValue(schema string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return Validate(schema, b)
}

func collect(e *jsonschema.ValidationError, out *[]Violation) {
	if len(e.Causes) == 0 {
		*out = append(*out, Violation{Path: pointer(e.InstanceLocation), Message: e.ErrorKind.LocalizedString(printer)})
		return
	}
	for _, c := range e.Causes {
		collect(c, out)
	}
}

func pointer(loc []string) string {
	if len(loc) == 0 {
		return ""
	}
	var b strings.Builder
	for _, p := range loc {
		b.WriteByte('/')
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(p, "~", "~0"), "/", "~1"))
	}
	return b.String()
}

// IngestDefinition is the implicit ingest graph (registry/pipelines/ingest.json).
func IngestDefinition() []byte {
	b, err := Files.ReadFile("schemas/ingest.json")
	if err != nil {
		panic(err) // embedded at build time
	}
	return b
}

// BuiltinSteps returns the platform's step contracts (schemas/pipeline/builtin-steps.v1.json).
func BuiltinSteps() ([]StepContract, error) {
	b, err := Files.ReadFile("schemas/builtin-steps.v1.json")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Steps []StepContract `json:"steps"`
	}
	if err := DecodeStrict(b, &doc); err != nil {
		return nil, err
	}
	return doc.Steps, nil
}

// DecodeStrict decodes JSON, rejecting unknown fields and trailing data.
func DecodeStrict(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// EmbeddedNames lists the embedded files (drift test).
func EmbeddedNames() ([]string, error) {
	var out []string
	err := fs.WalkDir(Files, "schemas", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			out = append(out, strings.TrimPrefix(p, "schemas/"))
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}
