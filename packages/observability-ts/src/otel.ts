/**
 * Optional OpenTelemetry export. Nothing here is a dependency: when OTEL_EXPORTER_OTLP_ENDPOINT is
 * set, `initTracing` dynamically imports `@opentelemetry/sdk-node` (and, if present,
 * `@opentelemetry/auto-instrumentations-node` and `@opentelemetry/api`) and starts the SDK with the
 * standard OTEL_* env vars. If the packages aren't installed it logs one warning and carries on:
 * trace ids still flow through logs and outgoing `traceparent` headers (see trace.ts, fetch.ts).
 *
 * To export traces, add those packages to the service and set OTEL_EXPORTER_OTLP_ENDPOINT. For
 * automatic http/undici spans in ESM, also start node with
 * `--import @opentelemetry/auto-instrumentations-node/register`.
 */

interface OtelApi {
  trace: { getActiveSpan(): { spanContext(): { traceId: string } } | undefined };
}

let api: OtelApi | undefined;

export interface Tracing {
  enabled: boolean;
  shutdown(): Promise<void>;
}

const disabled: Tracing = { enabled: false, shutdown: async () => {} };

// Specifiers in variables so bundlers and tsc leave them alone (they're optional at runtime).
const SDK = "@opentelemetry/sdk-node";
const AUTO = "@opentelemetry/auto-instrumentations-node";
const API = "@opentelemetry/api";

export async function initTracing(opts: {
  service: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string) => void;
}): Promise<Tracing> {
  const env = opts.env ?? process.env;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return disabled;
  try {
    const { NodeSDK } = (await import(SDK)) as { NodeSDK: new (o: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> } };
    const auto = (await import(AUTO).catch(() => undefined)) as { getNodeAutoInstrumentations?: () => unknown[] } | undefined;
    api = (await import(API).catch(() => undefined)) as OtelApi | undefined;
    env.OTEL_SERVICE_NAME ??= opts.service;
    if (opts.version && !/service\.version=/.test(env.OTEL_RESOURCE_ATTRIBUTES ?? ""))
      env.OTEL_RESOURCE_ATTRIBUTES = [env.OTEL_RESOURCE_ATTRIBUTES, `service.version=${opts.version}`].filter(Boolean).join(",");
    const sdk = new NodeSDK({ instrumentations: auto?.getNodeAutoInstrumentations ? [auto.getNodeAutoInstrumentations()] : [] });
    sdk.start();
    return { enabled: true, shutdown: () => sdk.shutdown().catch(() => {}) };
  } catch {
    opts.warn?.(`OTEL_EXPORTER_OTLP_ENDPOINT is set but ${SDK} is not installed; traces are not exported (trace ids still appear in logs)`);
    return disabled;
  }
}

/** The active OpenTelemetry span's trace id, when the SDK is running. */
export function otelTraceId(): string | undefined {
  const id = api?.trace.getActiveSpan()?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : undefined;
}
