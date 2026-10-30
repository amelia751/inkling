import type * as z from "zod";
import * as imageSegment from "./image.segment";

/** Capability contracts by id: request and result schemas the gateway validates against. */
export const CAPABILITIES: Record<string, { request: z.ZodType; result: z.ZodType }> = {
  [imageSegment.CAPABILITY_ID]: { request: imageSegment.SegmentRequest, result: imageSegment.SegmentResult },
};

export * as imageSegment from "./image.segment";
