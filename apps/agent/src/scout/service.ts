import type { Sandbox } from "@daytona/sdk";
import { OSS_ECOSYSTEMS } from "@studio/contracts/oss-evaluation";
import { z } from "zod";
import type { EgressPolicy } from "../sandbox/defaults.ts";
import type { SandboxProvider } from "../sandbox/provider.ts";
import { compareOss } from "./compare.ts";
import { type Fetcher, defaultFetcher } from "./http.ts";
import { searchOss } from "./search.ts";
import { trialOss } from "./trial.ts";
import { vetOss } from "./vet.ts";

/**
 * The open-source scout (todo23 W3) as one object: the agent's `scout` profile tools and the
 * `POST /v1/scout/*` routes (W10) are thin wrappers over these four calls.
 */

const Eco = z.enum(OSS_ECOSYSTEMS);
export const ScoutSchemas = {
  search: z.object({ need: z.string().min(2).max(300), ecosystem: Eco, candidates: z.array(z.string().max(214)).max(20).optional(), limit: z.number().int().min(1).max(25).optional() }),
  vet: z.object({ package: z.string().min(1).max(214), ecosystem: Eco, version: z.string().max(80).optional() }),
  trial: z.object({
    packages: z.array(z.object({ package: z.string().min(1).max(214), version: z.string().min(1).max(80), ecosystem: Eco })).min(1).max(10),
    smoke: z.string().min(1).max(2000),
    stepBudget: z.number().int().min(2).max(30).optional(),
  }),
  compare: z.object({ need: z.string().max(300).optional(), evaluations: z.array(z.unknown()).min(1).max(20) }),
};

export interface ScoutDeps {
  fetch?: Fetcher;
  provider?: SandboxProvider;
  egress?: () => EgressPolicy;
  env: string;
  snapshot?: (sb: Sandbox, name: string) => Promise<string>;
  now?: () => Date;
}

export type Scout = ReturnType<typeof createScout>;

export function createScout(deps: ScoutDeps) {
  const fetch = deps.fetch ?? defaultFetcher;
  const vet = (a: z.infer<typeof ScoutSchemas.vet>) => vetOss(a, { fetch, now: deps.now });
  return {
    search: (a: z.infer<typeof ScoutSchemas.search>) => searchOss(a, { fetch }),
    vet,
    trial: (a: z.infer<typeof ScoutSchemas.trial>, who: { projectId: string; owner: string }) =>
      trialOss(
        { ...a, ...who },
        {
          provider: deps.provider,
          egress: deps.egress ?? (() => ({ canOverride: false, allowDomains: [] })),
          vet,
          env: deps.env,
          snapshot: deps.snapshot,
        },
      ),
    compare: (a: z.infer<typeof ScoutSchemas.compare>) => compareOss(a),
  };
}

/** Daytona's snapshot of a running sandbox (the fake and local providers have none). */
export const daytonaSnapshot = async (sb: Sandbox, name: string): Promise<string> => {
  await sb.createSnapshot(name, 600);
  return name;
};
