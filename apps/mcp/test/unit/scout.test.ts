import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOUT_TOOLS, callScoutTool } from "../../src/scout.ts";
import { staticTools } from "../../src/server.ts";

test("todo23: the scout tools are listed with the in-house names", () => {
  const names = staticTools().map((t) => t.name);
  for (const n of ["search_oss", "vet_oss", "trial_oss", "compare_oss"]) assert.ok(names.includes(n), n);
  assert.equal(SCOUT_TOOLS.length, 4);
});

test("todo23: scout tools post to the agent service's /v1/scout routes", async () => {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ decision: "refused" }), { status: 200 });
  }) as typeof fetch;
  const cfg = { agentUrl: "http://agent", agentToken: "svc" };
  const r = await callScoutTool(cfg, undefined, "vet_oss", { projectId: "p", package: "backtrader", ecosystem: "pypi" }, fake);
  assert.equal(r?.isError, false);
  assert.match(r!.content[0]!.text, /refused/);
  assert.equal(calls[0]!.url, "http://agent/v1/scout/vet");
  assert.equal(calls[0]!.headers.Authorization, "Bearer svc");
  // A caller's own token rides along; the service token moves to its header.
  await callScoutTool(cfg, "person-jwt", "search_oss", { projectId: "p", need: "grid", ecosystem: "npm" }, fake);
  assert.equal(calls[1]!.headers["x-agent-service-token"], "svc");
  assert.equal(calls[1]!.headers.Authorization, "Bearer person-jwt");
  assert.equal(await callScoutTool(cfg, undefined, "catalog", {}, fake), undefined);
  const off = await callScoutTool({ agentUrl: "http://agent", agentToken: undefined }, undefined, "vet_oss", {}, fake);
  assert.equal(off?.isError, true);
});
