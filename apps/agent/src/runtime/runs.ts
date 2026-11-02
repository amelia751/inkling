import { randomUUID } from "node:crypto";
import type { RunStatus } from "@studio/agent-protocol";
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
  approvals = 0;
  /** Prompt text not yet handed to pi (messages sent while the run was still queued). */
  readonly pending: string[] = [];
  /** Why the run was stopped from outside the model loop, if it was. */
  endReason: "cancelled" | "expired" | "budget" | undefined;
  /** The model ended a turn with an error (already reported as an `error` event). */
  failed = false;
  readonly usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };

  /** Who the run acts for (the session's owner, `user:<sub>` in workos mode) and in which organization. */
  readonly principal: string | undefined;
  readonly orgId: string | undefined;

  constructor(
    readonly sessionId: string,
    who: { principal?: string; orgId?: string } = {},
  ) {
    this.principal = who.principal;
    this.orgId = who.orgId;
  }

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
