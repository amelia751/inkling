import { useEffect, useMemo, useRef, useState } from "react";
import type * as z from "zod";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { BRIDGE_SCRIPT, vetProposals } from "../bridge";
import type { SandboxConfig } from "../manifest";
import { RES } from "@studio/contracts/naming";
import { useHost, visibleFor } from "@studio/plugin-ui-sdk";

type Config = z.infer<typeof SandboxConfig>;

/**
 * Tier 3: agent-written HTML in an iframe with `sandbox="allow-scripts"` only: an opaque
 * origin, so no access to the app's DOM, storage, cookies or same-origin APIs, and no
 * navigation, popups or forms. The bridge answers exactly two requests.
 */
export function SandboxPanel({ env, item, config }: PanelProps) {
  const cfg = config as Config;
  const frame = useRef<HTMLIFrameElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const srcDoc = useMemo(() => {
    // Inject the bridge before the agent's own markup so `window.inkling` exists for its scripts.
    const html = cfg.html;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${BRIDGE_SCRIPT}`) : `${BRIDGE_SCRIPT}${html}`;
  }, [cfg.html]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || !e.data || typeof e.data !== "object") return;
      const { id, type, payload } = e.data as { id: number; type: string; payload: unknown };
      const reply = (p: unknown) => win.postMessage({ reply: id, payload: p }, "*");
      const s = useHost.getState();
      if (type === `${RES}:getAnnotations`) {
        reply({ item: item && { id: item.id, name: item.name }, annotations: item ? visibleFor(s.annotations, item.id, s.hiddenLabels) : [] });
      } else if (type === `${RES}:propose`) {
        if (!item) return reply({ added: 0, rejected: ["no item open"] });
        const { ok, rejected } = vetProposals(payload, env);
        const now = new Date().toISOString();
        s.addMany(ok.map((p) => ({ ...p, id: crypto.randomUUID(), itemId: item.id, provenance: "ai-suggested" as const, author: "agent:sandbox", createdAt: now })));
        setNotice(`${ok.length} suggestion${ok.length === 1 ? "" : "s"} added${rejected.length ? `, ${rejected.length} rejected` : ""}`);
        reply({ added: ok.length, rejected });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [env, item]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: `${RES}:item`, payload: item && { id: item.id, name: item.name } }, "*");
  }, [item]);

  return (
    <aside className="flex h-full flex-col bg-[var(--bg-primary)] text-sm" aria-label={cfg.title}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <span className="font-medium">{cfg.title}</span>
        <span className="rounded bg-warning-tint px-1.5 py-0.5 text-[10px] uppercase tracking-wide">sandboxed</span>
      </div>
      <iframe ref={frame} title={cfg.title} sandbox="allow-scripts" srcDoc={srcDoc} style={{ height: cfg.height }} className="w-full shrink-0 border-0 bg-white" data-testid="agent-sandbox" />
      {notice && <p className="border-t border-[var(--border-color)] px-3 py-1.5 text-xs text-muted-foreground" role="status">{notice}</p>}
    </aside>
  );
}
