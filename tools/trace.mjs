#!/usr/bin/env node
// pnpm trace <run-id | session-id | trace-id> [--file spans.json] [--json]
//
// Finds a chat's trace (todo27 W5) and prints it as a tree: span, duration, model, tokens, cost,
// errors. The agent half lives in spurby-ai and the kernel half in spurby-phi (one trace id), so
// it fetches from every project in STUDIO_TRACE_PROJECTS with your gcloud credentials and merges.
// --file prints a tree from saved spans instead (Cloud Trace v1 JSON, OTLP JSON, or the console
// exporter's output as JSON / JSON lines). docs/deployment-gcp.md, "Observability".
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRACE_ID = /^[0-9a-f]{32}$/i;
const API = "https://cloudtrace.googleapis.com/v1";

// ---- normalising ------------------------------------------------------------------------------

/** OTLP AnyValue → plain JS value. */
function anyValue(v) {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(anyValue);
  return v;
}

function attrs(a) {
  if (!a) return {};
  if (Array.isArray(a)) return Object.fromEntries(a.map((kv) => [kv.key, anyValue(kv.value)]));
  return { ...a };
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const nanosToMs = (n) => Number(BigInt(n) / 1000n) / 1000;

/** Cloud Trace v1 span (labels are strings; ids are decimal uint64 strings). */
function fromCloudTrace(s, project, traceId) {
  const labels = s.labels ?? {};
  const status = labels["/status/code"] ?? labels["g.co/status/code"];
  const error =
    labels["error.type"] ??
    (status && status !== "0" && status !== "OK" ? labels["/status/message"] ?? labels["g.co/status/message"] ?? `status ${status}` : undefined);
  return {
    traceId,
    spanId: String(s.spanId),
    parentId: s.parentSpanId && s.parentSpanId !== "0" ? String(s.parentSpanId) : undefined,
    name: s.name,
    start: ms(s.startTime),
    end: ms(s.endTime),
    attributes: labels,
    service: labels["g.co/r/generic_task/job"] ?? labels["service.name"] ?? project,
    error,
  };
}

/** OTLP span (resourceSpans[].scopeSpans[].spans[]). */
function fromOtlp(s, service) {
  const a = attrs(s.attributes);
  const code = s.status?.code;
  const isErr = code === 2 || code === "STATUS_CODE_ERROR";
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentId: s.parentSpanId || undefined,
    name: s.name,
    start: nanosToMs(s.startTimeUnixNano),
    end: nanosToMs(s.endTimeUnixNano),
    attributes: a,
    service,
    error: a["error.type"] ?? (isErr ? s.status?.message || "error" : undefined),
  };
}

/** The JS ConsoleSpanExporter's object ({ traceId, parentId, id, timestamp µs, duration µs }). */
function fromConsole(s) {
  const a = attrs(s.attributes);
  const start = Number(s.timestamp) / 1000;
  const code = s.status?.code;
  return {
    traceId: s.traceId,
    spanId: s.id,
    parentId: s.parentSpanContext?.spanId ?? s.parentSpanId ?? s.parentId ?? undefined,
    name: s.name,
    start,
    end: start + Number(s.duration) / 1000,
    attributes: a,
    service: s.resource?.attributes?.["service.name"],
    error: a["error.type"] ?? (code === 2 ? s.status?.message || "error" : undefined),
  };
}

/** Any supported shape (or an array / JSONL of them) → flat normalised spans. */
export function normalizeSpans(input) {
  const out = [];
  const visit = (x, project) => {
    if (x == null) return;
    if (Array.isArray(x)) return x.forEach((y) => visit(y, project));
    if (x.resourceSpans) {
      for (const rs of x.resourceSpans) {
        const service = attrs(rs.resource?.attributes)["service.name"];
        for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) for (const s of ss.spans ?? []) out.push(fromOtlp(s, service));
      }
      return;
    }
    if (x.traces) return visit(x.traces, project);
    if (x.traceId && Array.isArray(x.spans)) {
      for (const s of x.spans) out.push(fromCloudTrace(s, x.projectId ?? project, x.traceId));
      return;
    }
    if (x.startTimeUnixNano != null) return void out.push(fromOtlp(x));
    if (x.timestamp != null && x.duration != null) return void out.push(fromConsole(x));
  };
  visit(input);
  return out;
}

/** Parses a file: one JSON document, or JSON lines. */
export function parseSpansText(text) {
  try {
    return normalizeSpans(JSON.parse(text));
  } catch {
    return normalizeSpans(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    );
  }
}

// ---- tree -------------------------------------------------------------------------------------

/** Spans → forest (roots are spans whose parent isn't present), children sorted by start. */
export function buildTree(spans) {
  const seen = new Map();
  for (const s of spans) if (!seen.has(s.spanId)) seen.set(s.spanId, { ...s, children: [] });
  const roots = [];
  for (const n of seen.values()) {
    const p = n.parentId && seen.get(n.parentId);
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  const sort = (list) => {
    list.sort((a, b) => a.start - b.start);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

function fmtDuration(d) {
  if (!Number.isFinite(d)) return "?";
  if (d < 1) return `${d.toFixed(2)}ms`;
  if (d < 1000) return `${Math.round(d)}ms`;
  return `${(d / 1000).toFixed(d < 10_000 ? 2 : 1)}s`;
}

/** One line's details: model, tokens, cost, error. */
export function spanDetails(n) {
  const a = n.attributes ?? {};
  const parts = [];
  const model = a["gen_ai.response.model"] ?? a["gen_ai.request.model"];
  if (model) parts.push(`model=${model}`);
  const tin = a["gen_ai.usage.input_tokens"];
  const tout = a["gen_ai.usage.output_tokens"];
  if (tin != null || tout != null) parts.push(`tokens=${tin ?? "?"}/${tout ?? "?"}`);
  const cached = a["gen_ai.usage.cache_read.input_tokens"] ?? a["gen_ai.usage.cache_read_input_tokens"] ?? a["gen_ai.usage.cached_tokens"];
  if (cached != null && Number(cached) > 0) parts.push(`cached=${cached}`);
  const cost = a["studio.cost_usd"];
  if (cost != null && cost !== "") parts.push(`cost=$${Number(cost).toFixed(4)}`);
  const status = a["http.response.status_code"] ?? a["http.status_code"] ?? a["/http/status_code"];
  if (status != null) parts.push(`http=${status}`);
  if (n.error) parts.push(`ERROR ${n.error}`);
  return parts.join("  ");
}

/** Forest → indented text. */
export function formatTree(roots) {
  const lines = [];
  const walk = (n, prefix, last, depth) => {
    const branch = depth === 0 ? "" : last ? "└─ " : "├─ ";
    const svc = n.service ? ` [${n.service}]` : "";
    const details = spanDetails(n);
    lines.push(`${prefix}${branch}${n.name}  ${fmtDuration(n.end - n.start)}${svc}${details ? `  ${details}` : ""}`);
    const next = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, depth + 1));
  };
  roots.forEach((r) => walk(r, "", true, 0));
  return lines.join("\n");
}

/** Sum of model-call cost and tokens across the tree (chat spans only, to avoid double counting the run span). */
export function totals(spans) {
  let cost = 0;
  let tin = 0;
  let tout = 0;
  let errors = 0;
  for (const s of spans) {
    const a = s.attributes ?? {};
    if (a["gen_ai.operation.name"] === "chat" || s.name?.startsWith("chat ")) {
      cost += Number(a["studio.cost_usd"] ?? 0) || 0;
      tin += Number(a["gen_ai.usage.input_tokens"] ?? 0) || 0;
      tout += Number(a["gen_ai.usage.output_tokens"] ?? 0) || 0;
    }
    if (s.error) errors += 1;
  }
  return { spans: spans.length, cost, tin, tout, errors };
}

// ---- resolving and fetching -------------------------------------------------------------------

const repo = resolve(fileURLToPath(import.meta.url), "../..");

function runsDir() {
  const dir = process.env.STUDIO_AGENT_DATA_DIR ?? join(repo, "apps/agent/.data");
  return join(dir, "runs");
}

/** Trace ids for a run id or session id from the local run store; [] if none. */
export function localTraceIds(id, dir = runsDir()) {
  if (!existsSync(dir)) return [];
  const direct = join(dir, `${id}.json`);
  if (/^[\w-]+$/.test(id) && existsSync(direct)) {
    const rec = JSON.parse(readFileSync(direct, "utf8"));
    return rec.traceId ? [{ runId: rec.id, traceId: rec.traceId }] : [];
  }
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (rec.sessionId === id && rec.traceId) out.push({ runId: rec.id, traceId: rec.traceId, createdAt: rec.createdAt ?? 0 });
    } catch {
      /* not a run record */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The agent's and the kernel's Google Cloud projects, from the environment (like tools/deploy-run.sh). */
function projects() {
  const list = (process.env.STUDIO_TRACE_PROJECTS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!list.length) {
    console.error("pnpm trace: set STUDIO_TRACE_PROJECTS to the agent's and the kernel's project ids, comma-separated (or use --file <spans.json>)");
    process.exit(2);
  }
  return list;
}

function token() {
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

async function get(url, tok) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Staging: the run record is in Cloud SQL, so look the id up by span label in Cloud Trace. */
async function searchTraceIds(id, tok) {
  const start = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const ids = new Set();
  for (const label of ["studio.run.id", "gen_ai.conversation.id"]) {
    const q = new URLSearchParams({ view: "MINIMAL", startTime: start, filter: `${label}:${id}`, pageSize: "50" });
    const body = await get(`${API}/projects/${projects()[0]}/traces?${q}`, tok);
    for (const t of body?.traces ?? []) ids.add(t.traceId);
    if (ids.size) break;
  }
  return [...ids].map((traceId) => ({ traceId }));
}

async function fetchTrace(traceId, tok) {
  const docs = [];
  for (const p of projects()) {
    try {
      const t = await get(`${API}/projects/${p}/traces/${traceId}`, tok);
      if (t) docs.push({ ...t, projectId: p });
    } catch (e) {
      console.error(`trace: ${p}: ${e.message}`);
    }
  }
  return normalizeSpans(docs);
}

function print(spans, header) {
  if (header) console.log(header);
  if (!spans.length) return console.log("  (no spans: not sampled, not exported yet, or tracing off)");
  console.log(formatTree(buildTree(spans)));
  const t = totals(spans);
  console.log(`\n${t.spans} spans  tokens=${t.tin}/${t.tout}  cost=$${t.cost.toFixed(4)}  errors=${t.errors}`);
}

async function main(argv) {
  const args = argv.slice(2);
  const fi = args.indexOf("--file");
  if (fi >= 0) {
    const file = args[fi + 1];
    if (!file) throw new Error("--file needs a path");
    const spans = parseSpansText(readFileSync(file, "utf8"));
    const byTrace = Map.groupBy ? Map.groupBy(spans, (s) => s.traceId ?? "?") : new Map([["?", spans]]);
    for (const [tid, list] of byTrace) print(list, byTrace.size > 1 ? `trace ${tid}` : undefined);
    return;
  }
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    console.error("usage: pnpm trace <run-id | session-id | trace-id> | --file <spans.json>");
    process.exit(2);
  }
  let targets = TRACE_ID.test(id) ? [{ traceId: id.toLowerCase() }] : localTraceIds(id);
  const tok = token();
  if (!targets.length) targets = await searchTraceIds(id, tok);
  if (!targets.length) {
    console.error(`trace: no trace id for ${id} (local run store, or Cloud Trace labels in ${projects()[0]} over 30 days). Pass the trace id from the run's start event.`);
    process.exit(1);
  }
  for (const t of targets) {
    const spans = await fetchTrace(t.traceId, tok);
    print(spans, `trace ${t.traceId}${t.runId ? `  run ${t.runId}` : ""}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((e) => {
    console.error(`trace: ${e.message}`);
    process.exit(1);
  });
}
