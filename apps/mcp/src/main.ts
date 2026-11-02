// `pnpm mcp`: an MCP server that lets an outside agent (Claude Code, Cursor…) work in projects
// and inspect and boot Studio environments. It talks to the API over HTTP, so every write goes
// through the API's own checks (admission, rules, revisions) under the caller's identity.
//
//   pnpm mcp                                         # stdio; <envPrefix>MCP_API_KEY or MCP_PERSON_TOKEN
//   <envPrefix>MCP_TRANSPORT=http pnpm mcp            # streamable HTTP (or `pnpm mcp --http`): studio-mcp
//   claude mcp add <resourcePrefix> -- pnpm --dir /abs/path/to/repo mcp
//   claude mcp add --transport http <resourcePrefix> http://127.0.0.1:8300/mcp
// Names (env vars, server name, copy) come from schemas/naming.json (`pnpm emit:schemas`).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { createServer } from "./server.js";

const config = loadConfig();
if (config.transport === "http") {
  startHttp(config);
} else {
  await createServer(config, config.personToken ?? config.apiKey).connect(new StdioServerTransport());
}
