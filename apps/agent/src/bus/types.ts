import type { AgentEvent, AgentEventBody } from "../protocol.ts";
import type { EventLog } from "../runtime/events.ts";

/** What `read` yields: events in seq order, or `idle` every few seconds while nothing arrives. */
export type BusItem = AgentEvent | "idle";

/**
 * Run event fan-out (todo/todo3.md E.1). The replica that runs a loop publishes its events in seq
 * order; any replica can `read` them from any seq (SSE with Last-Event-ID), and `signal` wakes the
 * loop's replica when an approval, client-tool result or command for one of its runs was stored.
 *
 * `memory`: one process; reads come straight from the run's EventLog. `redis`: one stream per run,
 * `<resourcePrefix>:run:<runId>`, entry id `<seq>-0`, capped by MAXLEN and expired after a TTL;
 * signals go over one pub/sub channel.
 */
export interface RunEventBus {
  readonly kind: "memory" | "redis";
  init(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
  /** A local run's log (the memory bus reads from it; redis ignores it). */
  attach(log: EventLog): void;
  /** Called once per event, in seq order per run. */
  publish(e: AgentEvent): Promise<void>;
  /** Append after the last stored event (used when a dead replica's run is marked interrupted). */
  appendTail(runId: string, bodies: AgentEventBody[]): Promise<void>;
  /** Oldest seq still available, or undefined when nothing is stored for the run. */
  oldestSeq(runId: string): Promise<number | undefined>;
  read(runId: string, after: number, signal: AbortSignal): AsyncIterable<BusItem>;
  signal(runId: string): Promise<void>;
  onSignal(fn: (runId: string) => void): () => void;
}
