import assert from "node:assert/strict";
import { test } from "node:test";
import { type Caller, callOperationTool, formatReply, isWriteCall, OPERATIONS, operationByTool, operationTools, planRequest, requiredScope } from "../../src/operations.ts";
import { staticTools } from "../../src/server.ts";

const tool = (name: string) => operationTools().find((t) => t.name === name)!;

test("project_context is the first tool, then one tool per operation", () => {
  const tools = staticTools();
  assert.equal(tools[0]!.name, "project_context");
  for (const op of OPERATIONS) assert.ok(tools.some((t) => t.name === op.tool), op.id);
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "tool names are unique");
});

test("hints come from the tier", () => {
  assert.deepEqual(tool("source_list").annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(tool("dataset_create").annotations!.readOnlyHint, false);
  assert.equal(tool("dataset_create").annotations!.destructiveHint, false);
  assert.equal(tool("dataset_create").annotations!.idempotentHint, false);
  assert.equal(tool("dataset_rename").annotations!.idempotentHint, true);
  assert.equal(tool("dataset_delete").annotations!.destructiveHint, true);
  assert.equal(tool("trash_empty").annotations!.destructiveHint, true);
});

test("writes take dryRun, reads don't; destroy needs confirm; versioned updates take revision", () => {
  const props = (n: string) => (tool(n).inputSchema as any).properties;
  assert.ok(props("dataset_create").dryRun);
  assert.equal(props("source_list").dryRun, undefined);
  assert.ok((tool("trash_empty").inputSchema as any).required.includes("confirm"));
  assert.ok(props("studio_patch").revision);
});

test("dryRun goes on the query string; path placeholders are filled", () => {
  const p = planRequest(operationByTool("dataset_rename")!, { projectId: "p 1", datasetId: "d/1", name: "x", dryRun: true });
  assert.deepEqual(p, { method: "PATCH", path: "/api/v1/projects/p%201/datasets/d%2F1?dryRun=true", body: { name: "x" } });
  const fs = planRequest(operationByTool("source_mkdir")!, { projectId: "p", parentId: "n", name: "a" });
  assert.deepEqual(fs, { method: "POST", path: "/api/v1/projects/p/fs/ops", body: { ops: [{ kind: "mkdir", parentId: "n", name: "a" }] } });
  assert.deepEqual(planRequest(operationByTool("trash_empty")!, { projectId: "p" }), { error: "trash.empty deletes forever and can't be undone: ask the person, then call again with confirm: true" });
});

function fakeApi(replies: ((url: string, init: RequestInit) => { status: number; body: unknown })[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = replies.shift();
    if (!next) throw new Error("no reply");
    const r = next(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("every write sends an Idempotency-Key, the same one on retry", async () => {
  const { f, calls } = fakeApi([() => ({ status: 503, body: {} }), () => ({ status: 201, body: { id: "d1" } })]);
  const caller: Caller = { apiUrl: "http://api", token: "t", fetch: f, retryDelayMs: 0 };
  const r = await callOperationTool(caller, "dataset_create", { projectId: "p", name: "x" });
  assert.equal(r!.isError, undefined);
  assert.equal(calls.length, 2);
  const k1 = calls[0]!.headers["Idempotency-Key"];
  assert.match(k1!, /^[0-9a-f-]{36}$/);
  assert.equal(calls[1]!.headers["Idempotency-Key"], k1);
  assert.equal(calls[0]!.headers.Authorization, "Bearer t");
  // A new call gets a new key; reads get none.
  const again = fakeApi([() => ({ status: 201, body: {} }), () => ({ status: 200, body: {} })]);
  await callOperationTool({ ...caller, fetch: again.f }, "dataset_create", { projectId: "p", name: "x" });
  await callOperationTool({ ...caller, fetch: again.f }, "dataset_list", { projectId: "p" });
  assert.notEqual(again.calls[0]!.headers["Idempotency-Key"], k1);
  assert.equal(again.calls[1]!.headers["Idempotency-Key"], undefined);
});

test("versioned updates fetch the revision and send it", async () => {
  const { f, calls } = fakeApi([() => ({ status: 200, body: { revision: 4 } }), () => ({ status: 200, body: { revision: 5 } })]);
  await callOperationTool({ apiUrl: "http://api", token: "t", fetch: f }, "studio_patch", { projectId: "p", patch: [] });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", "http://api/api/environments/p"], ["PATCH", "http://api/api/environments/p"]]);
  assert.deepEqual(calls[1]!.body, { patch: [], revision: 4 });
  const given = fakeApi([() => ({ status: 200, body: {} })]);
  await callOperationTool({ apiUrl: "http://api", token: "t", fetch: given.f }, "studio_patch", { projectId: "p", patch: [], revision: 9 });
  assert.equal(given.calls.length, 1);
  assert.equal(given.calls[0]!.body.revision, 9);
});

test("project_context reads /context", async () => {
  const { f, calls } = fakeApi([() => ({ status: 200, body: { project: { id: "p" } } })]);
  const r = await callOperationTool({ apiUrl: "http://api", token: "t", fetch: f }, "project_context", { projectId: "p" });
  assert.equal(calls[0]!.url, "http://api/api/v1/projects/p/context");
  assert.match(r!.content[0]!.text, /"id": "p"/);
});

test("a rejection lists every violation with its fix", () => {
  const r = formatReply({
    ok: false,
    status: 422,
    data: {
      title: "2 rules failed",
      code: "write_rejected",
      violations: [
        { rule: "labels.vocabulary", severity: "error", path: "/labels/0", message: "PNA is not a label", fix: "Use pneumonia", allowed: ["normal", "pneumonia"] },
        { rule: "layout.folders", severity: "error", path: "/parentId", message: "misc/stuff isn't allowed", fix: "Put files in images/" },
      ],
    },
  });
  assert.equal(r.isError, true);
  const t = r.content[0]!.text;
  assert.match(t, /Rejected \(422 write_rejected\)/);
  assert.match(t, /labels\.vocabulary at \/labels\/0: PNA is not a label Fix: Use pneumonia Allowed: "normal", "pneumonia"/);
  assert.match(t, /layout\.folders at \/parentId: .* Fix: Put files in images\//);
});

test("a 202 change request is reported in words", () => {
  const r = formatReply({ ok: true, status: 202, data: { changeRequest: { id: "cr1", title: "Rename labels", state: "checking", findings: [] } } });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0]!.text, /^Opened change request cr1 "Rename labels" \(state: checking\)/);
  assert.equal((r.structuredContent as any).changeRequest.id, "cr1");
});

test("scopes and write counting", () => {
  assert.equal(requiredScope("project_context"), "project:read");
  assert.equal(requiredScope("dataset_create"), "project:write");
  assert.equal(requiredScope("dataset_delete"), "project:trash");
  assert.equal(requiredScope("trash_empty"), "project:destroy");
  assert.equal(isWriteCall("dataset_create", { name: "x" }), true);
  assert.equal(isWriteCall("dataset_create", { dryRun: true }), false);
  assert.equal(isWriteCall("dataset_list", {}), false);
  assert.equal(isWriteCall("patch_environment", {}, new Set(["patch_environment"])), true);
});
