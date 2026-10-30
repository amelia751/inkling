import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunEventBus } from "../bus/types.ts";
import { INTERRUPTED_MESSAGE, type RunView, isActiveStatus, wireStatus } from "../cluster/coordinator.ts";
import type { AgentEvent } from "@studio/agent-protocol";

const HEARTBEAT_MS = 15_000;

/**
 * GET /v1/runs/:runId/events on any replica: replay from `after` (query or Last-Event-ID) and follow
 * the run through the bus until `done`. If the bus has nothing more (events expired, or a
 * single-process restart lost them) and the run is over, the stream ends with a synthesized `done`
 * so clients never hang on a finished run.
 */
export function streamRunEvents(c: Context, opts: { bus: RunEventBus; run: RunView; after: number; lookup: () => Promise<RunView> }) {
  const { bus, run, after } = opts;
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const heartbeat = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => {}), HEARTBEAT_MS);
    let last = after;
    const finish = async (view: RunView) => {
      const base = { runId: run.id, at: Date.now(), seq: 0 };
      if (view.status === "interrupted") await stream.writeSSE({ data: JSON.stringify({ ...base, type: "error", message: INTERRUPTED_MESSAGE } satisfies AgentEvent) });
      await stream.writeSSE({ data: JSON.stringify({ ...base, type: "done", status: wireStatus(view.status) } satisfies AgentEvent) });
    };
    try {
      const oldest = await bus.oldestSeq(run.id);
      if (oldest === undefined && !run.local && !isActiveStatus(run.status)) return await finish(run);
      if (oldest !== undefined && oldest > after + 1)
        await stream.writeSSE({ data: JSON.stringify({ type: "status", text: "Some earlier events are no longer available.", seq: 0, runId: run.id, at: Date.now() }) });
      let quietTicks = 0;
      for await (const item of bus.read(run.id, after, ac.signal)) {
        if (item === "idle") {
          // Nothing new for a while: if the run is over (or its replica died, which marks it
          // interrupted and appends `done`), give the bus one more tick, then end the stream.
          const view = await opts.lookup().catch(() => undefined);
          if (!view) return;
          if (isActiveStatus(view.status)) quietTicks = 0;
          else if (++quietTicks >= 2) return await finish(view);
          continue;
        }
        if (item.seq <= last) continue;
        last = item.seq;
        await stream.writeSSE({ id: String(item.seq), data: JSON.stringify(item) });
        if (item.type === "done") return;
      }
    } finally {
      clearInterval(heartbeat);
      ac.abort();
    }
  });
}
