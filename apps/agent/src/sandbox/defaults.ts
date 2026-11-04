import type { CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import type { Config } from "../config.ts";
import { NAMING } from "../naming.ts";

export const SANDBOX_HOME = "/home/daytona";
export const SANDBOX_CWD = `${SANDBOX_HOME}/work`;
export const SANDBOX_DATA_DIR = `${SANDBOX_HOME}/data`;
export const SANDBOX_OUT_DIR = `${SANDBOX_HOME}/out`;
export const SANDBOX_LOG_DIR = `${SANDBOX_HOME}/.${NAMING.resourcePrefix}/logs`;
export const APP_LABEL = NAMING.resourcePrefix;

export interface SandboxOwner {
  sessionId: string;
  projectId: string;
  owner: string;
  profile: string;
  /** Extra labels, e.g. `{ test: "live" }`. Values must never contain PHI. */
  labels?: Record<string, string>;
  restricted?: boolean;
}

export class SandboxNetworkError extends Error {
  override name = "SandboxNetworkError";
  constructor() {
    super(
      "This sandbox provider can't block the sandbox's network here (Daytona tier 1–2), and sandboxes run with no network (todo10 Phase 7). " +
        "Use a Daytona org on tier 3+, or AGENT_SANDBOX=local / gke. The tool was NOT run.",
    );
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Deterministic, so `daytona.get(name)` can reattach after a restart. */
export function sandboxName(env: string, sessionId: string): string {
  return `${APP_LABEL}-${slug(env)}-${slug(sessionId)}`.slice(0, 63).replace(/-+$/, "");
}

/** Label values are restricted to a safe charset; the sweeper selects by `app` + `env`. */
export function sandboxLabels(env: string, who: SandboxOwner): Record<string, string> {
  const labels: Record<string, string> = {
    app: APP_LABEL,
    env,
    session: who.sessionId,
    project: who.projectId,
    owner: who.owner,
    profile: who.profile,
    ...who.labels,
  };
  for (const [k, v] of Object.entries(labels)) labels[k] = v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 63);
  return labels;
}

export interface EgressPolicy {
  /** Tier 1–2 orgs cannot override egress; Daytona rejects the create call if we try. */
  canOverride: boolean;
  allowDomains: string[];
}

/**
 * todo23 D7: the package registries only, for an install step. github.com is no longer on it:
 * repos aren't installed from source (§2.2), only published wheels and npm packages.
 */
export const INSTALL_ALLOW_DOMAINS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"] as const;

export const DEFAULT_EGRESS: EgressPolicy = {
  canOverride: false,
  allowDomains: [...INSTALL_ALLOW_DOMAINS],
};

/**
 * Create parameters for every provider (todo10 Phase 7.8): no network on every tier, no secrets
 * or session data in the environment, a short life for build sandboxes. A provider that can't
 * cut the network fails the create, unless `AGENT_SANDBOX_NETWORK=org-default` (never in
 * production) accepts the org's default policy.
 */
export function createParams(
  config: Config,
  who: SandboxOwner,
  opts: { snapshot?: string; egress?: EgressPolicy; canBlockNetwork?: boolean } = {},
): CreateSandboxFromSnapshotParams {
  const s = config.sandbox;
  const build = who.labels?.purpose === "plugin-build";
  const ttl = build ? Math.min(s.ttlMin || s.buildTtlMin, s.buildTtlMin) : s.ttlMin;
  const params: CreateSandboxFromSnapshotParams = {
    name: sandboxName(config.env, who.sessionId),
    labels: sandboxLabels(config.env, who),
    language: "python",
    public: false,
    autoStopInterval: build ? Math.min(s.autoStopMin, 15) : s.autoStopMin,
    autoArchiveInterval: s.autoArchiveMin,
    autoDeleteInterval: build ? Math.min(s.autoDeleteMin, s.buildTtlMin) : s.autoDeleteMin,
    // Fixed, non-secret values only: nothing from the host, the user or the session.
    envVars: { PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
  };
  if (ttl > 0) params.ttlMinutes = ttl;
  if (opts.snapshot) params.snapshot = opts.snapshot;
  const canBlock = opts.canBlockNetwork ?? (opts.egress ?? DEFAULT_EGRESS).canOverride;
  if (canBlock) params.networkBlockAll = true;
  else if (s.network !== "org-default") throw new SandboxNetworkError();
  return params;
}
