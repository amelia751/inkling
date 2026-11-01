import { describe, expect, it } from "vitest";
import { comparable, studioChanges } from "./studio-diff";

const lock = (v: string) => ({ lockfileVersion: 1, plugins: [{ id: "acme.a", version: v, digest: `sha256:${"a".repeat(64)}`, signer: "first-party", permissions: [], configRevision: 0 }] });

describe("studioChanges", () => {
  it("reads as before → after per path", () => {
    const a = comparable({ lockfile: lock("1.0.0"), tasks: { t: { environment: { task: "classification", labels: [{ name: "l", classes: [{ id: "cat" }] }] } } } });
    const b = comparable({ lockfile: lock("1.1.0"), tasks: { t: { environment: { task: "detection", labels: [{ name: "l", classes: [{ id: "cat" }, { id: "dog" }] }] }, readme: "# Notes" } } });
    const ch = studioChanges(a, b);
    expect(ch).toContainEqual({ op: "replace", path: "/plugins/acme.a/version", before: "1.0.0", after: "1.1.0" });
    expect(ch).toContainEqual({ op: "replace", path: "/tasks/t/environment/task", before: "classification", after: "detection" });
    expect(ch).toContainEqual({ op: "add", path: "/tasks/t/environment/labels/0/classes/1", after: { id: "dog" } });
    expect(ch).toContainEqual({ op: "add", path: "/tasks/t/readme", after: "# Notes" });
    expect(studioChanges(a, a)).toEqual([]);
  });

  it("names a removed plugin", () => {
    const ch = studioChanges(comparable({ lockfile: lock("1.0.0"), tasks: {} }), comparable({ lockfile: { plugins: [] }, tasks: {} }));
    expect(ch).toEqual([{ op: "remove", path: "/plugins/acme.a", before: lock("1.0.0").plugins[0] }]);
  });
});
