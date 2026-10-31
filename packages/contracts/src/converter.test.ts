import { describe, expect, it } from "vitest";
import { ConversionSummary, ConverterManifest, ConverterOutput, converterAccepts } from "./converter";

const manifest = {
  id: "acme.metaimage",
  version: "0.1.0",
  title: "MetaImage to NIfTI",
  description: "Reads .mha / .mhd volumes and writes .nii.gz",
  accepts: { ext: [".mha"], headerContains: ["ObjectType"] },
  produces: "assets",
  output: { mediaType: "application/x-nifti", ext: ".nii.gz", preset: "preset:volume-3d" },
  runtime: { kind: "python", entrypoint: "metaimage.convert:convert" },
};

describe("converter contract", () => {
  it("parses a manifest and fills defaults", () => {
    const m = ConverterManifest.parse(manifest);
    expect(m.limits).toEqual({ timeoutS: 120, memoryMb: 1024, maxOutputMb: 512 });
    expect(m.accepts.mediaTypes).toEqual([]);
  });

  it("is strict: unknown fields and bad runtimes are errors", () => {
    expect(ConverterManifest.safeParse({ ...manifest, network: true }).success).toBe(false);
    expect(ConverterManifest.safeParse({ ...manifest, runtime: { kind: "shell", cmd: "curl" } }).success).toBe(false);
    expect(ConverterManifest.safeParse({ ...manifest, runtime: { kind: "wasm", module: "../escape.wasm" } }).success).toBe(false);
    expect(ConverterManifest.safeParse({ ...manifest, accepts: {} }).success).toBe(false);
  });

  it("validates outputs by shape", () => {
    expect(ConverterOutput.safeParse({ shape: "assets", assets: [{ path: "vol.nii.gz", mediaType: "application/x-nifti" }] }).success).toBe(true);
    expect(ConverterOutput.safeParse({ shape: "zarr", store: "a.zarr", arrays: [{ path: "0", shape: [4, 4], dtype: "uint8", chunks: [4, 4] }] }).success).toBe(true);
    expect(ConverterOutput.safeParse({ shape: "assets", assets: [{ path: "/etc/passwd", mediaType: "text/plain" }] }).success).toBe(false);
    expect(ConverterOutput.safeParse({ shape: "zarr", store: "a.zarr", arrays: [] }).success).toBe(false);
  });

  it("summaries carry no free text", () => {
    expect(ConversionSummary.safeParse({ ok: false, converter: { id: "acme.metaimage", version: "0.1.0", runtime: "python" }, error: "crash", durationMs: 3 }).success).toBe(true);
    expect(ConversionSummary.safeParse({ ok: false, converter: { id: "acme.metaimage", version: "0.1.0", runtime: "python" }, error: "crash", message: "Patient: Jane", durationMs: 3 }).success).toBe(false);
  });

  it("matches files by extension, then magic bytes", () => {
    const m = ConverterManifest.parse({ ...manifest, accepts: { ext: [".mha"], magic: [{ offset: 0, hex: "4f626a" }] } });
    expect(converterAccepts(m, { name: "scan.MHA" })).toBe(true);
    expect(converterAccepts(m, { name: "scan.mha", head: new TextEncoder().encode("ObjectType = Image") })).toBe(true);
    expect(converterAccepts(m, { name: "scan.mha", head: new Uint8Array([0, 1, 2]) })).toBe(false);
    expect(converterAccepts(m, { name: "scan.nii" })).toBe(false);
  });
});
