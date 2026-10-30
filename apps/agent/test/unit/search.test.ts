import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFindCommand, buildGrepCommand, sanitizeCount } from "../../src/sandbox/search.ts";
import { NAMING } from "../../src/naming.ts";

const RES = NAMING.resourcePrefix;

describe("sanitizeCount", () => {
  it("rejects NaN/Infinity and floors fractions", () => {
    expect(sanitizeCount(Number.NaN, 100, 1)).toBe(100);
    expect(sanitizeCount(Number.POSITIVE_INFINITY, 100, 1)).toBe(100);
    expect(sanitizeCount(2.9, 100, 1)).toBe(2);
    expect(sanitizeCount(-5, 0, 0)).toBe(0);
    expect(sanitizeCount(undefined, 7, 1)).toBe(7);
  });
});

describe("command lines", () => {
  it("never interpolates unsanitized numbers", () => {
    const cmd = buildGrepCommand({ pattern: "x", limit: Number.NaN, context: Number.POSITIVE_INFINITY });
    expect(cmd).not.toMatch(/NaN|Infinity/);
    expect(cmd).toContain("head -n 100");
  });


  it("path globs match at any depth", () => {
    expect(buildFindCommand({ pattern: "src/*.ts" })).toContain("**/src/*.ts");
    expect(buildFindCommand({ pattern: "*.ts" })).not.toContain("**/*.ts");
  });
});

describe("commands run in a real shell", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RES}-search-`));
  mkdirSync(join(dir, "pkg"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "pkg", "a.py"), "alpha\nneedle here\n");
  writeFileSync(join(dir, "node_modules", "b.py"), "needle hidden\n");
  const run = (cmd: string) => execFileSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8" });

  it("grep finds matches, skips node_modules, and treats no-match as success", () => {
    const out = run(buildGrepCommand({ pattern: "needle" }));
    expect(out).toMatch(/pkg\/a\.py:2:needle here/);
    expect(out).not.toContain("node_modules");
    expect(run(buildGrepCommand({ pattern: "absent-xyz" }))).toBe("");
  });

  it("hostile patterns and globs are data, not shell", () => {
    for (const pattern of ["$(touch pwned1)", "`touch pwned2`", "'; touch pwned3; '"]) {
      run(buildGrepCommand({ pattern, glob: "*$(touch pwned4)" }));
      run(buildFindCommand({ pattern }));
    }
    expect(run("ls")).not.toMatch(/pwned/);
  });

  it("find lists matching files", () => {
    const out = run(buildFindCommand({ pattern: "*.py" }));
    expect(out).toContain("a.py");
    expect(out).not.toContain("node_modules");
  });
});
