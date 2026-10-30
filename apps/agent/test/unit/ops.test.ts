import { describe, expect, it } from "vitest";
import { createEditOps, createLsOps, createReadOps, createWriteOps } from "../../src/sandbox/ops.ts";
import { FakeSandbox } from "./fake-sandbox.ts";

describe("sandbox ops", () => {
  it("write → read → edit round-trip goes through the sandbox fs", async () => {
    const sb = new FakeSandbox();
    const write = createWriteOps(sb.asSandbox());
    const read = createReadOps(sb.asSandbox());
    const edit = createEditOps(sb.asSandbox());
    await write.writeFile("/home/daytona/work/a.txt", "hello");
    expect((await read.readFile("/home/daytona/work/a.txt")).toString()).toBe("hello");
    await edit.writeFile("/home/daytona/work/a.txt", "bye");
    expect(sb.files.get("/home/daytona/work/a.txt")?.toString()).toBe("bye");
  });

  it("mkdir and access shell out with quoted paths", async () => {
    const sb = new FakeSandbox();
    await createWriteOps(sb.asSandbox()).mkdir("/home/daytona/work/it's here");
    expect(sb.calls.at(-1)).toBe(`mkdir -p '/home/daytona/work/it'\\''s here'`);
  });

  it("ls on a missing path throws; exists is false", async () => {
    const sb = new FakeSandbox();
    sb.exec = () => ({ exitCode: 1, result: "" });
    const ls = createLsOps(sb.asSandbox());
    expect(await ls.exists("/nope")).toBe(false);
    await expect(ls.stat("/nope")).rejects.toThrow(/Path not found/);
    await expect(ls.readdir("/nope")).rejects.toThrow(/Failed to read directory/);
  });

  it("readdir splits lines and stat reports directories", async () => {
    const sb = new FakeSandbox();
    sb.exec = (cmd) => ({ exitCode: 0, result: cmd.startsWith("ls") ? "a.py\n.hidden\n" : "dir\n" });
    const ls = createLsOps(sb.asSandbox());
    expect(await ls.readdir("/w")).toEqual(["a.py", ".hidden"]);
    expect((await ls.stat("/w")).isDirectory()).toBe(true);
  });

  it("reads recover from a mid-session auto-stop", async () => {
    const sb = new FakeSandbox();
    sb.files.set("/f", Buffer.from("x"));
    sb.state = "stopped";
    expect((await createReadOps(sb.asSandbox()).readFile("/f")).toString()).toBe("x");
    expect(sb.starts).toBe(1);
  });

  it("image detection only accepts known image types", async () => {
    const sb = new FakeSandbox();
    sb.exec = () => ({ exitCode: 0, result: "image/png\n" });
    expect(await createReadOps(sb.asSandbox()).detectImageMimeType!("/a.png")).toBe("image/png");
    sb.exec = () => ({ exitCode: 0, result: "application/dicom\n" });
    expect(await createReadOps(sb.asSandbox()).detectImageMimeType!("/a.dcm")).toBeNull();
  });
});
