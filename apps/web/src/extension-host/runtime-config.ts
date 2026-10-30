import { NAMING, configureNaming } from "@studio/plugin-contracts/naming";

/**
 * Runtime settings (todo/done/todo3.md D.1): nothing environment-specific is baked into the
 * bundle, so one web image runs in every environment. `main.tsx` fetches `/config.json`
 * (served by the web image's nginx from a ConfigMap or a compose volume) before the app
 * loads. When it's absent (the Vite dev server, tests) the same-origin defaults below apply,
 * plus what the dev server passes in: `import.meta.env.DEV_API` (true when it was started with
 * `<envPrefix>API_URL`, vite.config.ts) and `VITE_<envPrefix>FLAGS`.
 */
export interface RuntimeConfig {
  /** Base of the kernel API (apps/api); the SPA appends `/v1/…`, `/annotations/…`. */
  apiBase: string;
  /** Base of the agent proxy (apps/agent behind `/api/agent` → `/v1`). */
  agentBase: string;
  /** The kernel serves commands, jobs, plugins and signed asset URLs (else the dev seed server stands in). */
  kernel: boolean;
  /** Feature flags (extension-host/flags.ts), e.g. `agentPanels`. */
  flags: string[];
  /** Display name override (white-label); ids and prefixes stay as built. */
  displayName: string;
}

const viteEnv = (): Record<string, unknown> => (import.meta as { env?: Record<string, unknown> }).env ?? {};

function defaults(): RuntimeConfig {
  const env = viteEnv();
  const flags = env[`VITE_${NAMING.envPrefix}FLAGS`];
  return {
    apiBase: "/api",
    agentBase: "/api/agent",
    kernel: env.DEV_API === true,
    flags: typeof flags === "string" ? splitList(flags) : [],
    displayName: NAMING.displayName,
  };
}

const splitList = (s: string) => s.split(",").map((f) => f.trim()).filter(Boolean);
const trimSlash = (s: string) => s.replace(/\/+$/, "");

let current: RuntimeConfig | null = null;

/** The active settings: defaults until `loadRuntimeConfig` has merged `/config.json`. */
export function runtimeConfig(): RuntimeConfig {
  return (current ??= defaults());
}

/** Merge a (partial, untrusted) config document over the defaults; unknown or mistyped keys are ignored. */
export function applyRuntimeConfig(doc: unknown): RuntimeConfig {
  const base = defaults();
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  current = {
    apiBase: trimSlash(str(d.apiBase) ?? base.apiBase),
    agentBase: trimSlash(str(d.agentBase) ?? base.agentBase),
    kernel: typeof d.kernel === "boolean" ? d.kernel : base.kernel,
    flags: [...new Set([...base.flags, ...(Array.isArray(d.flags) ? d.flags.filter((f): f is string => typeof f === "string") : typeof d.flags === "string" ? splitList(d.flags) : [])])],
    displayName: str(d.displayName) ?? base.displayName,
  };
  if (current.displayName !== NAMING.displayName) {
    const old = NAMING.displayName;
    configureNaming({ displayName: current.displayName });
    if (typeof document !== "undefined") document.title = document.title.replaceAll(old, current.displayName);
  }
  return current;
}

/**
 * Fetch `/config.json` once at startup. A missing file, an HTML fallback (the dev server
 * answers unknown paths with index.html) or a network error all mean "use the defaults".
 */
export async function loadRuntimeConfig(url = "/config.json"): Promise<RuntimeConfig> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) return applyRuntimeConfig(await res.json());
  } catch {
    /* offline or blocked: defaults */
  }
  return applyRuntimeConfig(null);
}

/** `apiUrl("/v1/jobs/1")` → `<apiBase>/v1/jobs/1`. */
export const apiUrl = (path: string) => `${runtimeConfig().apiBase}${path}`;
