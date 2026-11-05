---
name: data-boundary
description: Customer-data boundary between spurby-ai, spurby-phi and spurby-data. Use before changing infra/**, apps/agent/src/sandbox/**, apps/agent/src/tools/**, apps/worker/**, apps/api/src/studio_api/routes/**, secrets/**, or anything that moves item bytes.
---

# Customer-data boundary

Read [`deployment-gcp.md`](deployment-gcp.md) first. The invariant: **customer data lives only in `spurby-phi`;
nothing reads it from `spurby-ai`.**

Before handing back a change in these paths, check:

- [ ] No real sample, item bytes or customer file reaches a sandbox (Daytona or any `SandboxProvider`)
  or the model's context. The agent gets fingerprints, synthetic fixtures, fixed-schema verify
  reports, typed probe answers and job summaries only.
- [ ] No raw exception text, stack-frame values or free-text annotation fields go back to the agent
  unfiltered.
- [ ] Job summaries suppress small counts.
- [ ] Sandbox egress stays closed; no secrets passed into sandboxes (`envVars`).
- [ ] No new route callable from `spurby-ai` into `spurby-phi` without saying so in the hand-back, and
  updating the ingress list in `deployment-gcp.md`.
- [ ] Nothing copies data from `spurby-phi` to `spurby-data` except the de-identified release path.
- [ ] Plugin code that runs on real data runs in the worker (gVisor node pool, no egress, read-only
  input) or the browser sandbox, never in a build sandbox.
- [ ] Dev and staging use synthetic data only.
- [ ] No account emails, organization or billing IDs in committed files (they live in
  `secrets/gcp.local.md`).
- [ ] Secrets files are loaded into the process that needs them, never printed into the
  conversation, a log or a span.
