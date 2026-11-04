import * as z from "zod";

/**
 * `oss-evaluation.v1` (todo23 D6, W3): the record the open-source scout writes for every
 * candidate package it considers, stored with the plugin or kit that uses it. It holds the
 * evidence from the static gate (licence and transitive licences, OpenSSF Scorecard, OSV
 * advisories, release and maintainer signals), the decision and why, and optionally the result
 * of a trial install in a quarantined sandbox.
 *
 * Every value comes from public registry metadata APIs; nothing here is read from a README or
 * from customer data. `decision`: `picked` passed the gate, `amber` passed with `conditions`
 * that must be honoured (attribution, rate limits, a single maintainer…), `refused` hit the red
 * list or couldn't be checked.
 */

export const OSS_ECOSYSTEMS = ["npm", "pypi"] as const;
export const OssEcosystem = z.enum(OSS_ECOSYSTEMS);
export type OssEcosystem = z.infer<typeof OssEcosystem>;

export const OSS_DECISIONS = ["picked", "refused", "amber"] as const;
export const OssDecision = z.enum(OSS_DECISIONS);
export type OssDecision = z.infer<typeof OssDecision>;

const Name = z.string().min(1).max(214);
const Url = z.string().url().max(2048);
const IsoDate = z.string().max(40);

export const OssAdvisory = z
  .object({
    id: z.string().max(80),
    summary: z.string().max(500).optional(),
    severity: z.string().max(40).optional(),
    url: Url.optional(),
  })
  .strict();
export type OssAdvisory = z.infer<typeof OssAdvisory>;

/** A dependency in the resolved graph with its licence (deps.dev), direct or transitive. */
export const OssDependencyLicence = z
  .object({
    package: Name,
    version: z.string().max(80).optional(),
    licences: z.array(z.string().max(200)),
    relation: z.enum(["direct", "indirect"]).optional(),
  })
  .strict();
export type OssDependencyLicence = z.infer<typeof OssDependencyLicence>;

export const OssTrialStep = z
  .object({
    command: z.string().max(2000),
    exitCode: z.number().int(),
    ms: z.number().nonnegative(),
    /** False: the step failed and was rolled back (not part of the recorded recipe). */
    kept: z.boolean(),
    output: z.string().max(4000).optional(),
  })
  .strict();
export type OssTrialStep = z.infer<typeof OssTrialStep>;

export const OssTrialResult = z
  .object({
    status: z.enum(["pass", "fail", "refused", "budget-exceeded"]),
    steps: z.array(OssTrialStep),
    smoke: z.object({ command: z.string().max(2000), exitCode: z.number().int(), ms: z.number().nonnegative(), output: z.string().max(4000).optional() }).strict().optional(),
    totalMs: z.number().nonnegative(),
    /** Installed size in bytes, when the sandbox could measure it. */
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Daytona snapshot of the working state, for a blocked sandbox to start from. */
    snapshotId: z.string().max(200).optional(),
    reason: z.string().max(1000).optional(),
  })
  .strict();
export type OssTrialResult = z.infer<typeof OssTrialResult>;

export const OssEvaluation = z
  .object({
    schema: z.literal("oss-evaluation.v1"),
    package: Name,
    ecosystem: OssEcosystem,
    version: z.string().min(1).max(80),
    /** SPDX expression of the package itself; `unknown` when no source declares one. */
    licence: z.string().max(200),
    /** Licences found across the resolved dependency graph (direct and transitive). */
    transitiveLicences: z.array(OssDependencyLicence),
    /** OpenSSF Scorecard aggregate, 0–10; absent when the repo isn't scored. */
    scorecard: z.number().min(0).max(10).optional(),
    advisories: z.array(OssAdvisory),
    lastRelease: IsoDate.optional(),
    maintainers: z.number().int().nonnegative().optional(),
    repository: Url.optional(),
    decision: OssDecision,
    /** Amber conditions the user of the package must honour (recorded, not enforced here). */
    conditions: z.array(z.string().max(500)),
    /** Why the decision was made: red-list hits, advisories, missing evidence. */
    reasons: z.array(z.string().max(500)),
    /** The API URLs the evidence was read from. */
    evidence: z.array(Url),
    evaluatedAt: IsoDate,
    trial: OssTrialResult.optional(),
  })
  .strict();
export type OssEvaluation = z.infer<typeof OssEvaluation>;
