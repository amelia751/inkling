import { type Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import type { Config } from "../config.ts";
import { SandboxQuotaExceededError, SandboxUnavailableError, mapDaytonaError, withRateLimitRetry } from "./client.ts";
import {
  DEFAULT_EGRESS,
  type EgressPolicy,
  SANDBOX_CWD,
  SANDBOX_DATA_DIR,
  SANDBOX_OUT_DIR,
  type SandboxOwner,
  createParams,
  sandboxName,
} from "./defaults.ts";
import { ensureStarted, execCommand } from "./exec.ts";
import { resolveSnapshot } from "./snapshot.ts";

export type SandboxEvent =
  | { state: "creating"; name: string }
  | { state: "ready" | "resumed"; sandboxId: string; name: string }
  | { state: "stopped" | "deleted" | "unavailable"; sandboxId: string };

export interface SandboxContext extends SandboxOwner {
  onEvent?: (e: SandboxEvent) => void;
}

/** Where the session remembers its sandbox id (the pi session JSONL in production, a Map in tests). */
export interface SandboxRefStore {
  get(sessionId: string): string | undefined;
  set(sessionId: string, sandboxId: string | undefined): void;
}

export class MemoryRefStore implements SandboxRefStore {
  private refs = new Map<string, string>();
  get(id: string) {
    return this.refs.get(id);
  }
  set(id: string, sandboxId: string | undefined) {
    if (sandboxId) this.refs.set(id, sandboxId);
    else this.refs.delete(id);
  }
}

export interface ManagerOptions {
  refs?: SandboxRefStore;
  egress?: EgressPolicy;
  /** Called once when create hits an org quota; should free capacity (see sweeper.reclaimForQuota). */
  reclaim?: () => Promise<unknown>;
  warn?: (msg: string) => void;
  createTimeoutS?: number;
}

const KEEPALIVE_MS = 5 * 60 * 1000;

export class SandboxManager {
  private readonly live = new Map<string, Sandbox>();
  private readonly pending = new Map<string, Promise<Sandbox>>();
  readonly refs: SandboxRefStore;

  constructor(
    private readonly daytona: Daytona,
    private readonly config: Config,
    private readonly opts: ManagerOptions = {},
  ) {
    this.refs = opts.refs ?? new MemoryRefStore();
  }

  /** The session's sandbox, created lazily; concurrent callers for one session share the same promise. */
  acquire(ctx: SandboxContext): Promise<Sandbox> {
    const cached = this.live.get(ctx.sessionId);
    if (cached) return Promise.resolve(cached);
    let p = this.pending.get(ctx.sessionId);
    if (!p) {
      p = this.attachOrCreate(ctx).finally(() => this.pending.delete(ctx.sessionId));
      this.pending.set(ctx.sessionId, p);
    }
    return p;
  }

  peek(sessionId: string): Sandbox | undefined {
    return this.live.get(sessionId);
  }

  /** Drop a sandbox that turned out to be gone so the next acquire creates a fresh one. */
  forget(sessionId: string): void {
    const sb = this.live.get(sessionId);
    this.live.delete(sessionId);
    this.refs.set(sessionId, undefined);
    if (sb) this.opts.warn?.(`sandbox ${sb.id} for session ${sessionId} forgotten`);
  }

  private async attachOrCreate(ctx: SandboxContext): Promise<Sandbox> {
    const name = sandboxName(this.config.env, ctx.sessionId);
    const existing = await this.reattach(this.refs.get(ctx.sessionId) ?? name);
    if (existing) {
      const how = await ensureStarted(existing.sandbox).catch((err) => {
        if (err instanceof SandboxUnavailableError) return undefined;
        throw err;
      });
      if (how) {
        await this.prepare(existing.sandbox);
        this.remember(ctx.sessionId, existing.sandbox);
        ctx.onEvent?.({ state: how === "resumed" ? "resumed" : "ready", sandboxId: existing.sandbox.id, name });
        return existing.sandbox;
      }
    }

    ctx.onEvent?.({ state: "creating", name });
    const snapshot = await resolveSnapshot(this.daytona, this.config.sandbox.snapshot, this.opts.warn);
    const params = createParams(this.config, ctx, { snapshot, egress: this.opts.egress ?? DEFAULT_EGRESS });
    const create = () =>
      withRateLimitRetry(() => this.daytona.create(params, { timeout: this.opts.createTimeoutS ?? 120 }));
    let sandbox: Sandbox;
    try {
      sandbox = await create();
    } catch (err) {
      const mapped = mapDaytonaError(err);
      if (!(mapped instanceof SandboxQuotaExceededError) || !this.opts.reclaim) throw mapped;
      this.opts.warn?.(`quota hit creating ${name}; reclaiming idle sandboxes`);
      await this.opts.reclaim();
      sandbox = await create().catch((e) => {
        throw mapDaytonaError(e);
      });
    }
    await this.prepare(sandbox);
    this.remember(ctx.sessionId, sandbox);
    ctx.onEvent?.({ state: "ready", sandboxId: sandbox.id, name });
    return sandbox;
  }

  private async reattach(idOrName: string): Promise<{ sandbox: Sandbox } | undefined> {
    try {
      const sandbox = await withRateLimitRetry(() => this.daytona.get(idOrName));
      if (sandbox.state === "destroyed" || sandbox.state === "destroying" || sandbox.state === "error") return undefined;
      return { sandbox };
    } catch (err) {
      if (err instanceof DaytonaNotFoundError) return undefined;
      throw err;
    }
  }

  private async prepare(sandbox: Sandbox): Promise<void> {
    await execCommand(sandbox, `mkdir -p ${SANDBOX_CWD} ${SANDBOX_DATA_DIR} ${SANDBOX_OUT_DIR}`, { backgroundSafe: false });
  }

  private remember(sessionId: string, sandbox: Sandbox): void {
    this.live.set(sessionId, sandbox);
    this.refs.set(sessionId, sandbox.id);
  }

  /** Background processes don't count as activity; ping while a run is active. Returns a stop function. */
  keepalive(sessionId: string, everyMs = KEEPALIVE_MS): () => void {
    const timer = setInterval(() => {
      void this.live.get(sessionId)?.refreshActivity().catch(() => {});
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** `stop` when a session goes idle (disk kept), `delete` when the user deletes the session. */
  async release(sessionId: string, mode: "stop" | "delete", onEvent?: SandboxContext["onEvent"]): Promise<void> {
    await this.pending.get(sessionId)?.catch(() => {});
    const sandbox = this.live.get(sessionId) ?? (await this.reattach(this.refs.get(sessionId) ?? sandboxName(this.config.env, sessionId)))?.sandbox;
    if (!sandbox) return;
    if (mode === "delete") {
      this.opts.warn?.(`deleting sandbox ${sandbox.id} labels=${JSON.stringify(sandbox.labels)}`);
      await withRateLimitRetry(() => sandbox.delete(60)).catch((err) => {
        if (!(err instanceof DaytonaNotFoundError)) throw err;
      });
      this.live.delete(sessionId);
      this.refs.set(sessionId, undefined);
      onEvent?.({ state: "deleted", sandboxId: sandbox.id });
    } else {
      await sandbox.refreshData().catch(() => {});
      if (sandbox.state === "started") await withRateLimitRetry(() => sandbox.stop(60));
      onEvent?.({ state: "stopped", sandboxId: sandbox.id });
    }
  }
}
