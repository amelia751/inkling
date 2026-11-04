/**
 * Optional OpenTelemetry export (todo27 D4). Nothing here is a dependency of this package: when
 * tracing is switched on, `initTracing` dynamically imports `@opentelemetry/sdk-node` (plus
 * `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/api` and, for `gcp`,
 * `@google-cloud/opentelemetry-cloud-trace-exporter`) through the service's `importer`, so they
 * resolve from the service that installed them. A
 * service without them still starts and logs one warning; trace ids still flow through logs and
 * outgoing `traceparent` headers (see trace.ts, fetch.ts).
 *
 * One switch: `OTEL_TRACES_EXPORTER` = `console` | `otlp` | `gcp` (Cloud Trace with application
 * default credentials), or `OTEL_EXPORTER_OTLP_ENDPOINT` set (OTLP). Anything else is off: no
 * imports, no cost, no warnings. Sampling comes from the standard `OTEL_TRACES_SAMPLER` /
 * `OTEL_TRACES_SAMPLER_ARG`, which the SDK reads itself. Auto-instrumentation is limited to http
 * and undici unless `OTEL_NODE_ENABLED_INSTRUMENTATIONS` says otherwise.
 */

import { createRequire, syncBuiltinESMExports } from "node:module";

interface OtelApi {
  trace: { getActiveSpan(): { spanContext(): { traceId: string } } | undefined };
}

let api: OtelApi | undefined;

export interface Tracing {
  enabled: boolean;
  shutdown(): Promise<void>;
}

export type TraceExporterKind = "console" | "otlp" | "gcp";

const disabled: Tracing = { enabled: false, shutdown: async () => {} };
const KINDS: readonly TraceExporterKind[] = ["gcp", "otlp", "console"];

/**
 * D4 as a pure function: which exporter `env` asks for, or `undefined` when tracing is off.
 * `OTEL_TRACES_EXPORTER` is a comma list per the spec; `none` wins, `gcp` beats the others (it
 * can't be combined with env-configured exporters), and an OTLP endpoint alone means `otlp`.
 */
export function traceExporterFrom(env: NodeJS.ProcessEnv): TraceExporterKind | undefined {
  const list = (env.OTEL_TRACES_EXPORTER ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes("none")) return undefined;
  const kind = KINDS.find((k) => list.includes(k));
  if (kind) return kind;
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return "otlp";
  return undefined;
}

// Specifiers in variables so bundlers and tsc leave them alone (they're optional at runtime).
const SDK = "@opentelemetry/sdk-node";
const AUTO = "@opentelemetry/auto-instrumentations-node";
const API = "@opentelemetry/api";
const GCP = "@google-cloud/opentelemetry-cloud-trace-exporter";

type NodeSdk = new (o: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> };

export async function initTracing(opts: {
  service: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string) => void;
  /**
   * Imports a specifier from the service, so it resolves against the service's own dependencies
   * (this package doesn't depend on them). Services pass `(s) => import(s)`.
   */
  importer?: (specifier: string) => Promise<unknown>;
}): Promise<Tracing> {
  const env = opts.env ?? process.env;
  const load = opts.importer ?? ((s: string) => import(s));
  const kind = traceExporterFrom(env);
  if (!kind) return disabled;
  let missing = SDK;
  try {
    const { NodeSDK } = (await load(SDK)) as { NodeSDK: NodeSdk };
    let traceExporter: unknown;
    if (kind === "gcp") {
      missing = GCP;
      const { TraceExporter } = (await load(GCP)) as { TraceExporter: new () => unknown };
      traceExporter = new TraceExporter();
    }
    env.OTEL_NODE_ENABLED_INSTRUMENTATIONS ??= "http,undici";
    const auto = (await load(AUTO).catch(() => undefined)) as { getNodeAutoInstrumentations?: () => unknown[] } | undefined;
    api = (await load(API).catch(() => undefined)) as OtelApi | undefined;
    env.OTEL_SERVICE_NAME ??= opts.service;
    if (opts.version && !/service\.version=/.test(env.OTEL_RESOURCE_ATTRIBUTES ?? ""))
      env.OTEL_RESOURCE_ATTRIBUTES = [env.OTEL_RESOURCE_ATTRIBUTES, `service.version=${opts.version}`].filter(Boolean).join(",");
    // console and otlp: the SDK builds the exporter from OTEL_TRACES_EXPORTER / OTEL_EXPORTER_OTLP_*.
    const sdk = new NodeSDK({
      ...(traceExporter ? { traceExporter } : {}),
      instrumentations: auto?.getNodeAutoInstrumentations ? [auto.getNodeAutoInstrumentations()] : [],
    });
    sdk.start();
    patchLoadedBuiltins();
    return { enabled: true, shutdown: () => sdk.shutdown().catch(() => {}) };
  } catch {
    opts.warn?.(`tracing is on (${kind}) but ${missing} is not installed; traces are not exported (trace ids still appear in logs)`);
    return disabled;
  }
}

/**
 * ESM services import `node:http` before tracing starts, so the http instrumentation's require
 * hook never sees it. Requiring the builtins once now lets it patch them in place (incoming spans
 * hook `Server.prototype`), and syncing the ESM exports hands the wrapped `request`/`get` to
 * modules that imported them by name.
 */
function patchLoadedBuiltins(): void {
  const req = createRequire(import.meta.url);
  for (const m of ["http", "https"]) req(m);
  syncBuiltinESMExports();
}

/** The active OpenTelemetry span's trace id, when the SDK is running. */
export function otelTraceId(): string | undefined {
  const id = api?.trace.getActiveSpan()?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : undefined;
}
