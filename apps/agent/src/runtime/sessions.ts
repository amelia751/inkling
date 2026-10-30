import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daytona, Sandbox } from "@daytona/sdk";
import { type AgentSession, type ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { createStudioSession } from "../agent/factory.ts";
import { dataDir, resolveModel } from "../agent/models.ts";
import { KERNEL_SHADOWED, PROFILES, type Profile, systemPrompt } from "../agent/profiles.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type {
  ArtifactInfo,
  ClientToolSpec,
  CreateSessionRequest,
  DatasetSnapshot,
  ProfileName,
  RunStatus,
  SendMessageRequest,
  SessionInfo,
} from "../protocol.ts";
import { NAMING } from "../naming.ts";
import { type EgressPolicy, PACKAGE_INDEX_HOSTS, SANDBOX_CWD } from "../sandbox/defaults.ts";
import { type SandboxEvent, SandboxManager, type SandboxRefStore } from "../sandbox/manager.ts";
import { reclaimForQuota } from "../sandbox/sweeper.ts";
import { ClientToolBridge, ClientToolError, createClientTools } from "../tools/client.ts";
import { SeedApiDatasetSource, SessionDatasetSource, StudioSampleSource, createDatasetTools } from "../tools/dataset.ts";
import { KernelClient, PLUGIN_DIR, PLUGIN_FILE_TOOLS, createBuilderTools, createDatasetVersioningTools, createPluginSandboxTools, createTaskTools } from "../tools/kernel.ts";
import { type CallFacts, type PolicyState, policyExtension } from "../tools/policy.ts";
import { type ArtifactInfo as SandboxArtifact, createSandboxTools } from "../tools/sandbox.ts";
import { ApprovalBroker } from "./approvals.ts";
import { Projector, sanitizeError } from "./events.ts";
import { Run } from "./runs.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What survives a restart (`.data/sessions/<id>.meta.json`); the transcript is `<id>.jsonl`. */
interface SessionMeta {
  id: string;
  projectId: string;
  owner: string;
  profile: ProfileName;
  restricted: boolean;
  clientTools: ClientToolSpec[];
  catalogPrompt?: string;
  createdAt: number;
  sandboxId?: string;
  artifacts: (ArtifactInfo & { hostPath: string })[];
}

/** Everything per session lives here and in tool closures; there is no module-level mutable state. */
export class SessionContext {
  piSession!: AgentSession;
  readonly bridge: ClientToolBridge;
  readonly approvals: ApprovalBroker;
  readonly dataset: SessionDatasetSource;
  activeRun: Run | undefined;
  readonly runs = new Map<string, Run>();
  readonly policy: PolicyState;
  projector: Projector | undefined;
  persisted = 0;
  /** Kernel session token (builder / task); memory only, the Studio refreshes it per message. */
  kernelToken: string | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    readonly meta: SessionMeta,
    readonly profile: Profile,
    config: Config,
    egressContained: boolean,
  ) {
    const emit = (body: Parameters<Run["events"]["push"]>[0]) => this.activeRun?.events.push(body);
    this.bridge = new ClientToolBridge({ timeoutS: config.clientToolTimeoutS, emit: (r) => emit({ type: "client-tool", ...r }) });
    this.approvals = new ApprovalBroker({
      expiresS: config.approvalTimeoutS,
      emit: (r) => emit({ type: "approval", ...r, expiresAt: Date.now() + config.approvalTimeoutS * 1000 }),
      onResolved: (approvalId, decision) => emit({ type: "approval-resolved", approvalId, decision: decision.decision }),
    });
    this.dataset = new SessionDatasetSource(meta.projectId, new SeedApiDatasetSource(meta.projectId, config.studioUrl));
    this.policy = {
      toolCalls: 0,
      startedAt: Date.now(),
      spendUsd: 0,
      restricted: meta.restricted,
      egressContained,
      userText: "",
      workspaceId: meta.projectId,
      pathRoot: profile.kernel === "builder" ? PLUGIN_DIR : undefined,
    };
  }

  get id(): string {
    return this.meta.id;
  }

  bind(session: AgentSession, onEvent: (ctx: SessionContext, e: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]) => void): void {
    this.piSession = session;
    this.unsubscribe = session.subscribe((e) => onEvent(this, e));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.piSession?.dispose();
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      projectId: this.meta.projectId,
      profile: this.meta.profile,
      createdAt: this.meta.createdAt,
      activeRunId: this.activeRun && !this.activeRun.done ? this.activeRun.id : undefined,
      sandbox: this.meta.sandboxId ? { id: this.meta.sandboxId } : undefined,
      artifacts: this.meta.artifacts.map(({ hostPath: _h, ...a }) => a),
    };
  }
}

export interface SessionServiceDeps {
  config: Config;
  runtime: ModelRuntime;
  log: Logger;
  daytona?: Daytona;
  egress?: () => EgressPolicy;
  /** Single local principal in dev; apps/api passes the authenticated user later. */
  principal?: string;
  /** Extra tools for tests (appended to the profile's). */
  extraTools?: ToolDefinition<any, any, any>[];
}

/** FIFO slots for AGENT_MAX_CONCURRENT_RUNS; extra runs wait in `queued`. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  drop(resolve: () => void): void {
    const i = this.waiting.indexOf(resolve);
    if (i >= 0) this.waiting.splice(i, 1);
  }
}

const RUNS_KEPT = 20;

export const sessionsDir = (config: Config) => join(dataDir(config), "sessions");

export function listSessionIds(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => f.slice(0, -".meta.json".length)),
  );
}

/** Session registry, JSONL persistence and run orchestration. */
export class SessionService {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly loading = new Map<string, Promise<SessionContext>>();
  private readonly runIndex = new Map<string, SessionContext>();
  private readonly approvalIndex = new Map<string, SessionContext>();
  private readonly slots: Slots;
  readonly sandboxes: SandboxManager | undefined;
  readonly dir: string;

  constructor(private readonly deps: SessionServiceDeps) {
    this.dir = sessionsDir(deps.config);
    mkdirSync(this.dir, { recursive: true });
    this.slots = new Slots(Math.max(1, deps.config.limits.maxConcurrentRuns));
    if (deps.daytona) {
      const refs: SandboxRefStore = {
        get: (sessionId) => this.readMeta(sessionId)?.sandboxId,
        set: (sessionId, sandboxId) => {
          const ctx = this.sessions.get(sessionId);
          const meta = ctx?.meta ?? this.readMeta(sessionId);
          if (!meta) return;
          meta.sandboxId = sandboxId;
          this.writeMeta(meta);
          // The pi transcript also records which sandbox the session used (custom entry, not model context).
          ctx?.piSession?.sessionManager.appendCustomEntry("daytona-sandbox", { sandboxId: sandboxId ?? null });
          if (ctx) this.persist(ctx);
        },
      };
      const daytona = deps.daytona;
      this.sandboxes = new SandboxManager(daytona, deps.config, {
        refs,
        egress: deps.egress,
        warn: (m) => deps.log.warn(m),
        // Quota pressure: stop the oldest idle sandboxes (never ones with a run in flight).
        reclaim: () => reclaimForQuota(daytona, deps.config.env, this.activeSessionIds(), (m) => deps.log.warn(m)),
      });
    }
  }

  private get config() {
    return this.deps.config;
  }

  // ---- persistence ---------------------------------------------------------------------------

  private metaPath = (id: string) => join(this.dir, `${id}.meta.json`);
  private jsonlPath = (id: string) => join(this.dir, `${id}.jsonl`);
  artifactsDir = (id: string) => join(dataDir(this.config), "artifacts", id);

  private readMeta(id: string): SessionMeta | undefined {
    if (!/^ses_[0-9a-f-]{36}$/.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.metaPath(id), "utf8")) as SessionMeta;
    } catch {
      return undefined;
    }
  }

  private writeMeta(meta: SessionMeta): void {
    writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
  }

  /** Append entries pi added since the last call (pi keeps the tree in memory; we own the file). */
  private persist(ctx: SessionContext): void {
    const sm = ctx.piSession?.sessionManager;
    if (!sm) return;
    const entries = sm.getEntries();
    if (ctx.persisted === 0 && !existsSync(this.jsonlPath(ctx.id))) {
      const header = sm.getHeader();
      if (header) writeFileSync(this.jsonlPath(ctx.id), `${JSON.stringify(header)}\n`);
    }
    if (entries.length > ctx.persisted) {
      appendFileSync(this.jsonlPath(ctx.id), entries.slice(ctx.persisted).map((e) => `${JSON.stringify(e)}\n`).join(""));
      ctx.persisted = entries.length;
    }
  }

  /** Session ids with a record on disk (live or not); the sweeper treats the rest as orphans. */
  knownSessionIds(): Set<string> {
    return listSessionIds(this.dir);
  }

  /** Sessions with a run in flight; the sweeper never touches their sandboxes. */
  activeSessionIds(): Set<string> {
    return new Set([...this.sessions.values()].filter((s) => s.activeRun && !s.activeRun.done).map((s) => s.id));
  }

  // ---- sessions ------------------------------------------------------------------------------

  async create(req: CreateSessionRequest, owner = this.deps.principal ?? "local"): Promise<SessionContext> {
    if (this.knownSessionIds().size >= this.config.limits.maxSessions && this.sessions.size >= this.config.limits.maxSessions)
      throw new HttpError(429, `session limit (${this.config.limits.maxSessions}) reached; delete a session first`);
    const profileName = req.profile ?? "assistant";
    const profile = PROFILES[profileName];
    if (profile.sandbox === true && !this.sandboxes) throw new HttpError(409, `The ${profileName} profile needs a Daytona sandbox; DAYTONA_API_KEY is not configured.`);
    const meta: SessionMeta = {
      id: `ses_${randomUUID()}`,
      projectId: req.projectId,
      owner,
      profile: profileName,
      restricted: !!req.restricted,
      clientTools: req.clientTools ?? [],
      catalogPrompt: req.catalogPrompt,
      createdAt: Date.now(),
      artifacts: [],
    };
    const ctx = await this.build(meta, SessionManager.inMemory(SANDBOX_CWD, { id: meta.id.slice(4) })).catch((err) => {
      throw err instanceof ClientToolError ? new HttpError(400, err.message) : err;
    });
    ctx.kernelToken = req.kernelToken;
    this.writeMeta(meta);
    this.persist(ctx);
    return ctx;
  }

  /** Live session, or rebuilt from JSONL after a restart. Ownership is checked against `owner`. */
  async get(id: string, owner = this.deps.principal ?? "local"): Promise<SessionContext> {
    let ctx = this.sessions.get(id);
    if (!ctx) {
      let p = this.loading.get(id);
      if (!p) {
        p = this.restore(id).finally(() => this.loading.delete(id));
        this.loading.set(id, p);
      }
      ctx = await p;
    }
    if (ctx.meta.owner !== owner) throw new HttpError(404, "no such session");
    return ctx;
  }

  private async restore(id: string): Promise<SessionContext> {
    const meta = this.readMeta(id);
    if (!meta) throw new HttpError(404, "no such session");
    const lines = existsSync(this.jsonlPath(id)) ? readFileSync(this.jsonlPath(id), "utf8").split("\n").filter(Boolean) : [];
    const entries = lines.map((l) => JSON.parse(l) as FileEntry);
    const ctx = await this.build(meta, SessionManager.inMemory(SANDBOX_CWD, { id: id.slice(4) }, entries));
    ctx.persisted = Math.max(0, entries.length - 1);
    this.deps.log.info({ sessionId: id, entries: ctx.persisted }, "session restored");
    return ctx;
  }

  private async build(meta: SessionMeta, sessionManager: SessionManager): Promise<SessionContext> {
    const profile = PROFILES[meta.profile];
    const egress = this.deps.egress?.();
    const ctx = new SessionContext(meta, profile, this.config, !!egress?.canOverride);
    const tools: ToolDefinition<any, any, any>[] = [...createDatasetTools(ctx.dataset)];
    // Server tools win over browser tools of the same name (the kernel sees the workspace's installs).
    const clientSpecs = profile.kernel ? meta.clientTools.filter((t) => !(KERNEL_SHADOWED as readonly string[]).includes(t.name)) : meta.clientTools;
    tools.push(...createClientTools(clientSpecs, profile.clientTools, ctx.bridge));
    if (profile.kernel) {
      const kernel = new KernelClient({ baseUrl: this.config.kernelUrl, workspaceId: meta.projectId, token: () => ctx.kernelToken });
      tools.push(...(profile.kernel === "builder" ? createBuilderTools(kernel) : [...createTaskTools(kernel), ...createDatasetVersioningTools(kernel)]));
      if (profile.kernel === "builder" && this.sandboxes) tools.push(...this.pluginSandboxTools(ctx, kernel));
    }
    if (profile.sandbox === true && this.sandboxes) tools.push(...this.sandboxTools(ctx));
    tools.push(...(this.deps.extraTools ?? []));

    const session = await createStudioSession({
      config: this.config,
      runtime: this.deps.runtime,
      cwd: SANDBOX_CWD,
      systemPrompt: systemPrompt(profile, [meta.catalogPrompt]),
      tools,
      sessionManager,
      model: resolveModel(this.deps.runtime, this.config),
      extensions: [
        policyExtension({
          state: () => ctx.policy,
          budgets: this.config.budgets,
          approvals: ctx.approvals,
          signal: () => ctx.activeRun?.abort.signal,
          onCall: () => {
            ctx.policy.toolCalls++;
            if (ctx.activeRun) ctx.activeRun.toolCalls++;
          },
          onAwaiting: (waiting) => this.transition(ctx, waiting ? "awaiting_approval" : "running"),
          facts: (name, input) => this.facts(ctx, name, input),
        }),
      ],
    });
    ctx.bind(session, (c, e) => this.onPiEvent(c, e));
    this.sessions.set(meta.id, ctx);
    return ctx;
  }

  private sandboxTools(ctx: SessionContext): ToolDefinition<any, any, any>[] {
    const manager = this.sandboxes!;
    const owner = { sessionId: ctx.id, projectId: ctx.meta.projectId, owner: ctx.meta.owner, profile: ctx.meta.profile, restricted: ctx.meta.restricted };
    return createSandboxTools({
      acquire: () => manager.acquire({ ...owner, onEvent: (e) => this.onSandboxEvent(ctx, e) }),
      onUnavailable: () => {
        manager.forget(ctx.id);
        ctx.activeRun?.events.push({ type: "sandbox", state: "unavailable" });
      },
      execTimeoutS: this.config.sandbox.execTimeoutS,
      outputMax: this.config.sandbox.outputMax,
      onUncertain: (detail) => manager.quarantine(ctx.id, detail, (e) => this.onSandboxEvent(ctx, e)),
      artifactsDir: this.artifactsDir(ctx.id),
      onArtifact: (a) => this.onArtifact(ctx, a),
      samples: new StudioSampleSource(ctx.dataset, this.config.studioUrl),
      uploadLimits: this.config.upload,
    });
  }

  /**
   * Phase 9: the builder's sandbox holds one plugin's source. Labelled purpose=plugin-build, egress
   * limited to the package index where the org tier allows rules, fake credentials, and file tools
   * rooted at PLUGIN_DIR (policy denies paths outside it). No bash or run_python.
   */
  private pluginSandboxTools(ctx: SessionContext, kernel: KernelClient): ToolDefinition<any, any, any>[] {
    const manager = this.sandboxes!;
    const owner = {
      sessionId: ctx.id,
      projectId: ctx.meta.projectId,
      owner: ctx.meta.owner,
      profile: ctx.meta.profile,
      restricted: ctx.meta.restricted,
      labels: { purpose: "plugin-build" },
      egressAllow: PACKAGE_INDEX_HOSTS,
      envVars: { [`${NAMING.envPrefix}KERNEL_TOKEN`]: "fake-kernel-token", [`${NAMING.envPrefix}SECRET_USE_TOKEN`]: "fake-secret-token" },
    };
    const acquire = () => manager.acquire({ ...owner, onEvent: (e) => this.onSandboxEvent(ctx, e) });
    const files = createSandboxTools({
      acquire,
      cwd: PLUGIN_DIR,
      onUnavailable: () => manager.forget(ctx.id),
      execTimeoutS: this.config.sandbox.execTimeoutS,
      outputMax: this.config.sandbox.outputMax,
      artifactsDir: this.artifactsDir(ctx.id),
    }).filter((t) => (PLUGIN_FILE_TOOLS as readonly string[]).includes(t.name));
    return [...createPluginSandboxTools(kernel, { acquire, execTimeoutS: this.config.sandbox.execTimeoutS }), ...files];
  }

  private async facts(ctx: SessionContext, toolName: string, input: Record<string, unknown>): Promise<CallFacts> {
    if (toolName !== "export_artifact" || typeof input.path !== "string") return {};
    const sb: Sandbox | undefined = this.sandboxes?.peek(ctx.id);
    if (!sb) return {};
    const abs = input.path.startsWith("/") ? input.path : `${SANDBOX_CWD}/${input.path}`;
    const info = await sb.fs.getFileDetails(abs);
    return { bytes: info.size };
  }

  private onSandboxEvent(ctx: SessionContext, e: SandboxEvent): void {
    this.deps.log.info({ sessionId: ctx.id, sandboxId: "sandboxId" in e ? e.sandboxId : undefined, state: e.state }, "sandbox");
    ctx.activeRun?.events.push({ type: "sandbox", state: e.state, ...("sandboxId" in e ? { sandboxId: e.sandboxId } : {}) });
  }

  private onArtifact(ctx: SessionContext, a: SandboxArtifact): void {
    const info = { id: a.id, name: a.name, bytes: a.bytes, sha256: a.sha256, createdAt: a.createdAt };
    ctx.meta.artifacts.push({ ...info, hostPath: a.hostPath });
    this.writeMeta(ctx.meta);
    ctx.activeRun?.events.push({ type: "artifact", ...info });
  }

  artifact(ctx: SessionContext, artifactId: string) {
    return ctx.meta.artifacts.find((a) => a.id === artifactId);
  }

  /** Find the session that owns an artifact (download route), checking ownership. */
  async findArtifact(artifactId: string, owner = this.deps.principal ?? "local") {
    for (const id of this.knownSessionIds()) {
      const meta = this.sessions.get(id)?.meta ?? this.readMeta(id);
      const a = meta?.owner === owner ? meta.artifacts.find((x) => x.id === artifactId) : undefined;
      if (a) return a;
    }
    return undefined;
  }

  async delete(id: string, owner?: string): Promise<void> {
    const ctx = await this.get(id, owner);
    if (ctx.activeRun && !ctx.activeRun.done) await this.cancel(ctx.activeRun.id, owner);
    ctx.dispose();
    this.sessions.delete(id);
    for (const [runId, c] of this.runIndex) if (c === ctx) this.runIndex.delete(runId);
    if (this.sandboxes && ctx.meta.sandboxId) {
      await this.sandboxes.release(id, "delete").catch((err) => this.deps.log.error({ sessionId: id, err: sanitizeError(String(err)) }, "sandbox delete failed"));
    }
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.jsonlPath(id), { force: true });
    rmSync(this.artifactsDir(id), { recursive: true, force: true });
    this.deps.log.info({ sessionId: id }, "session deleted");
  }

  // ---- runs ----------------------------------------------------------------------------------

  async send(ctx: SessionContext, req: SendMessageRequest): Promise<{ run: Run; steered: boolean }> {
    if (req.kernelToken) ctx.kernelToken = req.kernelToken;
    if (req.snapshot) {
      try {
        ctx.dataset.update(req.snapshot as DatasetSnapshot);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    const text = req.context?.trim() ? `<studio_context>\n${req.context.trim()}\n</studio_context>\n\n${req.text}` : req.text;
    const active = ctx.activeRun;
    if (active && !active.done) {
      ctx.policy.userText += `\n${req.text}`;
      if (active.status === "queued") active.pending.push(text);
      else await ctx.piSession.steer(text);
      return { run: active, steered: true };
    }
    const run = new Run(ctx.id);
    run.pending.push(text);
    // Only the user's own words this run can authorise plugin changes (policy INTENT_GATED).
    ctx.policy.userText = req.text;
    ctx.activeRun = run;
    ctx.runs.set(run.id, run);
    this.runIndex.set(run.id, ctx);
    for (const old of [...ctx.runs.keys()].slice(0, -RUNS_KEPT)) {
      ctx.runs.delete(old);
      this.runIndex.delete(old);
    }
    run.events.push({ type: "run-status", status: "queued" });
    void this.execute(ctx, run);
    return { run, steered: false };
  }

  private async execute(ctx: SessionContext, run: Run): Promise<void> {
    let release: (() => void) | undefined;
    const slot = this.slots.acquire().then(() => {
      release = () => this.slots.release();
    });
    const onCancel = () => run.abort.signal.aborted;
    await Promise.race([slot, new Promise<void>((r) => run.abort.signal.addEventListener("abort", () => r(), { once: true }))]);
    if (onCancel()) {
      // Cancelled while queued: give back the slot if it arrived anyway.
      void slot.then(() => release?.());
      this.transition(ctx, run.endReason === "expired" ? "expired" : "cancelled", run);
      return;
    }

    const log = this.deps.log.child({ sessionId: ctx.id, runId: run.id });
    this.transition(ctx, "running", run);
    ctx.policy.toolCalls = 0;
    ctx.policy.spendUsd = 0;
    ctx.policy.startedAt = Date.now();
    ctx.projector = new Projector(`${this.config.model.provider}:${this.config.model.id}`, toolTitles(ctx));
    const stopKeepalive = ctx.profile.sandbox ? this.sandboxes?.keepalive(ctx.id) : undefined;
    const timer = setTimeout(() => this.abortRun(ctx, run, "expired"), this.config.budgets.maxRunSeconds * 1000);
    timer.unref();
    log.info({ profile: ctx.meta.profile }, "run started");

    try {
      const text = run.pending.splice(0).join("\n\n");
      await ctx.piSession.prompt(text);
      await ctx.piSession.waitForIdle();
      if (run.endReason) this.transition(ctx, run.endReason === "budget" ? "failed" : run.endReason, run);
      else this.transition(ctx, run.failed ? "failed" : "completed", run);
    } catch (err) {
      if (run.endReason) this.transition(ctx, run.endReason === "budget" ? "failed" : run.endReason, run);
      else {
        log.error({ err: sanitizeError(String(err)) }, "run failed");
        run.events.push({ type: "error", message: sanitizeError(err instanceof Error ? err.message : String(err)) });
        this.transition(ctx, "failed", run);
      }
    } finally {
      clearTimeout(timer);
      stopKeepalive?.();
      ctx.bridge.cancelAll("run ended");
      ctx.approvals.rejectAll("run ended");
      this.persist(ctx);
      release?.();
      log.info(
        {
          status: run.status,
          model: `${this.config.model.provider}:${this.config.model.id}`,
          ...run.usage,
          toolCalls: run.toolCalls,
          approvals: run.approvals,
          seconds: Math.round((Date.now() - run.startedAt) / 1000),
          ...sandboxUsage(this.sandboxes?.peek(ctx.id)),
        },
        "run finished",
      );
    }
  }

  private abortRun(ctx: SessionContext, run: Run, reason: "cancelled" | "expired" | "budget", message?: string): void {
    if (run.done || run.endReason) return;
    run.endReason = reason;
    if (message) run.events.push({ type: "error", message });
    if (reason === "expired") run.events.push({ type: "error", message: `Stopped: the run exceeded ${this.config.budgets.maxRunSeconds}s.` });
    run.abort.abort();
    ctx.bridge.cancelAll(reason);
    ctx.approvals.rejectAll(reason);
    if (run.status !== "queued") void ctx.piSession.abort().catch(() => {});
  }

  async cancel(runId: string, owner?: string): Promise<Run> {
    const ctx = this.runIndex.get(runId);
    if (!ctx || ctx.meta.owner !== (owner ?? this.deps.principal ?? "local")) throw new HttpError(404, "no such run");
    const run = ctx.runs.get(runId)!;
    this.abortRun(ctx, run, "cancelled");
    return run;
  }

  findRun(runId: string, owner = this.deps.principal ?? "local"): { ctx: SessionContext; run: Run } {
    const ctx = this.runIndex.get(runId);
    const run = ctx?.runs.get(runId);
    if (!ctx || !run || ctx.meta.owner !== owner) throw new HttpError(404, "no such run");
    return { ctx, run };
  }

  answerClientTool(runId: string, callId: string, result: { ok: boolean; output: unknown }, owner?: string): boolean {
    const { ctx } = this.findRun(runId, owner);
    return ctx.bridge.answer(callId, result);
  }

  decideApproval(approvalId: string, decision: { decision: "approve" | "reject"; note?: string }, owner?: string): boolean {
    for (const ctx of this.sessions.values()) {
      if (!ctx.approvals.has(approvalId)) continue;
      if (ctx.meta.owner !== (owner ?? this.deps.principal ?? "local")) return false;
      if (ctx.activeRun) ctx.activeRun.approvals++;
      return ctx.approvals.decide(approvalId, decision);
    }
    return false;
  }

  private transition(ctx: SessionContext, to: RunStatus, run = ctx.activeRun): void {
    if (!run || !run.transition(to)) return;
    if (!run.done) run.events.push({ type: "run-status", status: to });
  }

  private onPiEvent(ctx: SessionContext, e: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void {
    const run = ctx.activeRun;
    if (e.type === "message_end" || e.type === "agent_settled") this.persist(ctx);
    if (!run || run.done || !ctx.projector) return;
    if (e.type === "tool_execution_end")
      this.deps.log.info(
        { sessionId: ctx.id, runId: run.id, toolCallId: e.toolCallId, tool: e.toolName, ok: !e.isError, ms: e.durationMs, sandboxId: this.sandboxes?.peek(ctx.id)?.id },
        "tool call",
      );
    for (const body of ctx.projector.project(e)) {
      if (body.type === "usage") {
        run.usage.inputTokens += body.inputTokens;
        run.usage.outputTokens += body.outputTokens;
        run.usage.cachedTokens += body.cachedTokens;
        run.usage.costUsd += body.costUsd;
      }
      if (body.type === "error") run.failed = true;
      run.events.push(body);
    }
    ctx.policy.spendUsd = ctx.projector.spendUsd;
    if (e.type === "message_end" && ctx.projector.spendUsd >= this.config.budgets.maxSpendUsd)
      this.abortRun(ctx, run, "budget", `Stopped: this run reached the $${this.config.budgets.maxSpendUsd.toFixed(2)} spend limit.`);
  }

  /** Stop live sandboxes on shutdown (disk kept; reattached lazily next time). */
  async shutdown(): Promise<void> {
    for (const ctx of this.sessions.values()) {
      if (ctx.activeRun && !ctx.activeRun.done) this.abortRun(ctx, ctx.activeRun, "cancelled");
      if (this.sandboxes?.peek(ctx.id)) await this.sandboxes.release(ctx.id, "stop").catch(() => {});
      this.persist(ctx);
      ctx.dispose();
    }
  }
}

/** Sandbox lifetime so far (Daytona's createdAt → lastActivityAt), for the per-run usage record. */
function sandboxUsage(sb: Sandbox | undefined): { sandboxId?: string; sandboxSeconds?: number } {
  if (!sb) return {};
  const from = Date.parse(sb.createdAt ?? "");
  const to = Date.parse(sb.lastActivityAt ?? "") || Date.now();
  return { sandboxId: sb.id, sandboxSeconds: Number.isFinite(from) ? Math.max(0, Math.round((to - from) / 1000)) : undefined };
}

/** Tool row titles: the tool's own label (dataset, sandbox) or the browser's name for client tools. */
function toolTitles(ctx: SessionContext): Map<string, string> {
  const titles = new Map<string, string>();
  for (const t of ctx.piSession.getAllTools()) {
    const label = ctx.piSession.getToolDefinition(t.name)?.label;
    if (label) titles.set(t.name, label);
  }
  return titles;
}
