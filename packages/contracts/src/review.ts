import { z } from "zod";

/**
 * Review findings (`review.v1`, todo23 D11, W9). Written by the `reviewer` and `red-team` agent
 * profiles (a principal and model family distinct from the builder's) and stored by the kernel
 * per artifact version (`artifact_reviews`). Promotion and preview Keep need a `pass` row.
 * Emitted to `schemas/review.v1.json`; the kernel validates POSTed reviews against it.
 */
export const REVIEW_VERDICTS = ["pass", "block", "needs-person"] as const;
export const ReviewVerdict = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const REVIEW_SEVERITIES = ["blocker", "major", "minor", "info"] as const;
export const ReviewSeverity = z.enum(REVIEW_SEVERITIES);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

/** What was reviewed: one version of a plugin, preview, recipe… */
export const ArtifactRef = z.object({
  kind: z.string().min(1).describe("Artifact kind: plugin, preview, recipe…"),
  id: z.string().min(1),
  version: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const ReviewFinding = z.object({
  severity: ReviewSeverity,
  class: z.string().min(1).describe("Problem class, e.g. hidden-network, off-token-colour, fixture-overfit, licence, storage-read, runtime-escape, main-thread-stall, cross-renderer"),
  file: z.string().nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  claim: z.string().min(1).describe("What is wrong, in one or two sentences"),
  test: z.string().nullable().default(null).describe("Hidden adversarial test that demonstrates it (a hidden-tests path), or null"),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const Review = z.object({
  schema: z.literal("review.v1").default("review.v1"),
  artifact: ArtifactRef,
  reviewer: z.string().min(1).describe("Reviewer principal; never the artifact's author"),
  model: z.string().min(1).describe("provider:model-id of the reviewing model (or a rules engine id)"),
  verdict: ReviewVerdict,
  findings: z.array(ReviewFinding).default([]),
  createdAt: z.string().describe("ISO 8601 timestamp"),
});
export type Review = z.infer<typeof Review>;

/** A `pass` verdict can't carry a blocker. */
export function reviewConsistent(r: Review): boolean {
  return r.verdict !== "pass" || !r.findings.some((f) => f.severity === "blocker");
}
