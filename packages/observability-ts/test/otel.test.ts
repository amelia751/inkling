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

describe("request paths never leave in a span (todo27 D3)", () => {
  it("redacts ids, file names and queries; keeps route words and templates", async () => {
    const { redactPath, redactUrl, redactSpanFields, redacting } = await import("../src/otel.ts");
    expect(redactPath("/api/v1/boundary/jobs/CANARY-TOOL-ARG-7f3a")).toBe("/api/v1/boundary/jobs/{id}");
    expect(redactPath("/api/v1/projects/prj-04c0490b/files/chest%2Fimg-01.jpeg?x=1")).toBe("/api/v1/projects/{id}/files/{id}");
    expect(redactPath("/api/v1/projects/{project_id}/overview")).toBe("/api/v1/projects/{project_id}/overview");
    expect(redactUrl("http://127.0.0.1:8271/api/v1/assets/scan.dcm?sig=abc")).toBe("http://127.0.0.1:8271/api/v1/assets/{id}");
    const r = redactSpanFields("GET /api/v1/jobs/SECRET-1", { "url.full": "http://k/api/v1/jobs/SECRET-1?name=scan.png", "url.query": "name=scan.png", "http.response.status_code": 404 });
    expect(r).toEqual({ name: "GET /api/v1/jobs/{id}", attributes: { "url.full": "http://k/api/v1/jobs/{id}", "http.response.status_code": 404 } });
    const seen: { name: string; attributes: Record<string, unknown> }[] = [];
    const span = { name: "GET", attributes: { "url.path": "/files/scan.png" }, spanContext: () => ({ traceId: "t" }) };
    redacting({ export: (s: typeof seen, done: (r: unknown) => void) => (seen.push(...s), done({})), shutdown: async () => {} }).export([span], () => {});
    expect(seen[0]!.attributes).toEqual({ "url.path": "/files/{id}" });
    expect((seen[0] as unknown as typeof span).spanContext()).toEqual({ traceId: "t" });
  });
});
