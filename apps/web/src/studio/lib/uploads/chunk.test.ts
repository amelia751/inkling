import { describe, expect, it } from "vitest";
import { KERNEL_MAX_CHUNK_BYTES, UPLOAD_CHUNK_BYTES } from "./chunk";

describe("todo24 D4 upload chunks fit Cloud Run", () => {
  it("the client chunk is below the kernel's (and Cloud Run's) 32 MiB cap", () => {
    expect(UPLOAD_CHUNK_BYTES).toBeLessThan(KERNEL_MAX_CHUNK_BYTES);
    expect(KERNEL_MAX_CHUNK_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
