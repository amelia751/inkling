import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { treeDigestOfHashes, verifyPackage, type PackageFiles } from "./contributions-loader";

// Same algorithm as studio_signing.oci.tree_digest and tools/build-registry.mjs.
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function treeDigest(files: Record<string, string>) {
  const h = createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${sha(files[rel]!)}\n`);
  return `sha256:${h.digest("hex")}`;
}

const FILES = { "plugin.yaml": "id: acme.x\nversion: 0.1.0\n", "ui/contributions.json": '{"panels":[]}', "README.md": "# x\n" };
const pkg = (files = FILES, served: Record<string, string> = FILES): PackageFiles => ({
  id: "acme.x",
  version: "0.1.0",
  artifactDigest: "ignored: the browser trusts only the pin",
  hashes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  files: Object.fromEntries(Object.entries(served).map(([k, v]) => [k, Buffer.from(v).toString("base64")])),
});

describe("fetch-and-hash", () => {
  it("computes the same tree digest as the server", async () => {
    expect(await treeDigestOfHashes(pkg().hashes)).toBe(treeDigest(FILES));
    expect(await treeDigestOfHashes({ ...pkg().hashes, "node_modules/x.js": sha("x") })).toBe(treeDigest(FILES));
  });

  it("accepts bytes that match the pin", async () => {
    const r = await verifyPackage(pkg(), treeDigest(FILES));
    expect(r).toEqual({ ok: true, files: FILES });
  });

  it("refuses a tampered byte, a different tree, or no pin, with a reason", async () => {
    const tampered = await verifyPackage(pkg(FILES, { ...FILES, "ui/contributions.json": '{"panels":[1]}' }), treeDigest(FILES));
    expect(tampered).toMatchObject({ ok: false, reason: "ui/contributions.json doesn't match its hash" });
    const swapped = await verifyPackage(pkg({ ...FILES, "README.md": "# evil\n" }), treeDigest(FILES));
    expect(swapped).toMatchObject({ ok: false, reason: "package tree digest isn't the pinned one", expected: treeDigest(FILES) });
    expect(await verifyPackage(pkg(), undefined)).toMatchObject({ ok: false });
  });
});
