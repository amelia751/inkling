// A minimal MCP Apps host page built on the official SDK (@modelcontextprotocol/ext-apps
// AppBridge + PostMessageTransport), with nothing from the Studio: it proves a viewer renders
// outside our web app. The page asks run.mjs (which holds the MCP client) for tools, the UI
// resource and tool calls, and embeds the View through a sandbox proxy on another origin.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

declare const SANDBOX_URL: string;
const post = async (path: string, body: unknown) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const log = (m: string) => {
  const p = document.createElement("li");
  p.textContent = m;
  document.getElementById("log")!.append(p);
};

const tools: any[] = await (await fetch("/api/tools")).json();
const tool = tools.find((t) => t._meta?.ui?.resourceUri);
if (!tool) throw new Error("no MCP Apps tool");
const uri: string = tool._meta.ui.resourceUri;
document.getElementById("tool")!.textContent = tool.name;
const args = { path: new URLSearchParams(location.search).get("path") };
const result = await post("/api/call", { name: tool.name, arguments: args });
const resource = (await (await fetch(`/api/resource?uri=${encodeURIComponent(uri)}`)).json()).contents[0];
log(`tool result for the model: ${JSON.stringify(result.content)}`);

const iframe = document.createElement("iframe");
iframe.id = "app";
iframe.src = SANDBOX_URL;
// The reference host's sandbox attributes; isolation comes from the proxy's separate origin.
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
iframe.style.cssText = "width:100%;height:480px;border:1px solid #ccc";
const bridge = new AppBridge(null, { name: "mcp-apps-harness-host", version: "1.0.0" }, { serverTools: {}, logging: {} });
bridge.oncalltool = async (params) => {
  log(`app → tools/call ${params.name}`);
  return post("/api/call", params);
};
bridge.onsandboxready = () => void bridge.sendSandboxResourceReady({ html: resource.text, csp: resource._meta?.ui?.csp });
bridge.oninitialized = () => {
  log("view initialized");
  document.body.dataset.initialized = "1";
  void bridge.sendToolInput({ arguments: args });
  void bridge.sendToolResult(result);
};
bridge.onsizechange = ({ height }) => {
  if (height) iframe.style.height = `${Math.min(height, 900)}px`;
};
document.getElementById("frame")!.append(iframe);
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
