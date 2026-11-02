import * as z from "zod";

/** Which key frames (studio.cine `keyFrames` ids) are end-diastole and end-systole. */
export const MetricsConfigSchema = z.object({
  phases: z
    .object({
      ed: z.string().default("ED").describe("Key frame id of end-diastole"),
      es: z.string().default("ES").describe("Key frame id of end-systole"),
    })
    .default({ ed: "ED", es: "ES" }),
});
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
