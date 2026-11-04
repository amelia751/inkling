package observability

import (
	"context"
	"testing"
)

func TestExporterFor(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want Exporter
	}{
		{nil, ExporterOff},
		{map[string]string{"OTEL_TRACES_EXPORTER": "console"}, ExporterConsole},
		{map[string]string{"OTEL_TRACES_EXPORTER": "OTLP"}, ExporterOTLP},
		{map[string]string{"OTEL_TRACES_EXPORTER": "gcp"}, ExporterGCP},
		{map[string]string{"OTEL_TRACES_EXPORTER": "gcp", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, ExporterGCP},
		{map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, ExporterOTLP},
		{map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://x:4318/v1/traces"}, ExporterOTLP},
		{map[string]string{"OTEL_TRACES_EXPORTER": "none", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, ExporterOff},
		{map[string]string{"OTEL_TRACES_EXPORTER": "zipkin"}, ExporterOff},
	}
	for _, c := range cases {
		if got := ExporterFor(func(k string) string { return c.env[k] }); got != c.want {
			t.Errorf("ExporterFor(%v) = %q, want %q", c.env, got, c.want)
		}
	}
}

func TestTracingConsoleAndOff(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	stop, err := Tracing(context.Background())
	if err != nil || stop(context.Background()) != nil {
		t.Fatalf("off: %v", err)
	}
	t.Setenv("OTEL_TRACES_EXPORTER", "console")
	stop, err = Tracing(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
