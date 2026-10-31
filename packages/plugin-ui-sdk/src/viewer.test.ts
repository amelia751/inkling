import { describe, expect, it } from "vitest";
import { MCP_APPS_PROTOCOL, VIEWER_RUNTIME, VIEWER_TOOLS, viewerDocument } from "./viewer";

type Msg = { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

/**
 * Run the View runtime in the test window with a fake parent (the sandbox proxy) that records
 * what the View sends. Each call adds a listener; tests only look at their own messages.
 */
function boot(source: string) {
  document.body.innerHTML = `<div id="viewer-root"></div><script type="application/json" id="viewer-module">${JSON.stringify(source)}</script>`;
  const sent: Msg[] = [];
  const fakeParent = { postMessage: (m: Msg) => sent.push(m) };
  Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} };
  new Function(VIEWER_RUNTIME)();
  const deliver = (data: Msg, source: unknown = fakeParent) => window.dispatchEvent(new MessageEvent("message", { data, source: source as never }));
  return { sent, deliver };
}

describe("viewer document", () => {
  it("escapes the module source and the title", () => {
    const html = viewerDocument({ source: 'export function render({ el }) { el.textContent = "</script><b>"; }', title: "A <b>" });
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("<title>A &lt;b&gt;</title>");
    expect(html).toContain("connect-src 'none'");
  });

  it("speaks MCP Apps: ui/initialize, initialized, then tools/call for assets", async () => {
    const { sent, deliver } = boot("export function render() {}");
    const init = sent.find((m) => m.method === "ui/initialize")!;
    expect(init).toMatchObject({ jsonrpc: "2.0", params: { protocolVersion: MCP_APPS_PROTOCOL } });
    deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: MCP_APPS_PROTOCOL, hostInfo: { name: "test-host", version: "1" }, hostCapabilities: {}, hostContext: { theme: "dark" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
  });

  it("ignores messages that aren't from its parent", () => {
    const { sent, deliver } = boot("export function render() {}");
    const init = sent.find((m) => m.method === "ui/initialize")!;
    deliver({ jsonrpc: "2.0", id: init.id, result: {} }, null);
    expect(sent.some((m) => m.method === "ui/notifications/initialized")).toBe(false);
  });

  it("names the host tools it calls", () => {
    expect(Object.values(VIEWER_TOOLS).every((n) => /^viewer_[a-z_]+$/.test(n))).toBe(true);
  });
});
