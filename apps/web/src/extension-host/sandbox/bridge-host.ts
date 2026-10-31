import { MCP_APPS_PROTOCOL } from "@studio/plugin-ui-sdk/viewer";

/**
 * The host side of the MCP Apps bridge (modelcontextprotocol/ext-apps, spec 2026-01-26) for
 * `studio.sandbox-frame.v1`. Pure logic, no React, so it can be tested with a fake frame.
 *
 *   Studio ── postMessage ──▶ sandbox proxy (separate origin, sandbox="allow-scripts")
 *                                └─▶ View (srcdoc, sandbox="allow-scripts", inherits the proxy's CSP)
 *
 * 1. The proxy sends `ui/notifications/sandbox-proxy-ready`; we answer
 *    `ui/notifications/sandbox-resource-ready` with the View's HTML, its sandbox tokens and CSP.
 * 2. The View sends `ui/initialize`; we return host info, capabilities and context, then on
 *    `ui/notifications/initialized` send `tool-input` and `tool-result` (the item as
 *    `structuredContent`).
 * 3. The View's `tools/call` requests are answered by `callTool` (the Studio's viewer tools);
 *    nothing is proxied anywhere else. Every other request gets a JSON-RPC error.
 *
 * Messages are accepted only from the frame's own window (`event.source`), since the proxy
 * and the View both run on opaque origins (`event.origin === "null"`).
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface CallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface SandboxHostOptions {
  /** The proxy iframe's window (null while unmounted). */
  frame: () => Window | null | undefined;
  /** The View document. */
  html: () => string;
  hostInfo: { name: string; version: string };
  /** Host context for `ui/initialize` (theme, container size, locale). */
  context: () => Record<string, unknown>;
  /** What the View shows: sent as the tool result's `structuredContent`. */
  state: () => Record<string, unknown>;
  /** Tool-call arguments sent as `tool-input`. */
  input?: () => Record<string, unknown>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  onSize?: (size: { width?: number; height?: number }) => void;
  onLog?: (params: Record<string, unknown>) => void;
  /** The View connected (`initialized`). */
  onReady?: () => void;
}

/** CSP domains the host approves for Views: none. Studio viewers never reach the network. */
export const APPROVED_CSP = { connectDomains: [] as string[], resourceDomains: [] as string[], frameDomains: [] as string[] };

export function createSandboxHost(o: SandboxHostOptions) {
  let initialized = false;
  let disposed = false;
  const post = (m: Omit<JsonRpcMessage, "jsonrpc">) => {
    if (disposed) return;
    // The proxy is on an opaque origin, so there is no origin to target; `source` checks guard the way in.
    o.frame()?.postMessage({ jsonrpc: "2.0", ...m }, "*");
  };
  const notify = (method: string, params: Record<string, unknown>) => post({ method, params });
  const reply = (id: JsonRpcMessage["id"], result: unknown) => post({ id, result });
  const fail = (id: JsonRpcMessage["id"], code: number, message: string) => post({ id, error: { code, message } });

  const sendState = () => {
    notify("ui/notifications/tool-input", { arguments: o.input?.() ?? {} });
    notify("ui/notifications/tool-result", { content: [{ type: "text", text: "Viewer state" }], structuredContent: o.state() });
  };

  async function onRequest(m: JsonRpcMessage) {
    const params = m.params ?? {};
    switch (m.method) {
      case "ui/initialize":
        return reply(m.id, {
          protocolVersion: MCP_APPS_PROTOCOL,
          hostInfo: o.hostInfo,
          hostCapabilities: { serverTools: {}, logging: {}, sandbox: { csp: APPROVED_CSP, permissions: {} } },
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", ...o.context() },
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        try {
          return reply(m.id, await o.callTool(name, args));
        } catch (e) {
          return reply(m.id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      case "ping":
        return reply(m.id, {});
      case "ui/open-link":
      case "ui/message":
      case "ui/download-file":
      case "ui/update-model-context":
        // Views may not open links, write to the chat or download: nothing leaves through them.
        return reply(m.id, { isError: true });
      case "ui/request-display-mode":
        return reply(m.id, { mode: "inline" });
      default:
        return fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  function onNotification(m: JsonRpcMessage) {
    const params = m.params ?? {};
    switch (m.method) {
      case "ui/notifications/sandbox-proxy-ready":
        initialized = false;
        return notify("ui/notifications/sandbox-resource-ready", { html: o.html(), sandbox: "allow-scripts", csp: APPROVED_CSP, permissions: {} });
      case "ui/notifications/initialized":
        initialized = true;
        sendState();
        return o.onReady?.();
      case "ui/notifications/size-changed":
        return o.onSize?.({ width: num(params.width), height: num(params.height) });
      case "notifications/message":
        return o.onLog?.(params);
    }
  }

  return {
    /** Feed every window `message` event here. */
    onMessage(e: MessageEvent) {
      const win = o.frame();
      if (!win || e.source !== win) return;
      const m = e.data as JsonRpcMessage;
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
      if (m.method && m.id !== undefined) void onRequest(m);
      else if (m.method) onNotification(m);
    },
    /** The item or labels changed: send the new state (if the View is connected). */
    update() {
      if (initialized) sendState();
    },
    get connected() {
      return initialized;
    },
    /** Ask the View to clean up (`ui/resource-teardown`), then stop talking to it. */
    dispose() {
      if (initialized) post({ id: "teardown", method: "ui/resource-teardown", params: {} });
      disposed = true;
    },
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
