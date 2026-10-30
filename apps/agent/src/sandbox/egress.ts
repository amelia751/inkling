import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daytona } from "@daytona/sdk";
import type { Config } from "../config.ts";
import { DEFAULT_EGRESS, type EgressPolicy, sandboxLabels } from "./defaults.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EgressProbe extends EgressPolicy {
  checkedAt: number;
  detail: string;
}

/**
 * Tier 1–2 orgs can't set per-sandbox egress rules: Daytona rejects the create call. Find out once
 * by creating a tiny labelled probe sandbox with a domain allowlist, then delete it. The answer is
 * cached for a day in `.data/egress.json`, so restarts don't pay for another sandbox.
 */
export async function probeEgress(daytona: Daytona, config: Config, dir: string): Promise<EgressProbe> {
  const cacheFile = join(dir, "egress.json");
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as EgressProbe;
      if (Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;
    } catch {
      // Rewrite a corrupt cache below.
    }
  }
  let result: EgressProbe;
  try {
    const probe = await daytona.create(
      {
        labels: sandboxLabels(config.env, { sessionId: "egress-probe", projectId: "none", owner: "system", profile: "probe" }),
        domainAllowList: DEFAULT_EGRESS.allowDomains.join(","),
        autoStopInterval: 1,
        autoDeleteInterval: 5,
        public: false,
      },
      { timeout: 120 },
    );
    await probe.delete(60).catch(() => {});
    result = { ...DEFAULT_EGRESS, canOverride: true, checkedAt: Date.now(), detail: "per-sandbox egress rules accepted (tier 3+)" };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const tierLimited = /tier|network|allow ?list|egress|forbidden|not allowed|permission/i.test(msg);
    result = {
      ...DEFAULT_EGRESS,
      canOverride: false,
      checkedAt: Date.now(),
      detail: tierLimited ? "org tier can't override egress; organization network policy applies" : `probe failed: ${msg.slice(0, 200)}`,
    };
    // Don't cache transient failures; a tier answer is stable.
    if (!tierLimited) return result;
  }
  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}
