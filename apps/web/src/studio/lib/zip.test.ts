import { describe, expect, it } from "vitest";
import { crc32, zipStore } from "./zip";

describe("zipStore", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes local headers, a central directory and an end record", () => {
    const z = zipStore([{ path: "a/x.txt", data: new TextEncoder().encode("hi") }, { path: "manifest.json", data: new TextEncoder().encode("{}") }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    expect(new TextDecoder().decode(z.slice(30, 37))).toBe("a/x.txt");
  });
});
