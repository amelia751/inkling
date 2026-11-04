import type { Logger } from "../log.ts";
import { DROP_MILESTONES, type DropMilestone, safeMilestone } from "../tools/drops.ts";
import { sanitizeError } from "./events.ts";
import type { SessionService, WakeOutcome } from "./sessions.ts";

/**
 * todo28 W3 / D7: the assistant follows a drop. The kernel publishes drop milestones
 * (`drop.kind_waiting`, `drop.files_failed`, `drop.settled`); this loop claims them through the
 * built-in subscription `agent-drops` (like the worker's de-identification check), so any replica
 * can take one, hands each drop's batch to `SessionService.wakeForDrop`, and acks what it handled.
 * Coalesced batches stay unacked and come back on a later claim. Nothing is kept in memory: the
 * kernel keeps what's unacked, the session's stored meta keeps the per-drop counters.
 */
export const SUBSCRIBER = "agent-drops";
export const WAKE_EVERY_MS = 3_000;

export interface DropWakesDeps {
  kernelUrl: string;
  /** The agent service's token for the kernel's service routes. */
  token: string;
  sessions: Pick<SessionService, "wakeForDrop">;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DropWakes {
  constructor(private readonly deps: DropWakesDeps) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await (this.deps.fetchImpl ?? fetch)(new URL(path, this.deps.kernelUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  /** One pass: claim, group by drop, wake, ack. Returns each drop's outcome. */
  async tick(): Promise<Record<string, WakeOutcome>> {
    const r = await this.post("/api/v1/worker/subscriptions/claim", { subscriber: SUBSCRIBER, types: DROP_MILESTONES, limit: 50 });
    const raw: any[] = Array.isArray(r?.events) ? r.events : [];
    const ack: string[] = [];
    const byDrop = new Map<string, DropMilestone[]>();
    for (const ev of raw) {
      const m = safeMilestone(ev);
      if (!m) {
        if (typeof ev?.eventId === "string") ack.push(ev.eventId);
        continue;
      }
      byDrop.set(m.dropId, [...(byDrop.get(m.dropId) ?? []), m]);
    }
    const out: Record<string, WakeOutcome> = {};
    for (const [dropId, ms] of byDrop) {
      try {
        const { outcome } = await this.deps.sessions.wakeForDrop(ms, this.deps.now?.() ?? Date.now());
        out[dropId] = outcome;
        if (outcome !== "coalesced") ack.push(...ms.map((m) => m.eventId));
      } catch (err) {
        // Left unacked: retried on the next claim.
        this.deps.log.warn({ dropId, err: sanitizeError(String(err)) }, "drop wake failed");
      }
    }
    if (ack.length) await this.post("/api/v1/worker/subscriptions/ack", { subscriber: SUBSCRIBER, eventIds: ack });
    return out;
  }

  start(everyMs = WAKE_EVERY_MS): () => void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      this.tick()
        .catch((err) => this.deps.log.warn({ err: sanitizeError(String(err)) }, "drop milestones not claimable"))
        .finally(() => (busy = false));
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
