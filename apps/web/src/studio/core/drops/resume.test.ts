import { describe, expect, it } from "vitest";
import { splitResume } from "./start";

const f = (relPath: string, bytes = "abc") => ({ relPath, file: new File([bytes], relPath) });

describe("todo18 resume matches by SHA when the server has it", () => {
  const drop = { files: [{ relPath: "a.png", size: 3 }, { relPath: "b.png", size: 3 }] };
  it("a different file of the same size and path starts fresh instead of resuming", () => {
    const a = f("a.png"), b = f("b.png", "xyz"), c = f("c.png");
    const { same, other } = splitResume(drop, [a, b, c], new Map([["a.png", "sha-a"], ["b.png", "sha-b"]]), new Map([[a, "sha-a"], [b, "sha-other"]]));
    expect(same).toEqual([a]);
    expect(other).toEqual([b, c]);
  });
  it("without a server hash, path and size decide", () => {
    const a = f("a.png");
    expect(splitResume(drop, [a], new Map()).same).toEqual([a]);
  });
});
