import { describe, expect, it } from "vitest";
import { initTracing, traceExporterFrom } from "../src/otel.ts";

describe("traceExporterFrom (todo27 D4)", () => {
  const cases: [Record<string, string>, string | undefined][] = [
    [{}, undefined],
    [{ OTEL_TRACES_EXPORTER: "" }, undefined],
    [{ OTEL_TRACES_EXPORTER: "none" }, undefined],
    [{ OTEL_TRACES_EXPORTER: "zipkin" }, undefined],
    [{ OTEL_TRACES_EXPORTER: "console" }, "console"],
    [{ OTEL_TRACES_EXPORTER: " OTLP " }, "otlp"],
    [{ OTEL_TRACES_EXPORTER: "gcp" }, "gcp"],
    [{ OTEL_TRACES_EXPORTER: "console,gcp" }, "gcp"],
    [{ OTEL_TRACES_EXPORTER: "console,otlp" }, "otlp"],
    [{ OTEL_TRACES_EXPORTER: "none", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" }, undefined],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" }, "otlp"],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://x:4318/v1/traces" }, "otlp"],
    [{ OTEL_TRACES_EXPORTER: "console", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" }, "console"],
    [{ OTEL_TRACES_EXPORTER: "zipkin", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" }, "otlp"],
    [{ OTEL_TRACES_SAMPLER: "always_on" }, undefined],
  ];
  it.each(cases)("%j -> %s", (env, want) => expect(traceExporterFrom(env)).toBe(want));
});

describe("initTracing", () => {
  it("is off with no OTEL_* and never warns or touches env", async () => {
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const t = await initTracing({ service: "s", env, warn: (m) => warnings.push(m) });
    expect(t.enabled).toBe(false);
    expect(warnings).toEqual([]);
    expect(env).toEqual({});
  });

  it("warns once and stays off when switched on without the SDK installed", async () => {
    const warnings: string[] = [];
    const t = await initTracing({ service: "s", env: { OTEL_TRACES_EXPORTER: "console" }, warn: (m) => warnings.push(m) });
    expect(t.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@opentelemetry/sdk-node");
  });
});
