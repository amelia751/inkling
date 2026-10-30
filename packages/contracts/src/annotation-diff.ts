import * as z from "zod";
import { RevisionKind } from "./annotation-revision";

/**
 * Plugin-declared diff semantics (todo4 V13): `annotations.diff` in `plugin.yaml`. The Go
 * versioning service can't run plugin code, so a plugin declares, per annotation kind, how
 * to tell "unchanged" from "changed" and which divergent edits conflict. The build extracts
 * the block into `{ plugin, rules }` files that `apps/versioning` validates against
 * `schemas/versioning/annotation-diff-rules.schema.json` and applies generically.
 */

export const DIFF_FIELDS = ["class_id", "geometry", "confidence", "status", "reviewer_id", "attributes", "coordinate_frame", "calibration", "ontology_rev"] as const;
export const DiffField = z.enum(DIFF_FIELDS);

export const AnnotationDiffRule = z
  .object({
    kind: RevisionKind,
    compare_fields: z.array(DiffField).optional(),
    conflict_fields: z.array(DiffField).optional().describe("Divergent edits to these fields conflict; others take the reviewed source."),
    geometry: z
      .object({
        /** `iou` for masks and boxes, `max_vertex_delta_px` for polygons, `abs_delta` for spans and values. */
        metric: z.enum(["iou", "max_vertex_delta_px", "abs_delta", "exact"]),
        threshold: z.number().min(0),
      })
      .strict()
      .refine((g) => g.metric !== "iou" || (g.threshold > 0 && g.threshold <= 1), { message: "iou threshold must be in (0, 1]", path: ["threshold"] }),
  })
  .strict();
export type AnnotationDiffRule = z.infer<typeof AnnotationDiffRule>;

/** `annotations.diff`: at most one rule per kind (the service keys rules by kind). */
export const AnnotationDiffRules = z.array(AnnotationDiffRule).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    if (seen.has(r.kind)) ctx.addIssue({ code: "custom", path: [i, "kind"], message: `more than one diff rule for ${r.kind}` });
    seen.add(r.kind);
  });
});
