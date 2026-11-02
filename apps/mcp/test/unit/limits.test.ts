import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter, MemoryStore } from "../../src/limits.ts";

test("per-minute rate limit per token, reset next minute", async () => {
  let now = 60_000 * 1000 + 5_000;
  const lim = new Limiter(new MemoryStore(() => now), 3, 0, () => now);
  for (let i = 0; i < 3; i++) assert.deepEqual(await lim.hit("a", false), { ok: true });
  const r = await lim.hit("a", false);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.kind, "rate");
  assert.equal(r.ok === false && r.retryAfterS, 55);
  assert.deepEqual(await lim.hit("b", false), { ok: true }, "other tokens are separate");
  now += 60_000;
  assert.deepEqual(await lim.hit("a", false), { ok: true });
});

test("daily write quota counts writes only", async () => {
  const now = 86_400_000 * 100;
  const lim = new Limiter(new MemoryStore(() => now), 0, 2, () => now);
  assert.deepEqual(await lim.hit("a", true), { ok: true });
  assert.deepEqual(await lim.hit("a", false), { ok: true });
  assert.deepEqual(await lim.hit("a", true), { ok: true });
  const r = await lim.hit("a", true);
  assert.equal(r.ok === false && r.kind, "quota");
});
