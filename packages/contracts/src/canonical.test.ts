import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, contentHash, NULL_CONTENT_HASH } from "./canonical";
import { FIRST_PARTY_SIGNER, firstPartyIds, lockfileHash, normalizeLockfile, parseLockfile, PluginsLock, serializeLockfile } from "./lockfile";

// Shared with apps/api/tests/test_canonical.py, so the kernel and the browser hash alike.
const { vectors } = JSON.parse(readFileSync(join(__dirname, "../test-vectors/canonical.json"), "utf8")) as { vectors: { input: string; canonical: string; hash: string }[] };

describe("RFC 8785 canonical JSON", () => {
  it.each(vectors)("$input", async ({ input, canonical, hash }) => {
    const v = JSON.parse(input);
    expect(canonicalize(v)).toBe(canonical);
    expect(await contentHash(v)).toBe(hash);
  });

  it("hashes the same value the same whatever its key order", async () => {
    const a = { extends: "preset:x", labels: [{ name: "l", classes: [{ id: "a" }] }], task: "t" };
    const b = { task: "t", labels: [{ classes: [{ id: "a" }], name: "l" }], extends: "preset:x" };
    expect(await contentHash(a)).toBe(await contentHash(b));
    expect(await contentHash({ ...a, task: "u" })).not.toBe(await contentHash(a));
  });

  it("refuses what isn't JSON and drops undefined members", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("has a fixed hash for null (the parent of a first revision with no base)", async () => {
    expect(await contentHash(null)).toBe(NULL_CONTENT_HASH);
  });
});

describe("plugins.lock.json", () => {
  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  const lock: PluginsLock = {
    lockfileVersion: 1,
    plugins: [
      { id: "acme.zeta", version: "2.0.0", digest: digest("b"), signer: "ed25519:k1", permissions: ["jobs.create", "assets.read", "assets.read"], configRevision: 3 },
      { id: "acme.alpha", version: "1.0.0", digest: digest("a"), signer: FIRST_PARTY_SIGNER, permissions: [], configRevision: 0 },
    ],
  };

  it("round-trips: serialize → parse gives the same lockfile and hash", async () => {
    const text = serializeLockfile(lock);
    const back = parseLockfile(text);
    expect(back).toEqual(normalizeLockfile(lock));
    expect(serializeLockfile(back)).toBe(text);
    expect(await lockfileHash(back)).toBe(await lockfileHash(lock));
    expect(back.plugins.map((p) => p.id)).toEqual(["acme.alpha", "acme.zeta"]);
    expect(back.plugins[1].permissions).toEqual(["assets.read", "jobs.create"]);
  });

  it("rejects tags without digests, unknown fields and duplicates", () => {
    const bad = (p: object) => PluginsLock.safeParse({ lockfileVersion: 1, plugins: [p] }).success;
    const ok = lock.plugins[1];
    expect(bad(ok)).toBe(true);
    expect(bad({ ...ok, digest: "latest" })).toBe(false);
    expect(bad({ ...ok, digest: "sha256:abc" })).toBe(false);
    expect(bad({ ...ok, trust: "high" })).toBe(false);
    expect(PluginsLock.safeParse({ lockfileVersion: 1, plugins: [ok, ok] }).success).toBe(false);
    expect(PluginsLock.safeParse({ lockfileVersion: 2, plugins: [] }).success).toBe(false);
  });

  it("names the first-party plugins safe mode keeps", () => {
    expect(firstPartyIds(lock)).toEqual(["acme.alpha"]);
  });
});
