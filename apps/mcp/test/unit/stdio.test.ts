import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio still works: tools listed, project_context first", async () => {
  const dir = fileURLToPath(new URL("../..", import.meta.url));
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "src/main.ts"], cwd: dir, env: { PATH: process.env.PATH ?? "" }, stderr: "ignore" }));
  const { tools } = await client.listTools();
  assert.equal(tools[0]!.name, "project_context");
  assert.ok(tools.some((t) => t.name === "patch_environment"));
  await client.close();
});
