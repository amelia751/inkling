// Package observability sets up JSON logging and OpenTelemetry tracing with
// W3C propagation, so traces continue from apps/api (spec §15).
package observability

import (
	"context"
	"log/slog"
	"os"
	"strings"

	// Deprecated upstream (archived after 2027-01-01); move gcp to OTLP before then (todo27).
	cloudtrace "github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/trace" //nolint:staticcheck // SA1019, see above
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Logger returns a JSON slog logger. Callers log ids and enums only, never
// request bodies or object contents.
func Logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// Exporter is which span exporter tracing uses, or "" when tracing is off.
type Exporter string

// The exporters ExporterFor can pick; ExporterOff means tracing is off.
const (
	ExporterOff     Exporter = ""
	ExporterConsole Exporter = "console"
	ExporterOTLP    Exporter = "otlp"
	ExporterGCP     Exporter = "gcp"
)

// ExporterFor implements todo/todo27.md D4: tracing is on when OTEL_TRACES_EXPORTER is
// console, otlp or gcp, or when an OTLP endpoint is set. Any other explicit value (such as
// "none") turns it off.
func ExporterFor(getenv func(string) string) Exporter {
	switch kind := strings.ToLower(strings.TrimSpace(getenv("OTEL_TRACES_EXPORTER"))); kind {
	case "console", "otlp", "gcp":
		return Exporter(kind)
	case "":
		if getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" {
			return ExporterOTLP
		}
	}
	return ExporterOff
}

// Tracing installs the propagator and, when ExporterFor picks one, a tracer provider:
// console prints spans to stdout, otlp exports OTLP/HTTP, gcp exports to Cloud Trace with
// application default credentials. The sampler comes from OTEL_TRACES_SAMPLER (read by the
// SDK). The returned function flushes on shutdown.
func Tracing(ctx context.Context) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	var (
		exp sdktrace.SpanExporter
		err error
	)
	switch ExporterFor(os.Getenv) {
	case ExporterOff:
		return func(context.Context) error { return nil }, nil
	case ExporterConsole:
		exp, err = stdouttrace.New()
	case ExporterGCP:
		exp, err = cloudtrace.New() //nolint:staticcheck // SA1019: deprecated exporter, see the import
	default:
		exp, err = otlptracehttp.New(ctx)
	}
	if err != nil {
		return nil, err
	}
	// resource.Default reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(resource.Default()))
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}
