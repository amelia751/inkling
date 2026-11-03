import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULT_STUDIO_URL, loadConfig, NAMING } from "../../src/config.ts";

const k = (key: string) => `${NAMING.envPrefix}${key}`;

test("defaults to the api's dev URL", () => {
  const c = loadConfig({});
  assert.equal(c.webUrl, DEFAULT_STUDIO_URL);
  assert.equal(c.apiUrl, DEFAULT_STUDIO_URL);
});

test("MCP_STUDIO_URL wins; WEB_URL still works; API_URL is the fallback", () => {
  assert.equal(loadConfig({ [k("MCP_STUDIO_URL")]: "http://s/", [k("WEB_URL")]: "http://w" }).webUrl, "http://s");
  const old = loadConfig({ [k("WEB_URL")]: "http://w", [k("API_URL")]: "http://a" });
  assert.equal(old.webUrl, "http://w");
  assert.equal(old.apiUrl, "http://a");
  assert.equal(loadConfig({ [k("API_URL")]: "http://a" }).webUrl, "http://a");
});

test("todo22 D2: the remote server in production needs its OAuth settings; stdio does not", () => {
  const prod = { [k("ENV")]: "production", [k("MCP_TRANSPORT")]: "http" };
  assert.throws(() => loadConfig(prod), (e: Error) => e instanceof ConfigError && e.message.includes(k("MCP_PUBLIC_URL")) && e.message.includes(k("MCP_AUTH_SERVER")));
  assert.throws(() => loadConfig({ ...prod, [k("MCP_PUBLIC_URL")]: "https://mcp.example/mcp" }), /MCP_AUTH_SERVER/);
  assert.throws(() => loadConfig({ ...prod, [k("MCP_AUTH_SERVER")]: "https://x.authkit.app" }), /MCP_PUBLIC_URL/);
  assert.throws(() => loadConfig({ [k("ENV")]: "production" }, ["node", "main", "--http"]), ConfigError);
  const ok = loadConfig({ ...prod, [k("MCP_PUBLIC_URL")]: "https://mcp.example/mcp", [k("MCP_AUTH_SERVER")]: "https://x.authkit.app/" });
  assert.equal(ok.authServer, "https://x.authkit.app");
  assert.equal(loadConfig({ [k("ENV")]: "production" }).transport, "stdio");
  assert.equal(loadConfig({ [k("MCP_TRANSPORT")]: "http" }).authServer, undefined);
});
