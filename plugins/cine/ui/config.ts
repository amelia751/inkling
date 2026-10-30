import * as z from "zod";

/**
 * Renderer config of `inkling.cine.renderers.slice-frame-canvas` (pure data, read by the
 * manifest, the renderer, the inspector, the exporters and inkling.cardiac-metrics).
 * Domain vocabulary (which label is the LV, what ED / ES mean) lives here as config set by
 * a preset, never as code that guesses from label text.
 */
export const CineConfigSchema = z.object({
  structures: z
    .object({
      rv: z.string().optional().describe("Label id of the right-ventricle cavity"),
      myo: z.string().optional().describe("Label id of the myocardium (a contour around an `lv` contour is its outer border)"),
      lv: z.string().optional().describe("Label id of the left-ventricle cavity"),
    })
    .default({})
    .describe("Structure roles → label ids. Drives label-map paint order, areas, completeness and the enclosure rule"),
  keyFrames: z
    .array(z.object({ id: z.string().describe("Stored as attributes.phase, e.g. ED"), label: z.string().describe("Long name, e.g. End-diastole") }))
    .default([])
    .describe("Named key frames (phases) the expert can mark; highlighted in the transport and the slice × frame matrix"),
});

export type CineConfig = z.infer<typeof CineConfigSchema>;
