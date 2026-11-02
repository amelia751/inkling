import assert from "node:assert/strict";
import { test } from "node:test";
import { type Http, type Result, writeEnvironment } from "../../src/environment-write.ts";

function fake(answers: Record<string, Result>) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const http: Http = async (method, path, body) => {
    calls.push({ method, path, body });
    return answers[method] ?? { ok: true, status: 200, data: {} };
  };
  return { http, calls };
}

test("patch fetches the current revision and sends it", async () => {
  const { http, calls } = fake({ GET: { ok: true, status: 200, data: { revision: 7 } }, PATCH: { ok: true, status: 200, data: { revision: 8 } } });
  const r = await writeEnvironment(http, "PATCH", "proj 1", { patch: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", "/api/environments/proj%201"], ["PATCH", "/api/environments/proj%201"]]);
  assert.deepEqual(calls[1]!.body, { patch: [], revision: 7 });
});

test("set with no saved environment sends revision 0", async () => {
  const { http, calls } = fake({ GET: { ok: true, status: 200, data: { revision: 0, environment: null } } });
  await writeEnvironment(http, "PUT", "p", { environment: { a: 1 } });
  assert.deepEqual(calls[1]!.body, { environment: { a: 1 }, revision: 0 });
});

test("a caller's revision is sent as is, without a fetch", async () => {
  const { http, calls } = fake({});
  await writeEnvironment(http, "PUT", "p", { environment: {} }, 3);
  assert.deepEqual(calls.map((c) => c.method), ["PUT"]);
  assert.equal(calls[0]!.body.revision, 3);
});

test("a 409 becomes a clear tool error with the current revision", async () => {
  const { http } = fake({ PATCH: { ok: false, status: 409, data: { error: "revision conflict", current: { revision: 5 } } } });
  const r = await writeEnvironment(http, "PATCH", "p", { patch: [] }, 4);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /revision 4 of p.*now at 5.*get_environment/);
});

test("a failed fetch of the current revision is returned", async () => {
  const { http, calls } = fake({ GET: { ok: false, status: 404, data: { error: "no such project" } } });
  const r = await writeEnvironment(http, "PATCH", "p", { patch: [] });
  assert.equal(r.status, 404);
  assert.equal(calls.length, 1);
});
