import { describe, expect, it, vi } from "vitest";
import { createSandboxHost, type JsonRpcMessage } from "./bridge-host";

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
