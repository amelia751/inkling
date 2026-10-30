import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInklingSession } from "../agent/factory.ts";
import { DATA_DIR } from "../agent/models.ts";
import { PROFILES, systemPrompt } from "../agent/profiles.ts";
import type { Config } from "../config.ts";
import type { CreateSessionRequest, ProfileName, SessionInfo } from "../protocol.ts";
import { SandboxDisabledError } from "../sandbox/client.ts";
import { SANDBOX_CWD } from "../sandbox/defaults.ts";
import type { SandboxEvent, SandboxManager } from "../sandbox/manager.ts";
import { ClientToolBridge, createClientTools } from "../tools/client.ts";
import { policyExtension } from "../tools/policy.ts";
import { type ArtifactInfo, createSandboxTools } from "../tools/sandbox.ts";
import { ApprovalBroker } from "./approvals.ts";
import { Projector, sanitizeError } from "./events.ts";
import { Run } from "./runs.ts";

export class SessionLimitError extends Error {
  override name = "SessionLimitError";
}

export class Session {
  readonly createdAt = Date.now();
  readonly runs = new Map<string, Run>();
  readonly artifacts: ArtifactInfo[] = [];
  activeRun: Run | undefined;
  pi!: AgentSession;
  bridge!: ClientToolBridge;
  approvals!: ApprovalBroker;

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly owner: string,
    readonly profile: ProfileName,
    readonly restricted: boolean,
  ) {}
}

export interface RegistryDeps {
  config: Config;
  runtime: ModelRuntime;
  sandboxes?: SandboxManager;
  /** Org tier supports an egress allowlist (probed at startup). */
  egressContained?: boolean;
  log?: (msg: string) => void;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly deps: RegistryDeps) {}

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  findRun(runId: string): { session: Session; run: Run } | undefined {
    for (const session of this.sessions.values()) {
      const run = session.runs.get(runId);
      if (run) return { session, run };
    }
    return undefined;
  }

  ids(): Set<string> {
    return new Set(this.sessions.keys());
  }

  activeSessionIds(): Set<string> {
    return new Set([...this.sessions.values()].filter((s) => s.activeRun && !s.activeRun.done).map((s) => s.id));
  }

  async create(req: CreateSessionRequest, owner: string): Promise<Session> {
    const { config, runtime, sandboxes } = this.deps;
    if (this.sessions.size >= config.limits.maxSessions) throw new SessionLimitError(`at most ${config.limits.maxSessions} sessions`);
    const profile = PROFILES[req.profile];
    const s = new Session(`ses_${randomUUID()}`, req.projectId, owner, req.profile, Boolean(req.restricted));

    const emitToActive = (body: Parameters<Run["events"]["push"]>[0]) => s.activeRun?.events.push(body);
    s.bridge = new ClientToolBridge({
      timeoutS: config.clientToolTimeoutS,
      emit: ({ callId, name, input }) => emitToActive({ type: "client-tool", callId, name, input }),
    });
    s.approvals = new ApprovalBroker({
      expiresS: 600,
      emit: (a) => emitToActive({ type: "approval", ...a }),
    });

    const tools = createClientTools(req.clientTools ?? [], profile.clientTools, s.bridge);
    if (profile.sandbox) {
      if (!sandboxes) throw new SandboxDisabledError();
      const owner_ = { sessionId: s.id, projectId: s.projectId, owner, profile: s.profile, restricted: s.restricted };
      const onEvent = (e: SandboxEvent) => emitToActive({ type: "sandbox", state: e.state, ...("sandboxId" in e ? { sandboxId: e.sandboxId } : {}) });
      tools.push(
        ...createSandboxTools({
          acquire: () => sandboxes.acquire({ ...owner_, onEvent }),
          onUnavailable: () => {
            sandboxes.forget(s.id);
            emitToActive({ type: "sandbox", state: "unavailable" });
          },
          execTimeoutS: config.sandbox.execTimeoutS,
          outputMax: config.sandbox.outputMax,
          artifactsDir: join(DATA_DIR, "artifacts", s.id),
          onArtifact: (a) => s.artifacts.push(a),
        }),
      );
    }

    const extension = policyExtension({
      budgets: config.budgets,
      approvals: s.approvals,
      signal: () => s.activeRun?.abort.signal,
      state: () => ({
        toolCalls: s.activeRun?.toolCalls ?? 0,
        startedAt: s.activeRun?.startedAt ?? Date.now(),
        spendUsd: this.spend.get(s.activeRun?.id ?? "") ?? 0,
        restricted: s.restricted,
        egressContained: Boolean(this.deps.egressContained),
      }),
      onCall: () => {
        if (s.activeRun) s.activeRun.toolCalls++;
      },
      onAwaiting: (waiting) => s.activeRun?.transition(waiting ? "awaiting_approval" : "running"),
    });

    s.pi = await createInklingSession({
      config,
      runtime,
      cwd: SANDBOX_CWD,
      systemPrompt: systemPrompt(profile, [req.catalogPrompt]),
      tools,
      extensions: [extension],
    });
    this.sessions.set(s.id, s);
    return s;
  }

  private readonly spend = new Map<string, number>();

  /** Start a run, or steer the active one. Runs beyond the concurrency limit queue. */
  async send(s: Session, text: string, context?: string): Promise<{ run: Run; steered: boolean }> {
    const prompt = context ? `${text}\n\n<studio-context>\n${context}\n</studio-context>` : text;
    if (s.activeRun && !s.activeRun.done) {
      await s.pi.steer(prompt);
      return { run: s.activeRun, steered: true };
    }
    const run = new Run(s.id);
    s.runs.set(run.id, run);
    s.activeRun = run;
    void this.execute(s, run, prompt);
    return { run, steered: false };
  }

  private async slot(): Promise<() => void> {
    if (this.running >= this.deps.config.limits.maxConcurrentRuns) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    return () => {
      this.running--;
      this.queue.shift()?.();
    };
  }

  private async execute(s: Session, run: Run, prompt: string): Promise<void> {
    const release = await this.slot();
    if (run.done) return release();
    const { config } = this.deps;
    const projector = new Projector(`${config.model.provider}:${config.model.id}`);
    const stopKeepalive = this.deps.sandboxes?.keepalive(s.id) ?? (() => {});
    const deadline = setTimeout(() => {
      if (run.transition("expired")) void s.pi.abort();
    }, config.budgets.maxRunSeconds * 1000);

    let settled!: () => void;
    const settledP = new Promise<void>((r) => (settled = r));
    const unsubscribe = s.pi.subscribe((e) => {
      for (const body of projector.project(e)) run.events.push(body);
      this.spend.set(run.id, projector.spendUsd);
      if (projector.spendUsd >= config.budgets.maxSpendUsd && !run.done) {
        run.events.push({ type: "error", message: `Spend budget ($${config.budgets.maxSpendUsd}) reached; stopping.` });
        void s.pi.abort();
      }
      if (e.type === "agent_settled") settled();
    });

    run.transition("running");
    try {
      await s.pi.prompt(prompt);
      await Promise.race([settledP, new Promise((r) => setTimeout(r, 2000))]);
      run.transition(run.abort.signal.aborted ? "cancelled" : "completed");
    } catch (err) {
      if (!run.done) {
        run.events.push({ type: "error", message: sanitizeError((err as Error).message ?? String(err)) });
        run.transition(run.abort.signal.aborted ? "cancelled" : "failed");
      }
    } finally {
      clearTimeout(deadline);
      unsubscribe();
      stopKeepalive();
      s.bridge.cancelAll("run finished");
      s.approvals.rejectAll("run finished");
      this.spend.delete(run.id);
      release();
    }
  }

  async cancel(s: Session, run: Run): Promise<void> {
    if (run.done) return;
    run.abort.abort();
    s.bridge.cancelAll("cancelled");
    s.approvals.rejectAll("run cancelled");
    if (run.status === "queued") run.transition("cancelled");
    await s.pi.abort();
  }

  async delete(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.activeRun) await this.cancel(s, s.activeRun);
    s.pi.dispose();
    this.sessions.delete(id);
    if (this.deps.sandboxes) await this.deps.sandboxes.release(id, "delete").catch((e) => this.deps.log?.(`sandbox delete failed: ${(e as Error).message}`));
    return true;
  }

  info(s: Session): SessionInfo {
    const sb = this.deps.sandboxes?.peek(s.id);
    return {
      sessionId: s.id,
      projectId: s.projectId,
      profile: s.profile,
      createdAt: s.createdAt,
      ...(s.activeRun && !s.activeRun.done ? { activeRunId: s.activeRun.id } : {}),
      ...(sb ? { sandbox: { id: sb.id, state: sb.state } } : {}),
      artifacts: s.artifacts.map(({ id, name, bytes, sha256 }) => ({ id, name, bytes, sha256 })),
    };
  }
}
