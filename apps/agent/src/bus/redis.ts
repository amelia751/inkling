import { Redis } from "ioredis";
import type { AgentEvent, AgentEventBody } from "../protocol.ts";
import type { EventLog } from "../runtime/events.ts";
import type { BusItem, RunEventBus } from "./types.ts";

export interface RedisBusOptions {
  /** `<prefix>:run:<id>` streams and the `<prefix>:agent:signals` channel. */
  prefix: string;
  /** Approximate cap per stream (XADD MAXLEN ~). */
  maxLen: number;
  /** Seconds a stream lives after its last event. */
  ttlS: number;
  /** XREAD BLOCK timeout; an `idle` item is yielded each time it passes. */
  blockMs?: number;
  log?: (msg: string) => void;
}

const seqOf = (id: string) => Number(id.split("-")[0]);

/**
 * Redis Streams bus (AGENT_EVENT_BUS=redis). Entry ids are `<seq>-0`, so "events after seq N" is
 * `XREAD … STREAMS key N-0` and a replayed write of an old seq is rejected by Redis instead of
 * duplicated. Each SSE reader uses its own connection for the blocking XREAD.
 */
export class RedisRunEventBus implements RunEventBus {
  readonly kind = "redis" as const;
  private readonly cmd: Redis;
  private sub: Redis | undefined;
  private readonly handlers = new Set<(runId: string) => void>();
  private readonly readers = new Set<Redis>();

  constructor(
    url: string,
    private readonly opts: RedisBusOptions,
  ) {
    this.cmd = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: true });
    this.cmd.on("error", (err) => opts.log?.(`redis error: ${err.message}`));
  }

  key = (runId: string) => `${this.opts.prefix}:run:${runId}`;
  get channel() {
    return `${this.opts.prefix}:agent:signals`;
  }

  async init(): Promise<void> {
    await this.cmd.connect();
    this.sub = this.cmd.duplicate();
    this.sub.on("error", (err) => this.opts.log?.(`redis subscriber error: ${err.message}`));
    this.sub.on("message", (_channel: string, message: string) => {
      let runId: string | undefined;
      try {
        runId = (JSON.parse(message) as { runId?: string }).runId;
      } catch {
        return;
      }
      if (runId) for (const h of this.handlers) h(runId);
    });
    await this.sub.subscribe(this.channel);
  }

  async ping(): Promise<void> {
    await this.cmd.ping();
  }

  async close(): Promise<void> {
    for (const r of this.readers) r.disconnect();
    this.readers.clear();
    this.handlers.clear();
    await this.sub?.quit().catch(() => {});
    await this.cmd.quit().catch(() => {});
  }

  attach(_log: EventLog): void {}

  async publish(e: AgentEvent): Promise<void> {
    const key = this.key(e.runId);
    const res = await this.cmd
      .multi()
      .xadd(key, "MAXLEN", "~", this.opts.maxLen, `${e.seq}-0`, "e", JSON.stringify(e))
      .expire(key, this.opts.ttlS)
      .exec();
    const err = res?.find(([e]) => e)?.[0];
    if (err) throw err;
  }

  async appendTail(runId: string, bodies: AgentEventBody[]): Promise<void> {
    const last = await this.cmd.xrevrange(this.key(runId), "+", "-", "COUNT", 1);
    let seq = last[0] ? seqOf(last[0][0]) : 0;
    for (const body of bodies) {
      seq++;
      await this.publish({ ...body, seq, runId, at: Date.now() } as AgentEvent).catch(() => {
        // Someone (a not-quite-dead replica) wrote that seq first; theirs stands.
      });
    }
  }

  async oldestSeq(runId: string): Promise<number | undefined> {
    const first = await this.cmd.xrange(this.key(runId), "-", "+", "COUNT", 1);
    return first[0] ? seqOf(first[0][0]) : undefined;
  }

  async *read(runId: string, after: number, signal: AbortSignal): AsyncIterable<BusItem> {
    if (signal.aborted) return;
    const conn = this.cmd.duplicate();
    conn.on("error", () => {});
    this.readers.add(conn);
    const onAbort = () => conn.disconnect();
    signal.addEventListener("abort", onAbort);
    let cursor = `${after}-0`;
    try {
      while (!signal.aborted) {
        let res: [string, [string, string[]][]][] | null;
        try {
          res = (await conn.xread("COUNT", 500, "BLOCK", this.opts.blockMs ?? 5000, "STREAMS", this.key(runId), cursor)) as typeof res;
        } catch (err) {
          if (signal.aborted) return;
          throw err;
        }
        if (!res) {
          yield "idle";
          continue;
        }
        for (const [, entries] of res)
          for (const [id, fields] of entries) {
            cursor = id;
            const raw = fields[fields.indexOf("e") + 1];
            if (raw) yield JSON.parse(raw) as AgentEvent;
          }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.readers.delete(conn);
      conn.disconnect();
    }
  }

  async signal(runId: string): Promise<void> {
    await this.cmd.publish(this.channel, JSON.stringify({ runId }));
  }

  onSignal(fn: (runId: string) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
}
