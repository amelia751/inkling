import type { AgentEvent, AgentEventBody } from "@studio/agent-protocol";
import type { EventLog } from "../runtime/events.ts";
import type { BusItem, RunEventBus } from "./types.ts";

const KEEP_LOGS = 1000;

/** Single-process bus: reads straight from the run's in-memory EventLog (the pre-cluster behaviour). */
export class MemoryRunEventBus implements RunEventBus {
  readonly kind = "memory" as const;
  private readonly logs = new Map<string, EventLog>();
  private readonly handlers = new Set<(runId: string) => void>();

  constructor(private readonly idleMs = 5000) {}

  async init(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {
    this.handlers.clear();
  }

  attach(log: EventLog): void {
    this.logs.set(log.runId, log);
    while (this.logs.size > KEEP_LOGS) this.logs.delete(this.logs.keys().next().value!);
  }

  async publish(_e: AgentEvent): Promise<void> {}

  async appendTail(runId: string, bodies: AgentEventBody[]): Promise<void> {
    const log = this.logs.get(runId);
    if (log && !log.closed) for (const b of bodies) log.push(b);
  }

  async oldestSeq(runId: string): Promise<number | undefined> {
    const log = this.logs.get(runId);
    return log && log.lastSeq > 0 ? log.oldestSeq : undefined;
  }

  async *read(runId: string, after: number, signal: AbortSignal): AsyncIterable<BusItem> {
    const log = this.logs.get(runId);
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = log?.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    let last = after;
    try {
      // Replay first; events that arrived meanwhile are deduplicated by seq.
      if (log) queue.unshift(...log.after(after));
      for (;;) {
        while (queue.length) {
          const e = queue.shift()!;
          if (e.seq <= last) continue;
          last = e.seq;
          yield e;
        }
        if (signal.aborted || log?.closed) return;
        let timer: NodeJS.Timeout | undefined;
        const idle = await new Promise<boolean>((r) => {
          wake = () => r(false);
          timer = setTimeout(() => r(true), this.idleMs);
        });
        clearTimeout(timer);
        wake = undefined;
        if (idle && !queue.length) yield "idle";
      }
    } finally {
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
    }
  }

  async signal(runId: string): Promise<void> {
    for (const h of this.handlers) queueMicrotask(() => h(runId));
  }

  onSignal(fn: (runId: string) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
}
