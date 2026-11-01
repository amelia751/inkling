import { RES } from "@studio/contracts/naming";
import { runtimeConfig } from "./runtime-config";
/**
 * Feature flags for experimental surfaces (docs/modules.md, safety tiers). Read once at
 * startup from the runtime config (`/config.json` `flags`, or `VITE_<envPrefix>FLAGS` in dev; see
 * runtime-config.ts) or `localStorage["<resourcePrefix>.flags"]` (per browser, a comma-separated
 * list such as `agentPanels`; `bootTimeline` shows the Studio boot timeline overlay).
 */
export type Flag = "agentPanels" | "bootTimeline";

function read(): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => typeof v === "string" && v.split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => out.add(f));
  runtimeConfig().flags.forEach((f) => out.add(f));
  try {
    if (typeof localStorage !== "undefined") add(localStorage.getItem(`${RES}.flags`));
  } catch {
    /* storage blocked: env flags only */
  }
  return out;
}

let flags: Set<string> | null = null;

export function featureEnabled(flag: Flag): boolean {
  return (flags ??= read()).has(flag);
}
