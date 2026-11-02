import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STUDIO_URL, loadConfig, NAMING } from "../../src/config.ts";

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
