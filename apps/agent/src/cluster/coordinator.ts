import { randomUUID } from "node:crypto";
import type { RunEventBus } from "../bus/types.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { AgentEvent, AgentEventBody, DatasetSnapshot, RunStatus } from "@studio/agent-protocol";
import type { Run } from "../runtime/runs.ts";
import type { SessionContext } from "../runtime/sessions.ts";
import { type InputKind, type InputRecord, type RunRecord, type SessionStore, type StoredMeta, isActiveStatus } from "../store/types.ts";

export const INTERRUPTED_MESSAGE =
  "Interrupted: the agent service stopped while this run was in progress. Send your message again to continue from here.";

/** What a run looks like to someone who isn't necessarily on the replica running it. */
export interface RunView {
  id: string;
  sessionId: string;
  status: RunRecord["status"];
  local: boolean;
}

/** Wire status for a stored one (`interrupted` isn't in the protocol yet; the panel shows the error). */
export const wireStatus = (s: RunRecord["status"]): RunStatus => (s === "interrupted" ? "failed" : s);

interface LocalRun {
  ctx: SessionContext;
  run: Run;
  /** Store writes and bus publishes for this run, in event order. */
  chain: Promise<void>;
  /** Being stopped by drain or a lost lease: the record ends as `interrupted`. */
  interrupting: boolean;
}

export interface CoordinatorDeps {
  store: SessionStore;
  bus: RunEventBus;
  config: Config;
  log: Logger;
  /** Stop a local run the way a user cancel does (SessionService.abortRun). */
  abort: (ctx: SessionContext, run: Run) => void;
}

/**
 * Everything that lets several replicas share sessions (todo/todo3.md E.1):
 *
 * - run records with a lease: the replica running a loop heartbeats; a run whose replica went quiet
 *   for AGENT_RUN_LEASE_S is marked `interrupted` by whoever reads it next;
 * - run events forwarded to the bus in seq order (`done` only after the transcript and the terminal
 *   record are durable, so a follow-up message on another replica sees the finished session);
 * - approvals, client-tool results and steer/cancel commands stored as run inputs; the POST can hit
 *   any replica, which wakes the loop's replica with a bus signal (plus a poll as a fallback);
 * - per-session write queues and revisions, so a replica notices its cached pi session is stale.
 *
 * The agent loop itself never moves: it lives on one replica until it ends.
 */
export class RunCoordinator {
  readonly replicaId: string;
  /** SIGTERM received: no new runs here. */
  draining = false;
  private readonly local = new Map<string, LocalRun>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly revs = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly offSignal: () => void;

  constructor(private readonly deps: CoordinatorDeps) {
    this.replicaId = deps.config.cluster.replicaId;
    this.offSignal = deps.bus.onSignal((runId) => {
      if (this.local.has(runId)) void this.drainInputs([runId]);
    });
    const beat = setInterval(() => void this.heartbeat(), deps.config.cluster.heartbeatS * 1000);
    beat.unref();
    this.timers.push(beat);
    if (deps.bus.kind !== "memory") {
      // Pub/sub is at-most-once; the poll picks up anything a lost signal didn't.
      const poll = setInterval(() => {
        const ids = this.activeLocalIds();
        if (ids.length) void this.drainInputs(ids);
      }, deps.config.cluster.inboxPollMs);
      poll.unref();
      this.timers.push(poll);
    }
  }

  get store() {
    return this.deps.store;
  }
  get bus() {
    return this.deps.bus;
  }
  private get log() {
    return this.deps.log;
  }
  private get leaseMs() {
    return this.deps.config.cluster.leaseS * 1000;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.offSignal();
  }

  // ---- session writes ------------------------------------------------------------------------

  /** Writes for one session run one at a time, in call order. */
  private enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    this.writes.set(sessionId, tail);
    void tail.then(() => {
      if (this.writes.get(sessionId) === tail) this.writes.delete(sessionId);
    });
    return next;
  }

  private track(sessionId: string, rev: number | undefined): void {
    if (rev !== undefined) this.revs.set(sessionId, rev);
  }

  /** New session: meta and the transcript header are durable before the 201. */
  async createSession(meta: StoredMeta, transcript: unknown[]): Promise<void> {
    await this.enqueue(meta.id, async () => {
      this.track(meta.id, await this.store.putMeta(meta));
      this.track(meta.id, await this.store.appendTranscript(meta.id, 0, transcript));
    });
  }

  /** Background meta write (sandbox id, artifacts); failures are logged. */
  persistMeta(meta: StoredMeta): void {
    void this.enqueue(meta.id, async () => this.track(meta.id, await this.store.putMeta(meta))).catch((err) =>
      this.log.error({ sessionId: meta.id, err: String(err) }, "session meta write failed"),
    );
  }

  /** Background transcript append; `from` is the position of `items[0]` (0 = header). */
  persistTranscript(sessionId: string, from: number, items: unknown[]): void {
    void this.enqueue(sessionId, async () => this.track(sessionId, await this.store.appendTranscript(sessionId, from, items))).catch((err) =>
      this.log.error({ sessionId, err: String(err) }, "transcript write failed"),
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, () => this.store.deleteSession(sessionId));
    this.revs.delete(sessionId);
  }

  flush(sessionId: string): Promise<void> {
    return (this.writes.get(sessionId) ?? Promise.resolve()).then(() => {});
  }

  /** Remember the revision before reading a session, so later writes elsewhere are noticed. */
  async noteLoading(sessionId: string): Promise<void> {
    this.track(sessionId, await this.store.revision(sessionId));
  }

  /** False when another replica changed the session since this one loaded or wrote it. */
  async isFresh(ctx: SessionContext): Promise<boolean> {
    if ((ctx.activeRun && !ctx.activeRun.done) || this.writes.has(ctx.id)) return true;
    const rev = await this.store.revision(ctx.id);
    if (rev === undefined) return !this.revs.has(ctx.id);
    return rev === this.revs.get(ctx.id);
  }

  forget(sessionId: string): void {
    this.revs.delete(sessionId);
  }

  // ---- runs on this replica ------------------------------------------------------------------

  /**
   * Claim the session's single active-run slot for a new local run and start forwarding its
   * events. Returns the run to steer into instead when one is already active (here or elsewhere).
   */
  async startRun(ctx: SessionContext, run: Run): Promise<RunRecord | undefined> {
    // The previous local run's terminal record must land before claiming the slot again.
    await Promise.all([...this.local.values()].filter((l) => l.ctx.id === ctx.id).map((l) => l.chain));
    await this.flush(ctx.id);
    const now = Date.now();
    const rec: RunRecord = { id: run.id, sessionId: ctx.id, owner: ctx.meta.owner, status: "queued", replica: this.replicaId, createdAt: now, updatedAt: now, heartbeatAt: now };
    for (let attempt = 0; attempt < 2; attempt++) {
      // Registered before the insert so a concurrent read never sees our own record as orphaned.
      this.local.set(run.id, { ctx, run, chain: Promise.resolve(), interrupting: false });
      const inserted = await this.store.insertRun(rec).catch((err) => {
        this.local.delete(run.id);
        throw err;
      });
      if (inserted) {
        this.bus.attach(run.events);
        run.events.subscribe((e) => this.forward(run.id, e));
        return undefined;
      }
      this.local.delete(run.id);
      const other = await this.store.activeRunForSession(ctx.id);
      if (!other) continue;
      if (other.replica === this.replicaId && !this.local.has(other.id)) {
        // Ours but not running here (a terminal write that failed): close it and retry.
        await this.store.markInterrupted(other.id);
        continue;
      }
      if (other.replica !== this.replicaId && (await this.interruptIfStale(other))) continue;
      return other;
    }
    return (await this.store.activeRunForSession(ctx.id)) ?? rec;
  }

  private forward(runId: string, e: AgentEvent): void {
    const l = this.local.get(runId);
    if (!l) return;
    l.chain = l.chain
      .then(() => this.handle(l, e))
      .catch((err) => this.log.warn({ runId, seq: e.seq, err: String(err) }, "run event forward failed"));
  }

  private async handle(l: LocalRun, e: AgentEvent): Promise<void> {
    const { run, ctx } = l;
    try {
      if (e.type === "run-status") await this.store.updateRun(run.id, { status: e.status });
      if (e.type === "done") {
        await this.flush(ctx.id);
        await this.store.updateRun(run.id, { status: l.interrupting ? "interrupted" : e.status, usage: run.usage, toolCalls: run.toolCalls });
        await this.store.closeRunInputs(run.id);
      }
    } catch (err) {
      this.log.warn({ runId: run.id, type: e.type, err: String(err) }, "run record write failed");
    }
    try {
      await this.bus.publish(e);
    } finally {
      if (e.type === "done") this.local.delete(run.id);
    }
  }

  private activeLocalIds(): string[] {
    return [...this.local.values()].filter((l) => !l.run.done).map((l) => l.run.id);
  }

  /** Runs whose loop is on this replica and not finished. */
  get localRunCount(): number {
    return this.local.size;
  }

  markInterrupting(runId: string): void {
    const l = this.local.get(runId);
    if (l) l.interrupting = true;
  }

  /** Resolve when every local run has ended and its terminal record is written, or at `deadline`. */
  async waitForLocalRuns(deadline: number): Promise<boolean> {
    while (this.local.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    return this.local.size === 0;
  }

  private async heartbeat(): Promise<void> {
    const ids = this.activeLocalIds();
    if (!ids.length) return;
    try {
      for (const id of await this.store.heartbeat(ids, this.replicaId)) {
        const l = this.local.get(id);
        if (!l || l.run.done) continue;
        // Someone marked it interrupted (we stalled past the lease): stop the loop here too.
        this.log.warn({ runId: id, sessionId: l.ctx.id }, "run lost its lease; stopping it");
        l.interrupting = true;
        this.deps.abort(l.ctx, l.run);
      }
    } catch (err) {
      this.log.warn({ err: String(err) }, "run heartbeat failed");
    }
  }

  // ---- inputs (approvals, client tools, commands) ---------------------------------------------

  /**
   * The SessionContext emit hook: approvals and client-tool requests are recorded before the event
   * goes out, so an answer POSTed to any replica finds them.
   */
  emit(ctx: SessionContext, body: AgentEventBody): void {
    const run = ctx.activeRun;
    if (!run) return;
    const push = () => void run.events.push(body);
    let rec: { id: string; kind: InputKind } | undefined;
    if (body.type === "approval") rec = { id: body.approvalId, kind: "approval" };
    else if (body.type === "client-tool") rec = { id: `${run.id}:${body.callId}`, kind: "client-tool" };
    else if (body.type === "approval-resolved") void this.store.closeInput(body.approvalId).catch(() => {});
    if (!rec) return push();
    let pending: void | Promise<void>;
    try {
      pending = this.store.openInput({ ...rec, runId: run.id, sessionId: ctx.id, owner: ctx.meta.owner });
    } catch (err) {
      this.log.error({ runId: run.id, err: String(err) }, "recording a pending input failed");
      return push();
    }
    if (!pending) return push();
    pending.then(push, (err) => {
      this.log.error({ runId: run.id, err: String(err) }, "recording a pending input failed");
      push();
    });
  }

  /** The client-tool bridge settled a call (answered, timed out, cancelled): later POSTs get 409. */
  clientToolSettled(ctx: SessionContext, callId: string): void {
    const run = ctx.activeRun;
    if (run) void this.store.closeInput(`${run.id}:${callId}`).catch(() => {});
  }

  async answerClientTool(runId: string, callId: string, result: { ok: boolean; output: unknown }, owner: string): Promise<boolean> {
    const rec = await this.store.answerInput(`${runId}:${callId}`, "client-tool", owner, result);
    if (rec) await this.wake(runId);
    return !!rec;
  }

  async decideApproval(approvalId: string, decision: { decision: "approve" | "reject"; note?: string }, owner: string): Promise<boolean> {
    const rec = await this.store.answerInput(approvalId, "approval", owner, decision);
    if (rec) await this.wake(rec.runId);
    return !!rec;
  }

  async steer(rec: RunRecord, text: string, snapshot?: DatasetSnapshot): Promise<void> {
    await this.store.pushCommand({ id: `cmd_${randomUUID()}`, runId: rec.id, sessionId: rec.sessionId, owner: rec.owner, kind: "steer", payload: { text, snapshot } });
    await this.wake(rec.id);
  }

  async cancel(rec: RunRecord): Promise<void> {
    await this.store.pushCommand({ id: `cmd_${randomUUID()}`, runId: rec.id, sessionId: rec.sessionId, owner: rec.owner, kind: "cancel" });
    await this.wake(rec.id);
  }

  private async wake(runId: string): Promise<void> {
    if (this.local.has(runId)) return void this.drainInputs([runId]);
    await this.bus.signal(runId).catch((err) => this.log.warn({ runId, err: String(err) }, "signal failed; the poll will deliver it"));
  }

  private async drainInputs(runIds: string[]): Promise<void> {
    let items: InputRecord[];
    try {
      items = await this.store.takeAnswered(runIds);
    } catch (err) {
      this.log.warn({ err: String(err) }, "reading run inputs failed");
      return;
    }
    for (const i of items) this.apply(i);
  }

  private apply(i: InputRecord): void {
    const l = this.local.get(i.runId);
    if (!l || l.run.done) return;
    const { ctx, run } = l;
    switch (i.kind) {
      case "approval":
        if (!ctx.approvals.has(i.id)) return;
        run.approvals++;
        ctx.approvals.decide(i.id, i.payload as { decision: "approve" | "reject"; note?: string });
        return;
      case "client-tool":
        ctx.bridge.answer(i.id.slice(run.id.length + 1), i.payload as { ok: boolean; output: unknown });
        return;
      case "steer": {
        const { text, snapshot } = i.payload as { text: string; snapshot?: DatasetSnapshot };
        if (snapshot) {
          try {
            ctx.dataset.update(snapshot);
          } catch (err) {
            this.log.warn({ runId: run.id, err: String(err) }, "steer snapshot rejected");
          }
        }
        if (run.status === "queued") run.pending.push(text);
        else void ctx.piSession.steer(text).catch((err) => this.log.warn({ runId: run.id, err: String(err) }, "steer failed"));
        return;
      }
      case "cancel":
        this.deps.abort(ctx, run);
        return;
    }
  }

  // ---- runs anywhere -------------------------------------------------------------------------

  /** A run's record, checked against `owner`; marks it interrupted first if its replica is gone. */
  async getRun(runId: string, owner?: string): Promise<RunRecord | undefined> {
    const rec = await this.store.getRun(runId);
    if (!rec || (owner !== undefined && rec.owner !== owner)) return undefined;
    if (isActiveStatus(rec.status) && rec.replica !== this.replicaId && (await this.interruptIfStale(rec))) return { ...rec, status: "interrupted" };
    if (isActiveStatus(rec.status) && rec.replica === this.replicaId && !this.local.has(rec.id)) {
      await this.store.markInterrupted(rec.id);
      return { ...rec, status: "interrupted" };
    }
    return rec;
  }

  /** The session's active run on another replica (stale ones are interrupted on the way). */
  async activeElsewhere(sessionId: string): Promise<RunRecord | undefined> {
    const rec = await this.store.activeRunForSession(sessionId);
    if (!rec || this.local.has(rec.id)) return undefined;
    if (rec.replica === this.replicaId) {
      await this.store.markInterrupted(rec.id);
      return undefined;
    }
    return (await this.interruptIfStale(rec)) ? undefined : rec;
  }

  private async interruptIfStale(rec: RunRecord): Promise<boolean> {
    if (!(await this.store.interruptIfStale(rec.id, this.leaseMs))) return false;
    this.log.warn({ runId: rec.id, sessionId: rec.sessionId, replica: rec.replica }, "run interrupted: its replica stopped heartbeating");
    await this.bus
      .appendTail(rec.id, [
        { type: "error", message: INTERRUPTED_MESSAGE },
        { type: "done", status: "failed" },
      ])
      .catch((err) => this.log.warn({ runId: rec.id, err: String(err) }, "could not append the interrupted events"));
    return true;
  }

  /** Sessions with a run in flight on any replica (for the sweeper). */
  async activeSessionIds(): Promise<Set<string>> {
    const ids = new Set([...this.local.values()].map((l) => l.ctx.id));
    for (const id of await this.store.activeSessionIds()) ids.add(id);
    return ids;
  }

  // ---- readiness -----------------------------------------------------------------------------

  async readiness(timeoutMs = 2000): Promise<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }> {
    const probe = async (p: () => Promise<void>, detail: string) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([p(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), timeoutMs)))]);
        return { ok: true, detail };
      } catch (err) {
        return { ok: false, detail: `${detail}: ${String((err as Error).message).slice(0, 120)}` };
      } finally {
        clearTimeout(timer);
      }
    };
    const checks: Record<string, { ok: boolean; detail?: string }> = {
      draining: { ok: !this.draining, detail: this.draining ? "shutting down" : "accepting runs" },
      store: await probe(() => this.store.ping(), this.store.kind),
    };
    if (this.bus.kind !== "memory") checks.bus = await probe(() => this.bus.ping(), this.bus.kind);
    return { ok: Object.values(checks).every((c) => c.ok), checks };
  }
}

export { isActiveStatus };
