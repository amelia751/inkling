import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Daytona, Sandbox } from "@daytona/sdk";
import { type AgentSession, type ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { createStudioSession } from "../agent/factory.ts";
import type { RunEventBus } from "../bus/types.ts";
import { MemoryRunEventBus } from "../bus/memory.ts";
import { INTERRUPTED_MESSAGE, RunCoordinator, type RunView, isActiveStatus, wireStatus } from "../cluster/coordinator.ts";
import { fileStore } from "../store/index.ts";
import type { SessionStore, StoredMeta } from "../store/types.ts";
import { dataDir, resolveModel } from "../agent/models.ts";
import { KERNEL_SHADOWED, PROFILES, type Profile, systemPrompt } from "../agent/profiles.ts";
import { type StudioCatalog, loadStudioCatalog } from "../agent/catalog.ts";
import { StudioClient, isCreationIntent } from "@studio/studio-tools";
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
} from "@studio/agent-protocol";
import { NAMING } from "../naming.ts";
import { type EgressPolicy, SANDBOX_CWD } from "../sandbox/defaults.ts";
import { DaytonaProvider, type SandboxProvider } from "../sandbox/provider.ts";
import { type SandboxEvent, SandboxManager, type SandboxRefStore } from "../sandbox/manager.ts";
import { reclaimForQuota } from "../sandbox/sweeper.ts";
import { ClientToolBridge, ClientToolError, createClientTools } from "../tools/client.ts";
import { SeedApiDatasetSource, SessionDatasetSource, createDatasetTools } from "../tools/dataset.ts";
import { createBoundaryTools } from "../tools/boundary.ts";
import { createProjectTools } from "../tools/project.ts";
import { createDropTools, dropBlock, dropPart, fetchDropSummary } from "../tools/drops.ts";
import { createStudioTools } from "../tools/studio.ts";
import { KernelClient, PLUGIN_DIR, PLUGIN_FILE_TOOLS, packTarball, createBuilderTools, createDatasetVersioningTools, createPluginSandboxTools, createTaskTools } from "../tools/kernel.ts";
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

/** One row of `GET /v1/sessions`. */
export interface SessionSummary {
  id: string;
  projectId: string;
  profile: ProfileName;
  createdAt: number;
}

/** What survives a restart (`.data/sessions/<id>.meta.json`); the transcript is `<id>.jsonl`. */
interface SessionMeta {
  id: string;
  projectId: string;
  owner: string;
  /** The caller's organization when the session was created (WorkOS `org_id`); unset in dev mode. */
  orgId?: string;
  profile: ProfileName;
  restricted: boolean;
  clientTools: ClientToolSpec[];
  /** Legacy: sessions stored before todo11 may carry the browser's catalogue; it is never injected. */
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
  /** Set by SessionService: records approvals/client-tool calls (cluster/coordinator.ts) before emitting. */
  emitHook: ((body: Parameters<Run["events"]["push"]>[0]) => void) | undefined;
  onClientToolSettled: ((callId: string) => void) | undefined;
  /** Kernel session token (builder / task); memory only, the Studio refreshes it per message. */
  kernelToken: string | undefined;
  /** The kernel client the project tools use (set in build), also for reading a message's drop. */
  kernel: KernelClient | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    readonly meta: SessionMeta,
    readonly profile: Profile,
    config: Config,
    egressContained: boolean,
  ) {
    const emit = (body: Parameters<Run["events"]["push"]>[0]) => (this.emitHook ? this.emitHook(body) : this.activeRun?.events.push(body));
    this.bridge = new ClientToolBridge({
      timeoutS: config.clientToolTimeoutS,
      emit: (r) => emit({ type: "client-tool", ...r }),
      onSettled: (callId) => this.onClientToolSettled?.(callId),
    });
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
  /** Where sandboxes come from (AGENT_SANDBOX); defaults to Daytona when `daytona` is given. */
  provider?: SandboxProvider;
  egress?: () => EgressPolicy;
  /** Single local principal in dev mode; in `workos` mode the app passes the verified user per call. */
  principal?: string;
  /** Extra tools for tests (appended to the profile's). */
  extraTools?: ToolDefinition<any, any, any>[];
  /** fetch for the Studio tools' API client (tests); the global one otherwise. */
  fetchImpl?: typeof fetch;
  /** Durable state (store/); defaults to the dev file store under the data dir. */
  store?: SessionStore;
  /** Catalogue + intent table for the Studio tools; defaults to the files config names, read once here. */
  studio?: StudioCatalog;
  /** Run event fan-out (bus/); defaults to in-process. */
  bus?: RunEventBus;
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
  readonly store: SessionStore;
  readonly cluster: RunCoordinator;
  /** Read once at startup (agent/catalog.ts): static per deployment, never request state. */
  readonly studio: StudioCatalog;

  constructor(private readonly deps: SessionServiceDeps) {
    this.studio = deps.studio ?? loadStudioCatalog(deps.config);
    this.dir = sessionsDir(deps.config);
    mkdirSync(this.dir, { recursive: true });
    this.store = deps.store ?? fileStore(deps.config);
    this.cluster = new RunCoordinator({
      store: this.store,
      bus: deps.bus ?? new MemoryRunEventBus(),
      config: deps.config,
      log: deps.log,
      abort: (ctx, run) => this.abortRun(ctx, run, "cancelled"),
    });
    this.slots = new Slots(Math.max(1, deps.config.limits.maxConcurrentRuns));
    const provider = deps.provider ?? (deps.daytona ? new DaytonaProvider(deps.daytona, { snapshot: deps.config.sandbox.snapshot, canBlock: () => deps.egress?.().canOverride ?? false }) : undefined);
    if (provider) {
      const refs: SandboxRefStore = {
        // Sandboxes are only acquired for live sessions, whose meta is in memory.
        get: (sessionId) => this.sessions.get(sessionId)?.meta.sandboxId,
        set: (sessionId, sandboxId) => {
          const ctx = this.sessions.get(sessionId);
          const meta = ctx?.meta;
          if (!meta) return;
          meta.sandboxId = sandboxId;
          this.writeMeta(meta);
          // The pi transcript also records which sandbox the session used (custom entry, not model context).
          ctx?.piSession?.sessionManager.appendCustomEntry("daytona-sandbox", { sandboxId: sandboxId ?? null });
          if (ctx) this.persist(ctx);
        },
      };
      const daytona = provider.kind === "daytona" ? (provider as DaytonaProvider).daytona : undefined;
      this.sandboxes = new SandboxManager(provider, deps.config, {
        refs,
        egress: deps.egress,
        warn: (m) => deps.log.warn(m),
        // Quota pressure (Daytona): stop the oldest idle sandboxes (never ones with a run in flight).
        reclaim: daytona ? () => reclaimForQuota(daytona, deps.config.env, this.activeSessionIds(), (m) => deps.log.warn(m)) : undefined,
      });
    }
  }

  private get config() {
    return this.deps.config;
  }

  // ---- persistence ---------------------------------------------------------------------------

  artifactsDir = (id: string) => join(dataDir(this.config), "artifacts", id);

  private async readMeta(id: string): Promise<SessionMeta | undefined> {
    return (await this.store.getMeta(id)) as SessionMeta | undefined;
  }

  private writeMeta(meta: SessionMeta): void {
    this.cluster.persistMeta(meta as unknown as StoredMeta);
  }

  /** Append entries pi added since the last call (pi keeps the tree in memory; the store owns the copy). */
  private persist(ctx: SessionContext): void {
    const sm = ctx.piSession?.sessionManager;
    if (!sm) return;
    const entries = sm.getEntries();
    if (entries.length > ctx.persisted) {
      // Position 0 is the header (written at create), so entry i lives at i + 1.
      this.cluster.persistTranscript(ctx.id, ctx.persisted + 1, entries.slice(ctx.persisted));
      ctx.persisted = entries.length;
    }
  }

  /** Session ids with a stored record (live or not); the sweeper treats the rest as orphans. */
  knownSessionIds(): Promise<Set<string>> {
    return this.store.listSessionIds();
  }

  /** Sessions with a run in flight; the sweeper never touches their sandboxes. */
  activeSessionIds(): Set<string> {
    return new Set([...this.sessions.values()].filter((s) => s.activeRun && !s.activeRun.done).map((s) => s.id));
  }

  // ---- sessions ------------------------------------------------------------------------------

  async create(req: CreateSessionRequest, owner = this.deps.principal ?? "local", orgId?: string): Promise<SessionContext> {
    if ((await this.store.countSessions()) >= this.config.limits.maxSessions && this.sessions.size >= this.config.limits.maxSessions)
      throw new HttpError(429, `session limit (${this.config.limits.maxSessions}) reached; delete a session first`);
    const profileName = req.profile ?? "assistant";
    const profile = PROFILES[profileName];
    if (profile.sandbox === true && !this.sandboxes) throw new HttpError(409, `The ${profileName} profile needs a Daytona sandbox; DAYTONA_API_KEY is not configured.`);
    const meta: SessionMeta = {
      id: `ses_${randomUUID()}`,
      projectId: req.projectId,
      owner,
      ...(orgId ? { orgId } : {}),
      profile: profileName,
      restricted: !!req.restricted,
      clientTools: req.clientTools ?? [],
      createdAt: Date.now(),
      artifacts: [],
    };
    // Accepted for compatibility, no longer injected (todo11): the compact preset index plus
    // search_catalog replace the ~30 KB catalogue the browser sends.
    if (req.catalogPrompt) this.deps.log.debug({ chars: req.catalogPrompt.length, profile: profileName }, "catalogPrompt ignored (compact preset index + search_catalog)");
    const ctx = await this.build(meta, SessionManager.inMemory(SANDBOX_CWD, { id: meta.id.slice(4) })).catch((err) => {
      throw err instanceof ClientToolError ? new HttpError(400, err.message) : err;
    });
    ctx.kernelToken = req.kernelToken;
    const sm = ctx.piSession.sessionManager;
    await this.cluster.createSession(meta as unknown as StoredMeta, [sm.getHeader(), ...sm.getEntries()].filter(Boolean));
    ctx.persisted = sm.getEntries().length;
    return ctx;
  }

  /**
   * Live session, or rebuilt from JSONL after a restart. Ownership is checked against `owner`, and
   * against `orgId` when one is given (a session from another organization is a 404).
   */
  async get(id: string, owner = this.deps.principal ?? "local", orgId?: string): Promise<SessionContext> {
    let ctx = this.sessions.get(id);
    // Another replica ran a turn (or deleted the session) since this one loaded it: rebuild.
    if (ctx && !this.loading.has(id) && !(await this.cluster.isFresh(ctx))) {
      this.evict(ctx);
      ctx = this.sessions.get(id);
    }
    if (!ctx) {
      let p = this.loading.get(id);
      if (!p) {
        p = this.restore(id).finally(() => this.loading.delete(id));
        this.loading.set(id, p);
      }
      ctx = await p;
    }
    if (ctx.meta.owner !== owner || (orgId !== undefined && ctx.meta.orgId !== orgId)) throw new HttpError(404, "no such session");
    return ctx;
  }

  private async restore(id: string): Promise<SessionContext> {
    await this.cluster.noteLoading(id);
    const meta = await this.readMeta(id);
    if (!meta) throw new HttpError(404, "no such session");
    const entries = (await this.store.readTranscript(id)) as FileEntry[];
    const ctx = await this.build(meta, SessionManager.inMemory(SANDBOX_CWD, { id: id.slice(4) }, entries));
    ctx.persisted = Math.max(0, entries.length - 1);
    this.deps.log.info({ sessionId: id, entries: ctx.persisted }, "session restored");
    return ctx;
  }

  private async build(meta: SessionMeta, sessionManager: SessionManager): Promise<SessionContext> {
    const profile = PROFILES[meta.profile];
    const egress = this.deps.egress?.();
    const ctx = new SessionContext(meta, profile, this.config, !!egress?.canOverride);
    // Tool order is fixed so the declared tool list is byte-identical across sessions of a profile
    // (prompt caching, todo11): dataset, browser tools (sorted by name), project, Studio, kernel,
    // sandbox, then test extras. Each group's own order is fixed in its module.
    const tools: ToolDefinition<any, any, any>[] = [...createDatasetTools(ctx.dataset)];
    // Server tools win over browser tools of the same name (the kernel sees the workspace's installs).
    const clientSpecs = (profile.kernel ? meta.clientTools.filter((t) => !(KERNEL_SHADOWED as readonly string[]).includes(t.name)) : meta.clientTools)
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    tools.push(...createClientTools(clientSpecs, profile.clientTools, ctx.bridge));
    // Project tools for every profile (todo6 Phase 6): reads plus proposals, with the session's kernel token.
    const kernel = new KernelClient({
      baseUrl: this.config.kernelUrl,
      workspaceId: meta.projectId,
      token: () => ctx.kernelToken,
      headers: (): Record<string, string> => (ctx.activeRun ? { "X-Agent-Run": ctx.activeRun.id } : {}),
      fetchImpl: this.deps.fetchImpl,
    });
    ctx.kernel = kernel;
    tools.push(...createProjectTools(kernel));
    // todo13: files dropped in the chat (screened names and facts only).
    tools.push(...createDropTools(kernel));
    if (profile.studio) {
      ctx.policy.creationIntent = (text) => isCreationIntent(text, this.studio.intents);
      // Studio tools (todo11): the API's boot and environment routes with the same token and headers.
      const studioClient = new StudioClient({
        baseUrl: this.config.kernelUrl,
        token: () => ctx.kernelToken,
        headers: (): Record<string, string> => ({ "X-Workspace-Id": meta.projectId, ...(ctx.activeRun ? { "X-Agent-Run": ctx.activeRun.id } : {}) }),
        fetch: this.deps.fetchImpl,
      });
      tools.push(...createStudioTools({ client: studioClient, studio: this.studio, projectId: meta.projectId, runId: () => ctx.activeRun?.id }));
    }
    if (profile.kernel) {
      tools.push(...(profile.kernel === "builder" ? createBuilderTools(kernel) : [...createTaskTools(kernel), ...createDatasetVersioningTools(kernel)]));
      if (profile.kernel === "builder" && this.sandboxes) tools.push(...this.pluginSandboxTools(ctx, kernel));
      // Without a sandbox the builder can still read fingerprints and probe (todo10 Phase 7).
      else if (profile.kernel === "builder") tools.push(...createBoundaryTools(kernel, { sourceDir: PLUGIN_DIR }).filter((t) => t.name === "get_fingerprint" || t.name === "probe_sample"));
    }
    if (profile.sandbox === true && this.sandboxes) {
      tools.push(...this.sandboxTools(ctx));
      // The coder's way to data: a fingerprint and synthetic fixtures in its work dir, never the sample.
      const manager = this.sandboxes;
      const owner = { sessionId: ctx.id, projectId: meta.projectId, owner: meta.owner, profile: meta.profile, restricted: meta.restricted };
      const acquire = () => manager.acquire({ ...owner, onEvent: (e) => this.onSandboxEvent(ctx, e) });
      tools.push(...createBoundaryTools(kernel, { acquire, sourceDir: SANDBOX_CWD }).filter((t) => t.name === "get_fingerprint" || t.name === "get_fixtures"));
    }
    tools.push(...(this.deps.extraTools ?? []));

    const session = await createStudioSession({
      config: this.config,
      runtime: this.deps.runtime,
      cwd: SANDBOX_CWD,
      systemPrompt: systemPrompt(profile, { studioIndex: this.studio.index }),
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
    ctx.emitHook = (body) => this.cluster.emit(ctx, body);
    ctx.onClientToolSettled = (callId) => this.cluster.clientToolSettled(ctx, callId);
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
    });
  }

  /**
   * Phase 9: the builder's sandbox holds one plugin's source. Labelled purpose=plugin-build, no
   * network on any provider (todo10 Phase 7), no credentials or env from us, a short life, file tools
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
    // todo10 Phase 7: fixtures in, source out; the real sample stays in our worker.
    const boundary = createBoundaryTools(kernel, { acquire, sourceDir: PLUGIN_DIR, pack: (sb) => packTarball(sb, this.config.sandbox.execTimeoutS) });
    return [...createPluginSandboxTools(kernel, { acquire, execTimeoutS: this.config.sandbox.execTimeoutS }), ...boundary, ...files];
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
    for (const id of await this.knownSessionIds()) {
      const meta = this.sessions.get(id)?.meta ?? (await this.readMeta(id));
      const a = meta?.owner === owner ? meta.artifacts.find((x) => x.id === artifactId) : undefined;
      if (a) return a;
    }
    return undefined;
  }

  /** The owner's sessions in one organization (none = dev mode's org-less sessions), newest first. */
  async list(owner = this.deps.principal ?? "local", orgId?: string, projectId?: string): Promise<SessionSummary[]> {
    const metas = await this.store.listSessions({ owner, orgId, projectId });
    return metas
      .map((m) => ({ id: m.id, projectId: m.projectId, profile: m.profile as ProfileName, createdAt: Number(m.createdAt) || 0 }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(id: string, owner?: string, orgId?: string): Promise<void> {
    const ctx = await this.get(id, owner, orgId);
    await this.remove(id, ctx.meta, ctx);
  }

  /**
   * todo14 D9: delete every conversation in an organization (the org is being deleted), or only
   * `owner`'s there (they were removed from it). Each goes the same way as a single delete (active
   * run cancelled, sandbox released, rows, artifacts and run-event streams gone) without rebuilding
   * sessions that aren't loaded. Returns how many were deleted.
   */
  async deleteForOrg(orgId: string, owner?: string): Promise<number> {
    let deleted = 0;
    for (const meta of await this.store.listOrgSessions({ orgId, owner })) {
      if (meta.orgId !== orgId || (owner !== undefined && meta.owner !== owner)) continue;
      await this.remove(meta.id, meta as unknown as SessionMeta, this.sessions.get(meta.id));
      deleted++;
    }
    this.deps.log.info({ orgId, owner, deleted }, owner ? "member conversations deleted" : "organization conversations deleted");
    return deleted;
  }

  /** Cancel the session's active run (here or on another replica), then delete everything it left. */
  private async remove(id: string, meta: SessionMeta, ctx: SessionContext | undefined): Promise<void> {
    if (ctx?.activeRun && !ctx.activeRun.done) {
      this.abortRun(ctx, ctx.activeRun, "cancelled");
      // Let the loop write its terminal record and last events before they're deleted.
      await this.cluster.waitForSessionRuns(id, Date.now() + 5000);
    } else {
      // A run on another replica: the cancel command is best-effort (the delete below removes it);
      // that replica's heartbeat then finds the run gone and stops the loop.
      const remote = await this.cluster.activeElsewhere(id);
      if (remote) await this.cluster.cancel(remote);
    }
    if (ctx) {
      ctx.dispose();
      if (this.sessions.get(id) === ctx) this.sessions.delete(id);
      for (const [runId, c] of this.runIndex) if (c === ctx) this.runIndex.delete(runId);
    }
    if (this.sandboxes && meta.sandboxId) {
      await this.sandboxes.release(id, "delete").catch((err) => this.deps.log.error({ sessionId: id, err: sanitizeError(String(err)) }, "sandbox delete failed"));
    }
    const runIds = await this.store.runIdsForSessions([id]);
    await this.cluster.deleteSession(id);
    await this.cluster.bus.deleteRuns(runIds);
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
    // todo13 D3: a drop is read from the kernel as the agent (screened names, technical facts),
    // never from the browser; the model gets that summary, never bytes, names or links.
    const drop = req.drop ? await this.readDrop(ctx, req.drop.dropId) : undefined;
    const userText = [drop?.block, req.text].filter(Boolean).join("\n\n");
    const text = req.context?.trim() ? `<studio_context>\n${req.context.trim()}\n</studio_context>\n\n${userText}` : userText;
    const active = ctx.activeRun;
    if (active && !active.done) {
      ctx.policy.userText += `\n${req.text}`;
      if (drop?.part) active.events.push({ type: "custom", name: "drop", value: drop.part });
      if (active.status === "queued") active.pending.push(text);
      else await ctx.piSession.steer(text);
      return { run: active, steered: true };
    }
    // The session's run may be live on another replica: steer into it there.
    const elsewhere = await this.cluster.activeElsewhere(ctx.id);
    if (elsewhere) {
      await this.cluster.steer(elsewhere, text, req.snapshot as DatasetSnapshot | undefined);
      return { run: { id: elsewhere.id } as Run, steered: true };
    }
    if (this.cluster.draining) throw new HttpError(503, "the agent service is restarting; retry in a moment");
    const run = new Run(ctx.id, { principal: ctx.meta.owner, orgId: ctx.meta.orgId });
    run.pending.push(text);
    const taken = await this.cluster.startRun(ctx, run);
    if (taken) {
      // Lost a race for the session's run slot: steer into the winner.
      await this.cluster.steer(taken, text, req.snapshot as DatasetSnapshot | undefined);
      return { run: { id: taken.id } as Run, steered: true };
    }
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
    if (drop?.part) run.events.push({ type: "custom", name: "drop", value: drop.part });
    void this.execute(ctx, run);
    return { run, steered: false };
  }

  /** The drop on a message, as the model will read it, and the part the browser renders. */
  private async readDrop(ctx: SessionContext, dropId: string) {
    if (!ctx.kernel) return { block: dropBlock(undefined, dropId, "no kernel access"), part: undefined };
    try {
      const summary = await fetchDropSummary(ctx.kernel, dropId);
      return { block: dropBlock(summary, dropId), part: dropPart(summary) };
    } catch (err) {
      this.deps.log.warn({ sessionId: ctx.id, dropId, err: sanitizeError(String(err)) }, "drop not readable");
      return { block: dropBlock(undefined, dropId, "the drop couldn't be read yet; try get_drop"), part: undefined };
    }
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

    const log = this.deps.log.child({ sessionId: ctx.id, runId: run.id, principal: run.principal, orgId: run.orgId });
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

  async cancel(runId: string, owner?: string): Promise<{ id: string; status: string }> {
    const ctx = this.runIndex.get(runId);
    if (!ctx) {
      // Not running here: ask the replica that runs it.
      const rec = await this.cluster.getRun(runId, owner ?? this.deps.principal ?? "local");
      if (!rec) throw new HttpError(404, "no such run");
      if (isActiveStatus(rec.status)) await this.cluster.cancel(rec);
      return { id: rec.id, status: wireStatus(rec.status) };
    }
    if (ctx.meta.owner !== (owner ?? this.deps.principal ?? "local")) throw new HttpError(404, "no such run");
    const run = ctx.runs.get(runId)!;
    this.abortRun(ctx, run, "cancelled");
    return run;
  }

  /** A run on any replica, for the event stream: local first, then the store. */
  async lookupRun(runId: string, owner = this.deps.principal ?? "local"): Promise<RunView> {
    const ctx = this.runIndex.get(runId);
    const run = ctx?.runs.get(runId);
    if (ctx && run) {
      if (ctx.meta.owner !== owner) throw new HttpError(404, "no such run");
      return { id: run.id, sessionId: ctx.id, status: run.status, local: true };
    }
    const rec = await this.cluster.getRun(runId, owner);
    if (!rec) throw new HttpError(404, "no such run");
    return { id: rec.id, sessionId: rec.sessionId, status: rec.status, local: false };
  }

  /** Session info, with the active run even when its loop is on another replica. */
  async describe(ctx: SessionContext): Promise<SessionInfo> {
    const info = ctx.info();
    if (!info.activeRunId) info.activeRunId = (await this.cluster.activeElsewhere(ctx.id))?.id;
    return info;
  }

  findRun(runId: string, owner = this.deps.principal ?? "local"): { ctx: SessionContext; run: Run } {
    const ctx = this.runIndex.get(runId);
    const run = ctx?.runs.get(runId);
    if (!ctx || !run || ctx.meta.owner !== owner) throw new HttpError(404, "no such run");
    return { ctx, run };
  }

  /** Stored as a run input, so the POST may land on any replica; the loop's replica picks it up. */
  async answerClientTool(runId: string, callId: string, result: { ok: boolean; output: unknown }, owner?: string): Promise<boolean> {
    await this.lookupRun(runId, owner);
    return this.cluster.answerClientTool(runId, callId, result, owner ?? this.deps.principal ?? "local");
  }

  decideApproval(approvalId: string, decision: { decision: "approve" | "reject"; note?: string }, owner?: string): Promise<boolean> {
    return this.cluster.decideApproval(approvalId, decision, owner ?? this.deps.principal ?? "local");
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
    await Promise.all([...this.sessions.keys()].map((id) => this.cluster.flush(id)));
    this.cluster.stop();
  }

  /**
   * SIGTERM (todo/done/todo3.md E.1): refuse new runs, give local runs until `graceMs` to finish, then
   * end the rest as interrupted (the user resumes by sending again). Returns how many were interrupted.
   */
  async drain(graceMs: number): Promise<number> {
    this.cluster.draining = true;
    await this.cluster.waitForLocalRuns(Date.now() + graceMs);
    let interrupted = 0;
    for (const ctx of this.sessions.values()) {
      const run = ctx.activeRun;
      if (!run || run.done) continue;
      interrupted++;
      this.cluster.markInterrupting(run.id);
      run.events.push({ type: "error", message: INTERRUPTED_MESSAGE });
      run.endReason = "cancelled";
      this.transition(ctx, run.status === "queued" ? "cancelled" : "failed", run);
      run.abort.abort();
      ctx.bridge.cancelAll("interrupted");
      ctx.approvals.rejectAll("interrupted");
      void ctx.piSession.abort().catch(() => {});
      this.persist(ctx);
    }
    await this.cluster.waitForLocalRuns(Date.now() + 5000);
    return interrupted;
  }

  /** Drop a cached session another replica has changed; it is rebuilt from the store on next use. */
  private evict(ctx: SessionContext): void {
    if (this.sessions.get(ctx.id) !== ctx) return;
    this.sessions.delete(ctx.id);
    this.cluster.forget(ctx.id);
    this.sandboxes?.evict(ctx.id);
    ctx.dispose();
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
