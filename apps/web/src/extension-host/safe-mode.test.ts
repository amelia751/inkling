import { afterEach, describe, expect, it } from "vitest";
import { FIRST_PARTY_SIGNER, type PluginsLock } from "@studio/contracts/lockfile";
import { MODULES } from "./bundled";
import { declarativeModule } from "./contributions-loader";
import { registry } from "./registry";
import { applySafeWorkspace } from "./workspace";

const digest = `sha256:${"a".repeat(64)}`;
const entry = (id: string, signer: string) => ({ id, version: "1.0.0", digest, signer, permissions: [], configRevision: 0 });
const REMOTE = "acme.remote-panel";

describe("safe mode activation (todo10 §3.4)", () => {
  afterEach(() => registry.setActive(null));

  it("keeps only first-party plugins the build bundles, never a remote one", () => {
    // A remote declarative plugin a previous boot registered stays off.
    if (!registry.availableModule(REMOTE))
      registry.registerModule(declarativeModule({ id: REMOTE, version: "1.0.0", name: "r", publisher: "acme", license: "MIT", schemaVersion: "x", compatibility: { studio: "*", pluginApi: "^1" }, capabilities: [], runtime: { kind: "none" }, permissions: { required: [], optional: [] } } as never, { toolbarActions: [], panels: [] } as never));
    const bundled = MODULES.map((m) => m.id);
    const firstParty = bundled.find((id) => id.endsWith("image2d"))!;
    const signed = bundled.find((id) => id.endsWith("video"))!;
    const lock: PluginsLock = { lockfileVersion: 1, plugins: [entry(firstParty, FIRST_PARTY_SIGNER), entry(REMOTE, FIRST_PARTY_SIGNER), entry(signed, "ed25519:k1")] };
    applySafeWorkspace(null, lock);
    const active = registry.activeIds();
    expect(active).toContain(firstParty);
    expect(active).not.toContain(REMOTE); // locked as first-party but not in this build: off
    expect(registry.isActive(REMOTE)).toBe(false);
    expect(registry.isActive(signed)).toBe(false); // not first-party in the lockfile: off
  });

  it("without a lockfile, takes the workspace's active plugins that are bundled", () => {
    const [a] = MODULES.map((m) => m.id).filter((id) => id.endsWith("video"));
    applySafeWorkspace({ workspaceId: "w", plugins: [{ pluginId: a, version: "1.0.0", configRevision: 0, state: "ACTIVATED" }, { pluginId: REMOTE, version: "1.0.0", configRevision: 0, state: "ACTIVATED" }] }, null);
    expect(registry.isActive(a)).toBe(true);
    expect(registry.isActive(REMOTE)).toBe(false);
  });
});
