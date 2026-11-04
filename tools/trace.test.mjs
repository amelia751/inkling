import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTree, formatTree, localTraceIds, normalizeSpans, parseSpansText, totals } from "./trace.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/trace-spans.json", import.meta.url), "utf8"));

test("merges both projects' halves into one tree under the tool call", () => {
  const spans = normalizeSpans(fixture);
  assert.equal(spans.length, 6);
  const roots = buildTree(spans);
  assert.equal(roots.length, 1);
  const run = roots[0];
  assert.equal(run.name, "invoke_agent studio.assistant");
  assert.deepEqual(run.children.map((c) => c.name), ["chat gemini-2.5-flash", "execute_tool list_items", "chat gemini-2.5-flash"]);
  const tool = run.children[1];
  assert.equal(tool.children[0].name, "GET /api/v1/items");
  assert.equal(tool.children[0].service, "studio-api");
  assert.equal(tool.children[0].children[0].name, "SELECT items");
});

test("prints duration, model, tokens, cost and errors", () => {
  const out = formatTree(buildTree(normalizeSpans(fixture)));
  const lines = out.split("\n");
  assert.match(lines[0], /^invoke_agent studio\.assistant {2}5\.00s \[studio-agent\] {2}model=vertex:gemini-2\.5-flash$/);
  assert.match(lines[1], /^├─ chat gemini-2\.5-flash {2}1\.20s .*model=gemini-2\.5-flash {2}tokens=1200\/80 {2}cost=\$0\.0012$/);
  assert.match(lines[3], /^│  └─ GET \/api\/v1\/items {2}500ms \[studio-api\] {2}http=200$/);
  assert.match(lines[4], /^│     └─ SELECT items {2}20ms/);
  assert.match(lines[5], /^└─ chat .*ERROR rate_limited$/);
  const t = totals(normalizeSpans(fixture));
  assert.deepEqual({ ...t, cost: Number(t.cost.toFixed(4)) }, { spans: 6, cost: 0.0027, tin: 2700, tout: 120, errors: 1 });
});

test("reads OTLP JSON and console-exporter JSON lines", () => {
  const otlp = {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "studio-agent" } }] },
      scopeSpans: [{ spans: [
        { traceId: "a".repeat(32), spanId: "01", name: "root", startTimeUnixNano: "1000000000", endTimeUnixNano: "3000000000", status: {} },
        { traceId: "a".repeat(32), spanId: "02", parentSpanId: "01", name: "child", startTimeUnixNano: "1500000000", endTimeUnixNano: "1600000000",
          attributes: [{ key: "gen_ai.usage.input_tokens", value: { intValue: "7" } }], status: { code: 2, message: "boom" } },
      ] }],
    }],
  };
  const out = formatTree(buildTree(normalizeSpans(otlp)));
  assert.equal(out, "root  2.00s [studio-agent]\n└─ child  100ms [studio-agent]  tokens=7/?  ERROR boom");

  const lines = [
    JSON.stringify({ traceId: "b".repeat(32), id: "x1", name: "run", timestamp: 1_000_000, duration: 2_000_000, attributes: {} }),
    "not json",
    JSON.stringify({ traceId: "b".repeat(32), parentSpanContext: { spanId: "x1" }, id: "x2", name: "tool", timestamp: 1_100_000, duration: 50_000, attributes: {} }),
  ].join("\n");
  assert.equal(formatTree(buildTree(parseSpansText(lines))), "run  2.00s\n└─ tool  50ms");
});

test("orphans (parent in an unsampled or missing half) become roots", () => {
  const spans = normalizeSpans([{ traceId: "c".repeat(32), spans: [{ spanId: "9", parentSpanId: "8", name: "lonely", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:00:01Z" }] }]);
  assert.equal(buildTree(spans).length, 1);
});

test("resolves run and session ids from the local run store, tolerating records without traceId", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-runs-"));
  writeFileSync(join(dir, "run_a.json"), JSON.stringify({ id: "run_a", sessionId: "s1", createdAt: 2, traceId: "d".repeat(32) }));
  writeFileSync(join(dir, "run_b.json"), JSON.stringify({ id: "run_b", sessionId: "s1", createdAt: 1, traceId: "e".repeat(32) }));
  writeFileSync(join(dir, "run_c.json"), JSON.stringify({ id: "run_c", sessionId: "s1", createdAt: 3 }));
  assert.deepEqual(localTraceIds("run_a", dir), [{ runId: "run_a", traceId: "d".repeat(32) }]);
  assert.deepEqual(localTraceIds("run_c", dir), []);
  assert.deepEqual(localTraceIds("s1", dir).map((r) => r.runId), ["run_b", "run_a"]);
  assert.deepEqual(localTraceIds("nope", join(dir, "missing")), []);
});
