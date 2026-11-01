import { useMemo, useState } from "react";
import type { RendererProps } from "@studio/plugin-ui-sdk";
import type { SandboxConfig } from "../agent-panels/manifest";
import { sandboxDocument } from "../agent-panels/panels/sandbox";
import { SandboxFrame } from "./SandboxFrame";
import type * as z from "zod";

export interface SandboxViewportProps extends RendererProps {
  /** The plugin that contributed the viewer (recorded as the author of its proposals). */
  pluginId?: string;
}

/**
 * `studio.sandbox-frame.v1` in a viewport (ladder rung 4): a plugin's ESM viewer module fills
 * the viewport, behind the MCP Apps sandbox proxy. Annotations it proposes arrive vetted and
 * `ai-suggested`, authored `viewer:<plugin id>`.
 */
export function SandboxViewport({ env, item, config, pluginId }: SandboxViewportProps) {
  const cfg = config as z.infer<typeof SandboxConfig>;
  const [notice, setNotice] = useState<string | null>(null);
  const html = useMemo(() => sandboxDocument(cfg), [cfg.html, cfg.module, cfg.title]);
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col" data-testid="sandbox-viewport" data-plugin={pluginId}>
      <div className="min-h-0 flex-1">
        <SandboxFrame title={cfg.title} html={html} env={env} item={item} config={cfg as Record<string, unknown>} author={`viewer:${pluginId ?? "sandbox"}`} testId="sandbox-viewer" onNotice={setNotice} />
      </div>
      <p className="flex h-7 shrink-0 items-center gap-2 border-t border-[var(--border-color)] px-3 text-xs text-muted-foreground" role="status">
        <span className="rounded bg-warning-tint px-1.5 py-0.5 text-[10px] uppercase tracking-wide">sandboxed viewer</span>
        {notice}
      </p>
    </div>
  );
}
