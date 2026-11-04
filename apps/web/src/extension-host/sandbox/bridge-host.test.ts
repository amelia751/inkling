import { describe, expect, it, vi } from "vitest";
import { VIEWER_CSP, VIEWER_STYLES, VIEWER_THEME_TOKENS, themeViewerDocument, viewerDocument, type ViewerTheme } from "@studio/plugin-ui-sdk/viewer";
import { createSandboxHost, readStudioTheme, viewHtml, type JsonRpcMessage } from "./bridge-host";

function setup(callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { added: 1 } }))) {
  const sent: JsonRpcMessage[] = [];
  const win = { postMessage: (m: JsonRpcMessage) => sent.push(m) } as unknown as Window;
  const host = createSandboxHost({
    frame: () => win,
    html: () => "<p>view</p>",
    hostInfo: { name: "test", version: "1" },
    context: () => ({ theme: "light" }),
    state: () => ({ item: { id: "a", name: "a", assets: [] } }),
    callTool,
  });
  const from = (data: unknown, source: unknown = win) => host.onMessage({ data, source } as MessageEvent);
  return { sent, host, from, callTool };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MCP Apps host bridge", () => {
  it("answers proxy-ready with the resource, then initializes and sends the item", async () => {
    const { sent, from, host } = setup();
    from({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    expect(sent[0]).toMatchObject({ method: "ui/notifications/sandbox-resource-ready", params: { html: "<p>view</p>", sandbox: "allow-scripts", csp: { connectDomains: [] } } });
    from({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    await flush();
    expect(sent[1]).toMatchObject({ id: 1, result: { protocolVersion: "2026-01-26", hostInfo: { name: "test" }, hostContext: { theme: "light", displayMode: "inline" } } });
    from({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(host.connected).toBe(true);
    expect(sent.slice(2).map((m) => m.method)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    expect(sent[3].params).toMatchObject({ structuredContent: { item: { id: "a" } } });
  });

  it("routes tools/call to the viewer tools and refuses links, messages and unknown methods", async () => {
    const { sent, from, callTool } = setup();
    from({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "viewer_propose_annotations", arguments: { annotations: [] } } });
    from({ jsonrpc: "2.0", id: 3, method: "ui/open-link", params: { url: "https://evil.example" } });
    from({ jsonrpc: "2.0", id: 4, method: "sampling/createMessage", params: {} });
    await flush();
    expect(callTool).toHaveBeenCalledWith("viewer_propose_annotations", { annotations: [] });
    expect(sent.find((m) => m.id === 2)?.result).toMatchObject({ structuredContent: { added: 1 } });
    expect(sent.find((m) => m.id === 3)?.result).toEqual({ isError: true });
    expect(sent.find((m) => m.id === 4)?.error?.code).toBe(-32601);
  });

  it("ignores messages from other windows and non-JSON-RPC data", async () => {
    const { sent, from } = setup();
    from({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" }, {});
    from({ type: "legacy:getAnnotations" });
    await flush();
    expect(sent).toEqual([]);
  });

  it("tool errors come back as isError results", async () => {
    const { sent, from } = setup(vi.fn(async () => { throw new Error("boom"); }));
    from({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x" } });
    await flush();
    expect(sent[0].result).toMatchObject({ isError: true });
  });
});

describe("theme injection (todo23 W2)", () => {
  const dark = { mode: "dark" as const, vars: { "--g-background": "rgb(28 28 31)", "--g-text-primary": "rgb(255 255 255 / 0.95)" } };

  it("injects the theme variables and stylesheet into the View, and re-sends them on a theme change", async () => {
    const sent: JsonRpcMessage[] = [];
    const win = { postMessage: (m: JsonRpcMessage) => sent.push(m) } as unknown as Window;
    let theme: ViewerTheme = { mode: "light", vars: { "--g-background": "#ffffff" } };
    const host = createSandboxHost({
      frame: () => win,
      html: () => viewerDocument({ source: "export function render() {}", title: "t" }),
      hostInfo: { name: "test", version: "1" },
      context: () => ({}),
      theme: () => theme,
      state: () => ({}),
      callTool: vi.fn(),
    });
    const from = (data: unknown) => host.onMessage({ data, source: win } as MessageEvent);
    from({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    const html = String(sent[0].params?.html);
    expect(html).toContain('<html data-theme="light"');
    expect(html).toContain('<style id="studio-viewer-theme">:root{--g-background:#ffffff;}</style>');
    expect(html).toContain('id="studio-viewer-styles"');
    // The CSP stays network-free and unchanged.
    expect(html).toContain(`content="${VIEWER_CSP}"`);
    expect(VIEWER_CSP).toContain("connect-src 'none'");
    expect(VIEWER_CSP).toContain("default-src 'none'");

    from({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    await flush();
    expect(sent[1].result).toMatchObject({ hostContext: { theme: "light", styles: { variables: { "--g-background": "#ffffff" } } } });
    from({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    theme = dark;
    host.themeChanged();
    expect(sent.at(-1)).toMatchObject({ method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: dark.vars } } });
  });

  it("adds the stylesheet to tier-3 pages and keeps values from closing the style element", () => {
    const html = themeViewerDocument("<!doctype html><html><head><title>x</title></head><body></body></html>", { mode: "dark", vars: { "--g-line": "red;}</style><script>", "not-a-var": "x" } });
    expect(html).toContain('<html data-theme="dark">');
    expect(html).toContain("--g-line:red/stylescript;");
    expect(html).not.toContain("not-a-var");
    expect(html).toContain('<style id="studio-viewer-styles">');
    expect(viewHtml("<p>v</p>", undefined)).toBe("<p>v</p>");
  });

  it("reads the active theme from the document", () => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--g-background", "rgb(28 28 31)");
    const t = readStudioTheme(document);
    expect(t.mode).toBe("dark");
    expect(t.vars["--g-background"]).toBe("rgb(28 28 31)");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("--g-background");
  });

  it("every token the stylesheet uses is one the theme defines", () => {
    const used = new Set([...VIEWER_STYLES.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    for (const v of used) expect(VIEWER_THEME_TOKENS as readonly string[]).toContain(v);
    expect(VIEWER_STYLES).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
  });
});
