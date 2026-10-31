import { useEffect, useMemo, useRef } from "react";
import type { StudioItem } from "@studio/contracts/types";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk";
import { NAMING } from "@studio/contracts/naming";
import { createSandboxHost } from "./bridge-host";
import { viewerState, viewerTools } from "./viewer-tools";
import { sandboxProxyUrl } from "../runtime-config";

export interface SandboxFrameProps {
  title: string;
  /** The View document (a viewer document, or a tier-3 page with the legacy shim). */
  html: string;
  env: ResolvedEnv;
  item: StudioItem | undefined;
  config: Record<string, unknown>;
  /** Author recorded on proposed annotations, e.g. `agent:sandbox` or `viewer:<plugin>`. */
  author: string;
  /** Fixed height (panels); omitted: fill the parent (viewports). Views' size-changed requests are ignored. */
  height?: number;
  testId: string;
  onNotice?: (text: string) => void;
}

/**
 * `studio.sandbox-frame.v1` on MCP Apps (todo10 Phase 5): an iframe on the sandbox proxy
 * (separate origin, `sandbox="allow-scripts"` only, CSP header without network), which loads
 * the View into its own sandboxed srcdoc frame. The Studio answers the View's JSON-RPC
 * requests (bridge-host.ts) with the viewer tools (viewer-tools.ts).
 */
export function SandboxFrame({ title, html, env, item, config, author, height, testId, onNotice }: SandboxFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const src = useMemo(() => sandboxProxyUrl(), []);
  // Latest values for the bridge without re-creating it (and reloading the View) on every render.
  const live = useRef({ env, item, config, html });
  live.current = { env, item, config, html };
  const notice = useRef(onNotice);
  notice.current = onNotice;

  const bridge = useRef<ReturnType<typeof createSandboxHost> | null>(null);

  useEffect(() => {
    const b = createSandboxHost({
      frame: () => frame.current?.contentWindow,
      html: () => live.current.html,
      hostInfo: { name: `${NAMING.resourcePrefix}-studio`, version: "1.0.0" },
      context: () => ({
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        locale: navigator.language,
        containerDimensions: { maxHeight: height ?? frame.current?.clientHeight ?? 600, width: frame.current?.clientWidth ?? 600 },
      }),
      state: () => viewerState(live.current.env, live.current.item, live.current.config),
      input: () => ({ itemId: live.current.item?.id ?? null }),
      callTool: viewerTools({
        env: () => live.current.env,
        item: () => live.current.item,
        author,
        onProposed: (added, rejected) => notice.current?.(`${added} suggestion${added === 1 ? "" : "s"} added${rejected ? `, ${rejected} rejected` : ""}`),
      }),
    });
    bridge.current = b;
    const on = (e: MessageEvent) => b.onMessage(e);
    window.addEventListener("message", on);
    return () => {
      window.removeEventListener("message", on);
      b.dispose();
    };
    // A new document is a new View (the iframe is keyed by it too).
  }, [html, author, height]);

  useEffect(() => bridge.current?.update(), [item?.id, env]);

  const fixed = height !== undefined;
  return (
    <iframe
      key={html}
      ref={frame}
      title={title}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={fixed ? { height } : undefined}
      className={fixed ? "w-full shrink-0 border-0 bg-white" : "h-full w-full border-0 bg-white"}
      data-testid={testId}
      data-sandbox-proxy=""
    />
  );
}
