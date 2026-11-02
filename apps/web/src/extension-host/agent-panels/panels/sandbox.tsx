import { useMemo, useState } from "react";
import type * as z from "zod";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { viewerDocument } from "@studio/plugin-ui-sdk/viewer";
import { BRIDGE_SCRIPT } from "../bridge";
import type { SandboxConfig } from "../manifest";
import { SandboxFrame } from "../../sandbox/SandboxFrame";

type Config = z.infer<typeof SandboxConfig>;

/** The View document for a sandbox config: a viewer module (rung 4), else tier-3 HTML with the `window.<resourcePrefix>` shim. */
export function sandboxDocument(cfg: Pick<Config, "html" | "module" | "title">): string {
  if (cfg.module) return viewerDocument({ source: cfg.module, title: cfg.title });
  // Inject the bridge before the agent's own markup so `window.<resourcePrefix>` exists for its scripts.
  return /<head[^>]*>/i.test(cfg.html) ? cfg.html.replace(/<head[^>]*>/i, (m) => `${m}${BRIDGE_SCRIPT}`) : `${BRIDGE_SCRIPT}${cfg.html}`;
}

/**
 * Tier 3 / `studio.sandbox-frame.v1` as a panel: the View runs behind the MCP Apps sandbox
 * proxy (separate origin, opaque, no network), with no access to the app's DOM, storage or
 * cookies, and no navigation, popups or forms. It can only call the viewer tools.
 */
export function SandboxPanel({ env, item, config }: PanelProps) {
  const cfg = config as Config;
  const [notice, setNotice] = useState<string | null>(null);
  const html = useMemo(() => sandboxDocument(cfg), [cfg.html, cfg.module, cfg.title]);
  return (
    <aside className="flex h-full flex-col bg-[var(--bg-primary)] text-sm" aria-label={cfg.title}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <span className="font-medium">{cfg.title}</span>
        <span className="rounded bg-warning-tint px-1.5 py-0.5 text-[10px] uppercase tracking-wide">sandboxed</span>
      </div>
      <SandboxFrame title={cfg.title} html={html} env={env} item={item} config={cfg as Record<string, unknown>} author="agent:sandbox" height={cfg.height} testId="agent-sandbox" onNotice={setNotice} />
      {notice && <p className="border-t border-[var(--border-color)] px-3 py-1.5 text-xs text-muted-foreground" role="status">{notice}</p>}
    </aside>
  );
}
