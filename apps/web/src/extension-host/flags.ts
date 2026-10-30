import { NAMING, RES } from "@studio/plugin-contracts/naming";
/**
 * Feature flags for experimental surfaces (docs/modules.md, safety tiers). Read once at
 * startup from `VITE_<envPrefix>FLAGS` (build/dev env) or `localStorage["<resourcePrefix>.flags"]`
 * (per browser), each a comma-separated list such as `agentPanels`.
 */
export type Flag = "agentPanels";

function read(): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => typeof v === "string" && v.split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => out.add(f));
  add((import.meta as { env?: Record<string, unknown> }).env?.[`VITE_${NAMING.envPrefix}FLAGS`]);
  try {
    if (typeof localStorage !== "undefined") add(localStorage.getItem(`${RES}.flags`));
  } catch {
    /* storage blocked: env flags only */
  }
  return out;
}

const flags = read();

export function featureEnabled(flag: Flag): boolean {
  return flags.has(flag);
}
