# Any agent, no mess: project rules, one write pipeline, change requests, outside access

**Goal.** Any agent (the in-house assistant, Cursor or Claude Code over MCP, ChatGPT or Claude.ai
over remote MCP, a script with an API key) can read and change a project, subject to sign-in and
the person's rights, and the project stays as tidy as if one careful person kept it. Bad writes
are rejected with a fix the agent can apply; risky ones wait for a person; what's already stored is
scanned and kept healthy. The server is the only gate: clients, agents and tool hints are untrusted.

**Status (2026-11-02, `main` 2d44b65).** Plan only. Milestones 0 and 1 can start now. Milestone 2
needs todo16 Milestone 1 (Trash for every kind); Milestones 2–4 share todo16's operation catalogue
(`packages/contracts/src/operations.ts`): whichever plan lands first creates the file, the other
extends it.

**Naming.** The product name appears only in `packages/contracts/src/naming.ts`. Env vars are
written without their prefix.

**Prior art.** kiwifs (`~/kiwifs`: one write pipeline for every protocol, `SCHEMA.md` + JSON Schema
rules, lint that rejects errors, `kiwi_context`, janitor), lakeFS and Dolt (protected main, merge
only through checked branches), Kubernetes admission (normalise → validate → persist, dry run,
warn vs deny), OPA/Sentinel/GitHub rulesets (severity levels, evaluate mode, logged overrides),
Hugging Face Hub (validate-yaml before commit, 400 naming the field), Label Studio (annotations must
match the label config; config changes that orphan annotations are blocked), dciodvfy/dcentvfy and
NIfTI QC, MCP authorization (OAuth 2.1, scopes, `insufficient_scope`), Anthropic/OpenAI tool-design
guidance (actionable errors, risk tiers, approvals that fail closed), Stripe idempotency keys.

---

## Start here (agents)

1. Read `AGENTS.md`, this file, `todo/todo16.md` (operation catalogue D7, tiers D8, batches D9),
   `apps/api/src/studio_api/kernel/environment_policy.py` (the model for the pipeline),
   `apps/api/src/studio_api/kernel/structure.py` (agent branch + person accept), `docs/modules.md`.
2. One worktree per workstream: `git worktree add .worktrees/todo17-<name> -b todo17-<name> main`.
3. Test yourself (kernel API, MCP client, browser); the assistant only with the scripted model.
4. No real sample bytes in a sandbox or the model's context: imaging checks run in the worker and
   return findings (codes, counts, field names), never pixel or header values that could hold PHI.

---

## 0. Where we are (audit 2026-11-02)

### Doors into a project

| Door | Today | Checks |
|---|---|---|
| Person in the browser | Cookie (WorkOS) or dev principal | Server: environment policy; browser: full resolver |
| In-house assistant, server tools (`patch_studio`, `boot_studio`) | Delegated session token | Tightest: drafts only, PATCH only, path allow-list (`reference-slots.json`), `revision` required |
| In-house assistant, browser tools (`patch_environment`) | The person's session | Browser resolver, then the person's PUT |
| Cursor / Claude Code via `pnpm mcp` | stdio, local only, optional org API key | Hits `WEB_URL` (web dev server); env + catalogue tools only; `patch_environment`/`set_environment` omit `revision` → always 422 (`apps/mcp/src/main.ts` 126–129); catalogue routes 501 on the API (`routes/environments.py` 164) |
| Scripts with an org API key | Bearer key | As a person: the agent path allow-list doesn't apply (`environment_policy.py` 250) |
| Hosted agents (ChatGPT, Claude.ai) | None | No remote MCP, no MCP OAuth (todo9 deferred it) |

### Gates that exist

| Gate | Where | Effect |
|---|---|---|
| Environment shape (JSON Schema), references to installed contributions, JSON Patch validity, agent path scope, stale revision | API `environment_policy.check_write` (`environment_policy.py` 236–255) | 422 / 403 / 409 |
| Environment resolve-level checks (`extends`, wrong-type, label-target, exporter-unused…) | **Browser only** (`resolve.ts`, `server-entry.ts` 71) | API `validate` doesn't run them (`environments.py` 132–143) |
| `structure.json` schema; agent writes go to `work/agent-*`, person accepts | API (`structure.py` 60–79, 173–192) | 422; branch |
| Annotation commit from plugins (`validate_annotation`) | API (`annotations.py` 101–127) | 422 |
| Proposals: agent creates, person confirms | API (`explore.py`, `projects.py` 994) | 403 for agents |
| Dataset versioning: agents can't approve or merge | `kernel/versioning/service.py` 64 | 403 |
| Plugin stage → checks → approval → activate | `installer.py` | Signed, checked, approved |
| Locked sample nodes; file-name screening | `fs.py` 238; worker `files.screen_names` | Reject; after-the-fact backfill |
| Review rules | Browser review page | Warn only |

### Gaps (how an outside agent makes a mess today)

1. **Bypass:** `PUT /api/v1/workspaces/{id}/environment` stores any JSON with no policy
   (`routes/kernel.py` 260–268).
2. **Half the environment checks are browser-only.** An API client can save an environment the Studio
   can't open.
3. **Studio annotation saves aren't validated** (`PUT /api/annotations/{id}`, `annotations.py`
   130–138): any label string, any geometry, no label-set check. "Pneumonia", "pneumonia" and
   "PNA" all land as different labels.
4. **No project rules.** Nothing declares folder layout, file naming, required dataset metadata or
   the label vocabulary, so nothing can be linted.
5. **No findings, no health.** Nothing re-checks what's stored; review rules only warn in the
   browser.
6. **Errors aren't written for agents.** 422 bodies are shaped per route, one violation at a time,
   with no fix.
7. **No dry run** except environment `validate`.
8. **No branches outside dataset structure and versioning**: an API key writes straight into
   published data.
9. **No context for outside agents**: nothing tells them the conventions before they write.
10. **Outside access is local-only and partly broken** (MCP above); API key scopes don't line up
    with operations (`studio:tools` can't edit environments, `annotations:write` can,
    `api_keys.py` 50–54).
11. **Retries can duplicate.** Idempotency keys exist only for jobs, events and annotation commits.

## 1. Decisions

| # | Decision |
|---|---|
| D1 | **One write pipeline, no other way in.** Every route that changes a project runs `admit(op, input, ctx)`: **normalise** (trim, Unicode NFC, canonical label for a synonym, defaults), **validate** (shape, references, the project's rules), **permit** (role, token scopes, risk tier from todo16 D8, branch rule D7), **persist** (revision check, audit with actor and on-behalf-of, undo journal, findings). It's a FastAPI dependency keyed by the operation id. A test enumerates every mutating route and fails if one doesn't go through `admit` (`pnpm check:writes`), so a bypass can't come back. Imports, workers and plugin jobs use the same pipeline. |
| D2 | **The environment resolver runs on the server too.** Port the resolve-level checks to Python next to `environment_policy.py`, kept identical by shared fixtures (the conformance-test pattern that already exists). `POST /api/environments/validate` and every save run them. The legacy workspace PUT goes through the same checks or is removed. |
| D3 | **Each project has rules** (`rules.v1`): zod in `packages/contracts/src/rules.ts`, emitted to `schemas/rules.v1.json`. Stored per project with history (like environments: `project_rules`, `project_rules_history`), copied into dataset commits as `.studio/rules.json` so every dataset version carries the rules it was made under. Defaults come from the preset (`registry/presets/<id>.json` gets a `rules` section), so domain words stay in presets. People edit them; agents propose changes (a change request, D7). Sections: **labels** (id, name, synonyms, colour, allowed geometries, attribute schema), **layout** (folder patterns, file-name pattern, forbidden characters, max depth), **datasets** (required metadata: modality, license, source, description; one modality per dataset; unique names), **annotations** (inside the image, minimum size, required attributes), **imaging** (which checks run and their severity), **severity overrides** per rule code. |
| D4 | **A catalogue of lint rules.** `packages/contracts/src/lint-rules.ts`: each rule has a stable code (`label.unknown`, `label.synonym`, `geometry.not-allowed`, `annotation.out-of-bounds`, `dataset.name-taken`, `dataset.metadata-missing`, `dataset.mixed-modality`, `layout.misplaced`, `name.pattern`, `name.phi-suspect`, `env.unresolved`, `env.label-drift`, `dicom.series-incomplete`, `dicom.seg-frame-mismatch`, `nifti.orientation-mismatch`, …), what it applies to, a default severity, the fix text, and whether the normaliser can fix it. Severities: **error** (write rejected), **warn** (saved, finding recorded, returned to the caller), **info** (recorded), **off**. Generated into `docs/lint-rules.md`. |
| D5 | **New rules start in evaluate mode.** A rule's first release records findings as if it were enforced but rejects nothing; the Health panel shows "would have rejected N writes". A person (or the next release) promotes it. Changing a rule's severity is a rules edit, so it has history. |
| D6 | **Errors written for the model.** Every rejection is RFC 9457 problem JSON: `{type, title, status: 422, code: "write_rejected", violations: [{rule, severity, path, value, allowed, message, fix, docs}], retryable}`, with **every** violation at once. Warnings come back on success as `findings`. The MCP server returns them as a tool error with the fixes inline. Values that could be PHI (names, header fields) are never echoed, only their path and rule. |
| D7 | **Outside agents change published things through change requests.** A change request is a branch of operations by one actor: drafts and agent-owned scratch apply directly; anything published (datasets with a published Studio, published Studios, the rules, the label set) opens a change request instead. Checks run on open and on every update. **Auto-merge** when every check passes and every operation is tier *write*; otherwise a project owner or editor reviews (diff, findings, who and which agent). Dataset content uses the versioning service's branches and reviews underneath; project-level operations replay at merge with revision checks; if the base moved, checks run again ("needs update" if they now fail). The in-house assistant follows the same rule for published things. |
| D8 | **Dry run everywhere.** Every operation accepts `dryRun=true`: the full pipeline runs, nothing is saved, and the reply is the would-be change plus findings. MCP tools carry `readOnlyHint`, `destructiveHint`, `idempotentHint` from the catalogue, as hints for clients' confirm screens only. |
| D9 | **One context call before writing.** `GET /api/v1/projects/{id}/context`: rules (labels with synonyms, layout, required metadata), open findings by rule, what's published (so the agent knows what needs a change request), recent changes, and a short "how to add data here". The MCP tool `project_context` and resource `studio://projects/{id}/context`; the in-house assistant gets it at session start. |
| D10 | **What's stored is re-checked.** `lint_findings` table (project, resource kind and id, rule, severity, path, message, source `write` or `scan`, first seen, resolved at). A daily `rules.scan` job (worker, like `files.empty_trash`) and a scan on every rules change re-check everything. A **Health** panel on the project Overview shows findings with one-click fixes (fixes for people apply directly; fixes the assistant proposes are change requests). The **gardener** (an assistant mode) works through findings and only opens change requests. |
| D11 | **Imaging checks run where the bytes are.** The worker runs pydicom-based checks (series completeness, missing slices, consistent spacing and orientation; SEG and SR frame of reference matching the source image) and nibabel checks (qform/sform agreement, zero or negative voxel sizes, NaN, grid mismatch against a referenced image). Optional `dciodvfy` in the worker image for full DICOM conformance. They run on import and on export, never block the upload itself, gate merges and exports by severity, and report codes and counts only. |
| D12 | **Outside agents connect remotely, with real scopes.** `apps/mcp` gets the streamable HTTP transport and runs as a stateless service (`studio-mcp`) next to the api; sign-in is MCP OAuth with WorkOS AuthKit as the authorisation server (dynamic client registration, PKCE, tokens bound to the MCP audience). Scopes follow the operation tiers: `project:read`, `project:write`, `project:trash`, `project:destroy` (destroy always returns 202 and an approval link for a person), `rules:propose`. API key scopes are redefined the same way (old names map to new ones). Every write records the actor as `agent:<client name>` on behalf of the signing person. Settings › **Connected agents** lists them with last use, scopes, and Revoke. Per-token rate limits (Redis) and a daily write quota. Local stdio MCP keeps working with an API key. |
| D13 | **Retries are safe.** Every mutating route accepts `Idempotency-Key` (stored 24 h in `idempotency_keys`, same key with a different body → 422, a concurrent duplicate → 409); every update to a versioned resource requires the revision it was based on (409 if stale). The catalogue declares both per operation, and the MCP server and assistant tools always send them. |

## 2. Milestones

### Milestone 0. Close the doors that are open (about 2 days, now)

- [ ] Remove `PUT /api/v1/workspaces/{id}/environment` or route it through `environment_policy`
  (and later D2); callers move to `/api/environments/{id}`.
- [ ] Studio annotation saves (`PUT /api/annotations/{id}`) run `validate_annotation` per item and
  check labels against the Studio's label set (reject unknown labels; synonyms come in D3).
- [ ] MCP: send `revision` on `patch_environment` and `set_environment`; point at the kernel API
  (`STUDIO_URL` defaulting to the api, not the web dev server); use `@studio/studio-tools`'s client;
  serve the catalogue from the API (replace the 501 in `routes/environments.py` 164).
- [ ] API key scopes: an `environments:write` scope, separate from `annotations:write`; keys follow
  the agent path allow-list unless they hold `admin`.
- [ ] Tests for each, plus a failing-then-passing test for the bypass.

### Milestone 1. Rules, the pipeline, lint (about 7 days)

- [ ] `rules.ts` + `schemas/rules.v1.json` (D3); `project_rules` + history tables; routes
  `GET/PUT/PATCH /api/v1/projects/{id}/rules`, `GET …/rules/history`; preset `rules` sections for
  every preset in `registry/presets/`; new projects get their preset's rules.
- [ ] `lint-rules.ts` catalogue (D4) and `docs/lint-rules.md` generated by `pnpm emit:schemas`.
- [ ] `kernel/admission/`: `admit()` with normalise / validate / permit / persist (D1); rule
  families in `kernel/lint/` (labels, layout, datasets, annotations, environment); evaluate mode
  (D5).
- [ ] Server-side resolver checks (D2) with conformance fixtures shared with `resolve.ts`.
- [ ] Problem-JSON errors and `findings` on success (D6), one helper used by every route.
- [ ] `dryRun=true` on every mutating route (D8).
- [ ] `Idempotency-Key` everywhere and revisions on every versioned update (D13).
- [ ] `pnpm check:writes`: every mutating route declares an operation and goes through `admit`.
- [ ] Label rename and merge as operations: renaming a label or merging synonyms rewrites its
  annotations in one batch (undoable); a rules change that would orphan annotations is rejected
  with the count and the merge operation as the fix (as Label Studio does).
- [ ] Tests per rule (good, bad, fixable), the pipeline on each door (browser, assistant, API key,
  MCP), and conformance between TS and Python environment checks.

**Exit:** an API-key client making the gap §0 writes (unknown label, synonym, misplaced file,
dataset without metadata, environment that doesn't resolve) gets every violation with a fix in one
response; dry run shows the same without saving; synonyms are normalised to canonical labels.

### Milestone 2. Change requests and imaging checks (about 6 days, after todo16 Milestone 1)

- [ ] `change_requests` (project, actor, on behalf of, base revisions, operations, state
  `open → checking → passed | failed → merged | closed`, findings) and routes: open, add
  operations, list, get (diff + findings), merge, close (D7).
- [ ] Which operations need a change request: catalogue field `published: "change-request"`;
  `admit` opens one (or appends to the actor's open one) instead of applying.
- [ ] Auto-merge policy per project (`rules.merge.auto: "write-tier" | "never"`), owners and editors
  review the rest.
- [ ] Dataset content through versioning branches and reviews; project operations replay at merge
  with revision checks; "needs update" when the base moved and checks fail.
- [ ] UI: **Changes** in the project nav (open change requests with author and agent, diff, findings,
  Merge / Close, comments); the assistant's chat shows "Opened change request: …".
- [ ] Imaging checks in the worker (D11) on import and export; their findings gate merges and
  exports by severity.
- [ ] Tests: an outside agent's change to a published dataset opens a change request, auto-merges
  when clean, waits when a check fails; a stale base re-checks.

### Milestone 3. Context, health, gardener (about 4 days)

- [ ] `GET …/context` (D9), the MCP tool and resource, and the assistant's session preamble.
- [ ] `lint_findings`, the `rules.scan` job (daily and on rules change), finding resolution when
  a later write or scan clears it (D10).
- [ ] **Health** panel on Overview: counts by severity, findings grouped by rule, one-click fixes,
  "would have rejected" counts for evaluate-mode rules, promote-severity action.
- [ ] Gardener: assistant mode that takes findings and opens change requests; never merges.
- [ ] Empty states: no findings ("This project follows its rules."), no change requests, rules not
  yet customised ("Using the <preset> rules").

### Milestone 4. Outside agents (about 6 days)

- [ ] `apps/mcp` streamable HTTP transport, stateless, `/healthz`, `/readyz`, `/version`; Dockerfile
  and k8s Deployment (`studio-mcp`) in the local kind setup and the GKE overlays (deployed when the
  site comes back, todo15 §8).
- [ ] MCP OAuth with WorkOS AuthKit (protected resource metadata, dynamic client registration,
  PKCE, audience-bound tokens); 401 with `WWW-Authenticate` and the required scope, 403
  `insufficient_scope` for step-up.
- [ ] Scopes (D12) for OAuth tokens and API keys; mapping from old key scopes.
- [ ] MCP tools generated from the operation catalogue with hints, dry run, idempotency keys and
  revisions built in; `project_context` first in the tool list.
- [ ] Actor identity on every write; Settings › Connected agents (list, scopes, last used, revoke);
  per-token rate limit and daily write quota.
- [ ] e2e with a scripted MCP client: connect with OAuth (Emulate), read context, make a bad write,
  get violations, fix, write, open a change request, auto-merge; revoke and get 401.
- [ ] One real outside agent (Claude Code or Cursor against local remote MCP): add a dataset with
  labels, then fix a seeded mess with the gardener; report what it did and any confusing errors.

## 3. Acceptance walk-through

On `pnpm dev`, with `~/Downloads/spurby-sample-data`:

| # | You or an agent | Result |
|---|---|---|
| 1 | Connect Claude Code to the local MCP server, sign in, ask it to set up a chest X-ray project | It calls `project_context` first; the dataset gets modality, license and source; labels use the rules' canonical names |
| 2 | Ask it to add a label "PNA" | Normalised to "pneumonia" (synonym), or, if no synonym exists, rejected with "Labels are normal, pneumonia; add PNA to the rules (change request) or use pneumonia" |
| 3 | Ask it to put files in `misc/stuff` | Rejected or warned per the layout rule, with the folder it should use |
| 4 | Publish the Studio, then ask the agent to change its labels | A change request appears in Changes; checks pass; it auto-merges (or waits, if the project says never) |
| 5 | Import the brain MRI folder with a slice removed | Health shows `dicom.series-incomplete` (or the NIfTI equivalent) on that series; exports warn |
| 6 | Turn on a new rule | Evaluate mode: Health shows "would have rejected 3 writes"; promote it to error |
| 7 | Ask the gardener to tidy the project | Change requests with fixes, none merged without you |
| 8 | Settings › Connected agents › Revoke | The agent's next call gets 401 |
| 9 | Retry the same write with the same idempotency key | One result, no duplicate |

## 4. Out of scope

Org administration by agents (members, keys, billing, security: people only), cross-project rules
and org-wide rule templates (later: rules inherit from an org default), per-label permissions,
FDA/QMS validation records, DICOM conformance certification, agent marketplaces, connector
imports beyond todo16 Milestone 4.

## 5. Config added

| Key | Service | Default | Meaning |
|---|---|---|---|
| `API_IDEMPOTENCY_TTL_HOURS` | api | `24` | How long idempotency keys replay (D13) |
| `API_RULES_SCAN_HOUR` | api, worker | `3` | Hour (UTC) of the daily `rules.scan` (D10) |
| `MCP_PUBLIC_URL` | mcp | — | Public URL of the remote MCP server (OAuth resource) |
| `MCP_RATE_LIMIT_PER_MIN` | mcp | `120` | Calls per token per minute (D12) |
| `MCP_WRITE_QUOTA_PER_DAY` | mcp | `5000` | Writes per token per day (D12) |
