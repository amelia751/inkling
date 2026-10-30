import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryRunEventBus } from "../../src/bus/memory.ts";
import { RedisRunEventBus } from "../../src/bus/redis.ts";
import type { BusItem, RunEventBus } from "../../src/bus/types.ts";
import type { AgentEvent } from "@studio/agent-protocol";
import { EventLog } from "../../src/runtime/events.ts";

const REDIS = process.env.AGENT_TEST_REDIS_URL;

async function collect(it: AsyncIterable<BusItem>, until: (e: AgentEvent) => boolean, maxIdle = 3): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let idle = 0;
  for await (const x of it) {
    if (x === "idle") {
      if (++idle >= maxIdle) break;
      continue;
    }
    out.push(x);
    if (until(x)) break;
  }
  return out;
}

describe("memory bus", () => {
  it("reads a run's log from any seq and follows it to done", async () => {
    const bus = new MemoryRunEventBus(50);
    const log = new EventLog("run_m");
    bus.attach(log);
    for (let i = 0; i < 3; i++) log.push({ type: "text", delta: String(i) });
    const ac = new AbortController();
    const reading = collect(bus.read("run_m", 1, ac.signal), (e) => e.type === "done");
    log.push({ type: "done", status: "completed" });
    expect((await reading).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(await bus.oldestSeq("run_m")).toBe(1);
    expect(await bus.oldestSeq("run_other")).toBeUndefined();
  });

  it("yields idle for runs it doesn't have, and delivers signals", async () => {
    const bus = new MemoryRunEventBus(20);
    const ac = new AbortController();
    const items: BusItem[] = [];
    for await (const x of bus.read("run_none", 0, ac.signal)) {
      items.push(x);
      if (items.length === 2) ac.abort();
    }
    expect(items).toEqual(["idle", "idle"]);
    const got: string[] = [];
    bus.onSignal((id) => got.push(id));
    await bus.signal("run_x");
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(["run_x"]);
  });
});

describe.skipIf(!REDIS)("redis bus", () => {
  const prefix = `agenttest${randomUUID().slice(0, 8)}`;
  const buses: RunEventBus[] = [];
  const make = async (maxLen = 1000) => {
    const b = new RedisRunEventBus(REDIS!, { prefix, maxLen, ttlS: 120, blockMs: 100 });
    await b.init();
    buses.push(b);
    return b;
  };
  const ev = (runId: string, seq: number, extra: Partial<AgentEvent> = {}) => ({ type: "text", delta: `d${seq}`, seq, runId, at: Date.now(), ...extra }) as AgentEvent;
  afterAll(async () => {
    for (const b of buses) await b.close();
    const r = new Redis(REDIS!);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    await r.quit();
  });

  it("another instance replays from a seq (Last-Event-ID) and follows live events to done", async () => {
    const writer = await make();
    const reader = await make();
    const runId = `run_${randomUUID()}`;
    for (let s = 1; s <= 3; s++) await writer.publish(ev(runId, s));
    const ac = new AbortController();
    const reading = collect(reader.read(runId, 2, ac.signal), (e) => e.type === "done", 50);
    await new Promise((r) => setTimeout(r, 150));
    await writer.publish(ev(runId, 4));
    await writer.publish({ type: "done", status: "completed", seq: 5, runId, at: Date.now() });
    expect((await reading).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(await reader.oldestSeq(runId)).toBe(1);
  });

  it("stream keys use the resource prefix, carry a TTL and reject a replayed seq", async () => {
    const bus = (await make()) as RedisRunEventBus;
    const runId = `run_${randomUUID()}`;
    await bus.publish(ev(runId, 1));
    const r = new Redis(REDIS!);
    expect(bus.key(runId)).toBe(`${prefix}:run:${runId}`);
    const ttl = await r.ttl(bus.key(runId));
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
    await r.quit();
    await expect(bus.publish(ev(runId, 1))).rejects.toThrow();
  });

  it("MAXLEN caps a stream; readers learn the oldest seq still available", async () => {
    const bus = await make(100);
    const runId = `run_${randomUUID()}`;
    for (let s = 1; s <= 400; s++) await bus.publish(ev(runId, s));
    const oldest = (await bus.oldestSeq(runId))!;
    expect(oldest).toBeGreaterThan(1);
    expect(400 - oldest).toBeLessThan(250);
  });

  it("appendTail continues after the last stored seq (interrupted runs)", async () => {
    const bus = await make();
    const runId = `run_${randomUUID()}`;
    for (let s = 1; s <= 2; s++) await bus.publish(ev(runId, s));
    await bus.appendTail(runId, [
      { type: "error", message: "interrupted" },
      { type: "done", status: "failed" },
    ]);
    const all = await collect(bus.read(runId, 0, new AbortController().signal), (e) => e.type === "done");
    expect(all.map((e) => [e.seq, e.type])).toEqual([
      [1, "text"],
      [2, "text"],
      [3, "error"],
      [4, "done"],
    ]);
  });

  it("signals reach every instance", async () => {
    const a = await make();
    const b = await make();
    const got: string[] = [];
    b.onSignal((id) => got.push(id));
    await a.signal("run_sig");
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["run_sig"]);
  });
});
