import type { CreateSandboxFromSnapshotParams, Daytona, Sandbox } from "@daytona/sdk";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { withRateLimitRetry } from "./client.ts";
import { resolveSnapshot } from "./snapshot.ts";

/**
 * Where sandboxes come from (todo10 §6.2, Phase 7.8). One interface, chosen by `AGENT_SANDBOX`:
 *
 * - `daytona`: Daytona cloud (default). Only code and synthetic fixtures ever enter it.
 * - `local`: a container on this host or cluster node (`local.ts`; gVisor `runsc` by default,
 *   `--network none`), for customers who won't send even synthetic data out.
 * - `fake`: in-memory, recording every file and command (`fake.ts`; development and tests only).
 *
 * Every provider hands back the same handle: the subset of Daytona's `Sandbox` the tools use
 * (fs, process, lifecycle). Switching provider is a config change; nothing above this file
 * knows which one runs.
 */
export type SandboxProviderKind = "daytona" | "local" | "gke" | "fake";

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  /** Whether this provider can cut a sandbox off the network (Daytona: tier 3+ only). */
  canBlockNetwork(): boolean;
  /** A sandbox by id or name; undefined when there is none (or it's gone). */
  get(idOrName: string): Promise<Sandbox | undefined>;
  create(params: CreateSandboxFromSnapshotParams, opts?: { timeoutS?: number; warn?: (m: string) => void }): Promise<Sandbox>;
}

export class DaytonaProvider implements SandboxProvider {
  readonly kind = "daytona" as const;
  constructor(
    readonly daytona: Daytona,
    private readonly opts: { snapshot?: string; canBlock: () => boolean },
  ) {}

  canBlockNetwork(): boolean {
    return this.opts.canBlock();
  }

  async get(idOrName: string): Promise<Sandbox | undefined> {
    try {
      const sandbox = await withRateLimitRetry(() => this.daytona.get(idOrName));
      if (sandbox.state === "destroyed" || sandbox.state === "destroying" || sandbox.state === "error") return undefined;
      return sandbox;
    } catch (err) {
      if (err instanceof DaytonaNotFoundError) return undefined;
      throw err;
    }
  }

  async create(params: CreateSandboxFromSnapshotParams, opts: { timeoutS?: number; warn?: (m: string) => void } = {}): Promise<Sandbox> {
    const snapshot = await resolveSnapshot(this.daytona, this.opts.snapshot, opts.warn);
    return withRateLimitRetry(() => this.daytona.create({ ...params, ...(snapshot ? { snapshot } : {}) }, { timeout: opts.timeoutS ?? 120 }));
  }
}
