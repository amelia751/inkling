import { randomUUID } from "node:crypto";
import type { RunStatus } from "../protocol.ts";
import { EventLog } from "./events.ts";

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled", "expired"],
  running: ["awaiting_approval", "completed", "failed", "cancelled", "expired"],
  awaiting_approval: ["running", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export const isTerminal = (s: RunStatus) => TRANSITIONS[s].length === 0;

export class Run {
  readonly id = `run_${randomUUID()}`;
  readonly events = new EventLog(this.id);
  readonly abort = new AbortController();
  readonly startedAt = Date.now();
  status: RunStatus = "queued";
  toolCalls = 0;

  constructor(readonly sessionId: string) {}

  /** Idempotent and monotonic: illegal or repeated transitions are ignored and return false. */
  transition(to: RunStatus): boolean {
    if (this.status === to || !TRANSITIONS[this.status].includes(to)) return false;
    this.status = to;
    if (isTerminal(to)) this.events.push({ type: "done", status: to });
    return true;
  }

  get done(): boolean {
    return isTerminal(this.status);
  }
}
