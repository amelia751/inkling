import * as z from "zod";

/**
 * Capability `image.segment` (docs/plugins.md §6.1). Provider-independent request and
 * result: every segmentation provider (hosted, self-hosted, mock) is normalised into this
 * shape before anything is committed, so switching providers never changes stored masks.
 *
 * Coordinates are image pixels of the asset at full resolution, origin top-left, x right,
 * y down. Boxes are XYXY (`[x0, y0, x1, y1]`, x0 < x1, y0 < y1). Masks are binary and are
 * either COCO-style uncompressed RLE in column-major order or an artifact-backed PNG.
 */
export const CAPABILITY_ID = "image.segment";

export const PointPrompt = z
  .object({ type: z.literal("point"), x: z.number(), y: z.number(), positive: z.boolean().default(true) })
  .strict();
export const BoxPrompt = z
  .object({ type: z.literal("box"), box: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("XYXY pixels") })
  .strict()
  .refine((p) => p.box[0] < p.box[2] && p.box[1] < p.box[3], "box must be XYXY with x0 < x1 and y0 < y1");
export const TextPrompt = z.object({ type: z.literal("text"), text: z.string().min(1).max(500) }).strict();
export const Prompt = z.union([PointPrompt, BoxPrompt, TextPrompt]);

export const SegmentRequest = z
  .object({
    asset_id: z.string().min(1).describe("Kernel asset id (or seed path in dev)"),
    /** Provider id; the workspace's configured default when omitted. */
    provider: z.string().optional(),
    prompts: z.array(Prompt).max(64).default([]),
    /** Label to give the resulting annotations (else the provider's label, else none). */
    label: z.string().optional(),
    /** Item the annotations belong to (defaults to the asset's item). */
    item_id: z.string().optional(),
  })
  .strict()
  .meta({ id: "SegmentRequest" });

export const RleMask = z
  .object({
    encoding: z.literal("rle"),
    /** [height, width] */
    size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    /** Alternating run lengths starting with background, column-major (COCO uncompressed RLE). */
    counts: z.array(z.number().int().nonnegative()),
  })
  .strict()
  .refine((m) => m.counts.reduce((a, b) => a + b, 0) === m.size[0] * m.size[1], "RLE counts must sum to height × width");
export const ArtifactMask = z
  .object({ encoding: z.literal("artifact-png"), artifact_id: z.string().min(1), size: z.tuple([z.number().int().positive(), z.number().int().positive()]) })
  .strict();
export const Mask = z.union([RleMask, ArtifactMask]);

export const MaskInstance = z
  .object({
    instance_id: z.string().min(1),
    mask: Mask,
    box_xyxy: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    label: z.string().optional(),
    /** Only when the provider returns one; never invented (§6.1). */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .meta({ id: "MaskInstance" });

export const SegmentResult = z
  .object({
    instances: z.array(MaskInstance),
    provider: z.string(),
    model: z.string(),
    status: z.enum(["completed", "partial"]).default("completed"),
  })
  .strict()
  .meta({ id: "SegmentResult" });

export type SegmentRequest = z.infer<typeof SegmentRequest>;
export type SegmentResult = z.infer<typeof SegmentResult>;
export type MaskInstance = z.infer<typeof MaskInstance>;
export type Mask = z.infer<typeof Mask>;

/** Decode a column-major RLE into a row-major 0/1 array (height × width). */
export function decodeRle(m: z.infer<typeof RleMask>): Uint8Array {
  const [h, w] = m.size;
  const out = new Uint8Array(h * w);
  let i = 0, v = 0;
  for (const run of m.counts) {
    for (let k = 0; k < run; k++, i++) if (v) out[(i % h) * w + Math.floor(i / h)] = 1;
    v ^= 1;
  }
  return out;
}

/** Encode a row-major 0/1 array (height × width) as column-major RLE. */
export function encodeRle(bits: ArrayLike<number>, h: number, w: number): z.infer<typeof RleMask> {
  const counts: number[] = [];
  let v = 0, run = 0;
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const b = bits[y * w + x] ? 1 : 0;
      if (b !== v) {
        counts.push(run);
        run = 0;
        v = b;
      }
      run++;
    }
  counts.push(run);
  return { encoding: "rle", size: [h, w], counts };
}
