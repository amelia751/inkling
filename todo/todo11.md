# Live boot: describe a Studio, see it immediately, work while it takes shape

**Goal.** A researcher says "Create a chest X-ray Studio with five classification labels". Within
seconds a usable workspace appears, and it keeps gaining capability as the agent configures it. No one
configures modules, datasets, viewers or labels by hand.

Our advantage isn't supporting every agent protocol or having the most sophisticated pipeline. It's
making complicated data feel simple.

**Status (2026-10-31).** Plan amended after review.

- **Milestone 1 can start now.** In progress on `todo11-shell`.
- **Milestone 2** starts after Milestone 1's measurements land. **Server side (`todo11-boot`) done
  early, in parallel, and merged** (it touches nothing in Milestone 1's files; the D4 guardrails item
  is still open). Its client side (`todo11-live`) has not started. See the ✅ notes in Milestone 2.
- **Milestone 3** follows.
- **Milestone 4** (external agents) is deliberately later and only outlined.

Decisions are settled in §2 (approved, modified, simplified or deferred). Agents: start at "Start here
(agents)".

**Audit date:** 2026-10-31, against `main` 235b9fe (todo10 merged).

**Three projects, kept apart:**

1. **Make the Studio load fast and update live** (Milestone 1, plus Milestone 2's client side).
   Essential.
2. **Let agents create and modify Studios** (Milestone 2). Essential.
3. **Ingest at scale and open up to external agents** (Milestones 3–4). They matter, but they don't
   block 1 and 2.

---

## Start here (agents)

This file plus `AGENTS.md` is the whole brief.

1. **Read, in order:**
   1. `AGENTS.md`;
   2. this file: §0 (audit), §1 principles, §2 decisions, your milestone in §4, §6 (ownership,
      contracts, rules), §7 budgets;
   3. `docs/agent.md`, `docs/modules.md`, `docs/deployment-gcp.md`;
   4. the files in your workstream's row in §6.
2. **Set up:** `git worktree add .worktrees/todo11-<name> -b todo11-<name> main`. Work only there;
   never merge, never edit this file (report instead).
3. **The data boundary from todo10 still holds** (`todo/todo10.md`, "Start here", point 3): nothing
   an agent reads contains item bytes, and the model never gets bytes back.
4. **Hand back:**
   - done per milestone item against its exit tests;
   - commits, migrations, env vars, events and routes added;
   - the checks run (`AGENTS.md` list plus your e2e);
   - before/after numbers for the §7 metrics you touched;
   - what's left.

**Prompt for each agent:**

> Read `/Users/anhlam/inkling/todo/todo11.md` from "Start here (agents)" and follow it. You are
> workstream `todo11-<name>`. Do every item §6 assigns to you, to its exit tests.

---

## 0. Where we are (audit)

### The in-app agent (`apps/agent`)

- **Runtime.** pi (`@earendil-works/pi-coding-agent`) behind Hono. The default model is
  `openai:gpt-6.1-sol` with thinking set to `low` (`apps/agent/src/config.ts`).
- **Streaming.** A run streams over SSE: `GET /v1/runs/:runId/events`, replayed with `?after=`. Events
  are defined in `packages/agent-protocol/src/index.ts`:
  - `start`, `run-status`, `text`, `reasoning`;
  - `tool-call`, `tool-progress`, `tool-result`;
  - `usage`, `status`;
  - `client-tool`, `approval`, `approval-resolved`;
  - `sandbox`, `artifact`, `error`, `done`.
- **Environment tools are client tools.** `get_environment`, `patch_environment`, `preview_environment`
  and `run_command` execute **in the browser** (`apps/web/src/extension-host/agent.ts`), so they fail
  unless a Studio tab is open: the drawer says "Studio isn't open"
  (`studio/components/ai/agent-drawer.tsx`).
- **The agent can't create a task.** The kernel returns 403 for the agent token on `POST …/tasks`.
- **Every environment session carries the full catalogue.** It's injected into the system prompt
  (`schemas/catalog.md`, about 30 KB, roughly 7–9k tokens) on every new environment session
  (`studio/lib/agent/session.ts`, `extension-host/agent.ts:195`).
- **The web side follows runs with fetch-based SSE** (`studio/lib/agent/client.ts`); the reducer is
  in `studio/stores/agent.ts`. `run-status` is ignored.
- **Progress UI today.** A shimmer "Thinking…" line and per-tool rows. There's no step ledger, and no
  progress for the Studio's own boot.

### How the Studio boots (`apps/web`)

1. **Route:** `/projects/:projectId/studio/:taskId`, rendered by `DatasetStudioPage.tsx`.
2. **Loads:** the task document, the annotations, and `useEnvironment`, which fetches the environment,
   the workspace and remote plugins, then resolves.
3. **Then it waits for every module.** `Promise.all(env.modules.map(registry.preload))` must finish
   before anything renders. Until then the page shows only the "Opening Studio" spinner.
4. **How long it takes.** e2e waits put a cold viewer at about **20–45 s**
   (`environments_test.py`). Nothing measures boot timing.

### Live updates

- **The project event stream.** `GET /v1/projects/:id/events` is SSE served with `EventSource`. The API
  polls its outbox every 250 ms, replays from `Last-Event-ID`, sends keep-alives every 15 s, and
  closes the stream after 300 s.
- **Event types.** `import.updated`, `source.node.inspected`, `proposal.*`, `fs.changed`. There's **no
  environment event**.
- **Outside changes never reach an open Studio.** The environment query is cached with
  `staleTime: Infinity`, so a change made over MCP or in another tab only shows after a reload. The
  in-tab patch (`environment-edits.ts`) re-resolves and **preloads every module again**.
- **New items stay hidden.** The task document is also cached with `staleTime: Infinity`;
  `import.updated` doesn't refresh it, so new items don't appear.
- **Switching items remounts the viewer.** `ViewportHost` uses `key={item.id}`, so the heavy engine
  (Cornerstone, video) is torn down and rebuilt on every switch.

### Ingest

- **Upload path:** the Files drive hashes each file in a worker, then `POST /projects/:id/imports`,
  then sends 64 MB chunks with `PUT /uploads/{session}/files/{id}?offset=`, four at a time. The worker
  inspects each file and makes a thumbnail.
- **Uploads don't become items on their own.** Items come only from files pinned to the task's
  **dataset** (`task_document`, `projects.py:800–854`).
- **One data kind per environment.** A mixed drop of images, videos and DICOM has no single home.
- **Viewers load the whole file per item.** There's no thumbnail-first step, no HTJ2K staging, and no
  shared decode queue.

### MCP (`apps/mcp`)

- **Transport.** stdio only, with `@modelcontextprotocol/sdk` ^1.32.2. It talks to the **Vite dev
  server**, not the API.
- **Tools.** `list_projects` (seed manifest), `catalog`, `list_modules`, `describe_contribution`,
  `list_capabilities`, `inspect_plugin`, `get_environment`, `validate_environment`,
  `patch_environment`, `set_environment`, plus `view_*` and MCP Apps viewers when
  `INKLING_MCP_WORKSPACE` is set.
- **Missing:** no upload, no task creation, no way to find the tab the user is looking at, no auth,
  and no client config committed.
- **Split brain.** Catalogue and validation live only in Vite (`apps/web/dev/seed-server.ts`); the API
  returns **501** for both (`routes/environments.py:133–141`).

### What the research changes (October 2026)

- **MCP's current revision (`2026-07-28`) is stateless.** No sessions, no GET stream, no
  `Last-Event-ID` resumability. Replay and live progress must live in **our** event streams; MCP gets
  idempotent tools, explicit handles, `notifications/progress`, and the Tasks extension for long
  calls.
- **AG-UI 1.0** (frozen 2026-09-18) is the closest standard for agent-to-UI events:
  - `RUN_*`, `STEP_*`, `TEXT_MESSAGE_*`;
  - `TOOL_CALL_START/ARGS/END/RESULT`;
  - `STATE_SNAPSHOT` / `STATE_DELTA` (RFC 6902);
  - `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA`.
- **MCP Apps** (stable 2026-01-26) can render a live card in Claude Desktop and ChatGPT, including
  `tool-input-partial`. Claude Code and Cursor show text only, so for them we return a deep link and
  the **browser** is the live surface.
- **React 19.3** ships `<ViewTransition>` and `<Activity>`. Per-panel Suspense plus preloading chunks
  the moment a module id appears lets the shell paint before the modules arrive.
- **Viewers can reach first paint in 1–2 s with small derivatives made at ingest:**
  - a ThumbHash placeholder and a 256 px thumbnail;
  - a preview at about 1600 px;
  - for DICOM, Cornerstone3D 5.x staged HTJ2K retrieval (Google's Healthcare API transcodes to HTJ2K
    since December 2025);
  - for video, an H.264 faststart proxy with short GOPs, sprite strips, and Mediabunny over WebCodecs;
  - for signals, min/max pyramids.

---

## 1. Principles

1. **A fast native Studio first.** Before any autonomous booting, the Studio a person opens by hand
   must paint its shell immediately and load modules independently.
2. **Create only on explicit intent.** Questions get answers. "Could we…" gets an offer with a
   **Create** button. Only an explicit request, or the user clicking Create, makes a draft task.
3. **Deterministic first paint, model refinement after.** An explicit request maps to a preset
   through a fixed table, and the Studio opens on it. The model then sends a small patch against it.
4. **The server enforces; clients assist.** The API is the authority on authorisation, revisions and
   which mutations are allowed. Shared TypeScript gives fast client feedback, never the final word.
   This matters doubly with medical data.
5. **Nothing reloads.** Environment changes arrive as patches and load only new modules. Items are
   inserted, not re-fetched. Viewers swap data instead of remounting.
6. **Every progress tick is a real event.** A stop keeps the partial work.
7. **Separate "usable" from "fully ingested".** Time to first useful interaction is a product budget.
   Background ingest time depends on bytes, bandwidth, formats and workers, so we track it but don't
   gate on it.
8. **Measure before and after.** Every milestone reports its §7 numbers.

---

## 2. Decisions (settled 2026-10-31)

| | Decision | Verdict | What we do |
|---|---|---|---|
| D1 | Server-side boot | **Approved** | A boot is an API operation that creates **draft** tasks; only a person publishes them. |
| D2 | Shared TypeScript environment core | **Approved, changed** | `packages/environment-core` shares the resolver logic for clients. **The API validates authoritatively** (below). |
| D3 | Project SSE events | **Approved** | Reuse the existing project event stream, with its revision tracking and `Last-Event-ID` replay. |
| D4 | AG-UI protocol v2 | **Deferred, with guardrails** | Keep the working run protocol. Boot progress travels on project events. Three rules (below) keep the run protocol AG-UI-compatible, so a later switch is a mechanical rename. Add an AG-UI adapter when an integration needs it. |
| D5 | Speculative preset boot | **Modified** | Deterministic presets, triggered only by explicit creation intent. No model classifier in the critical path. |
| D6 | Presence and follow-agent | **Simplified** | The tab that asked navigates itself; everything else gets deep links. No presence infrastructure now. |
| D7 | Mixed files create multiple tasks | **Modified** | Group files into compatible collections and **let the user choose** how they become tasks. |
| D8 | Incremental item lifecycle | **Approved** | Items appear as they register and upgrade in place. |
| D9 | Progressive viewers | **Approved in stages** | Images and previews first. DICOM, video and signals are separate later slices. |
| D10 | MCP integration | **Deferred** | Build the shared tool layer now (Milestone 2); external agent workflows come after native boot works (Milestone 4). |

### D2 in detail: what the API enforces

`PUT`/`PATCH` on environments and `POST …/boots` are checked **in the API** for every caller,
including the browser, the agent, a future MCP server and raw HTTP:

1. **Authorisation.** The principal may write this task. The agent token may only touch draft tasks
   it created, or tasks a person opened to it. It may never publish.
2. **Revision.** `revision` (the expected current revision) is required on writes; a stale one gets
   **409**.
3. **Mutation scope.** For agent principals, JSON Patch operations are limited to an allowlist of
   paths: `extends`, `labels`, `layout`, module `config`, `overrides`. Changing `modules` is limited to
   plugins already installed and pinned in the workspace (todo10 lockfile). Anything that would widen
   permissions goes through the existing approval path.
4. **Shape and references.**
   - The patched document must validate against `schemas/environment.v1.json`.
   - Every referenced preset, module, renderer, tool and panel must exist in `schemas/catalog.json`
     or an installed plugin's pinned contributions.
   - The API does this in Python from the generated schema and catalogue.
5. **Conformance.** A shared fixture set (`packages/environment-core/fixtures/`) runs against both the
   TypeScript core and the API. If they disagree, the build fails. If resolve-level rules (`extends`
   merge, overrides) ever need server enforcement beyond this, add a small Node validation service
   rather than duplicating the resolver.

### D4 in detail: staying AG-UI-compatible without migrating

AG-UI 1.0 covers only the agent's **run** stream (`packages/agent-protocol`, `GET /v1/runs/:id/events`).
The project event stream (`environment.updated`, `boot.*`, `item.*`) is ours and isn't governed by it.
Three rules, owned by `todo11-boot`:

1. **New run events follow AG-UI's shape and meaning.**
   - Any event added to `packages/agent-protocol` from now on must match an AG-UI 1.0 event's
     semantics, with an AG-UI-style name.
   - First case: streaming `boot_studio` arguments (Milestone 2) uses the start / args-delta / end
     triple. The args are **string fragments** the consumer concatenates (AG-UI `TOOL_CALL_ARGS`),
     never pre-parsed partial objects.
   - Events with no AG-UI equivalent go under one `custom` envelope `{name, value}`, as AG-UI's
     `CUSTOM` does, rather than as new top-level types.
2. **A mapping table and a test that enforces it.** `packages/agent-protocol/src/ag-ui-map.ts`
   exports the table below as data. A unit test asserts:
   - every event type in the protocol union has an entry;
   - every target name exists in the AG-UI 1.0 schema, which is vendored as a fixture from
     https://docs.ag-ui.com/spec/1.0/schema.

   Adding an event without a mapping fails the build.
3. **`reduce()` stays the only consumer.** The web app reads run events only through `reduce()` in
   `apps/web/src/studio/stores/agent.ts`. Components read the reduced message parts, never raw
   events. A lint or grep check in the web tests fails if another file imports the event types for
   anything other than typing.

Current mapping (verify names against the vendored schema when writing the test):

| Our event | AG-UI 1.0 |
|---|---|
| `start` | `RUN_STARTED` |
| `text` | `TEXT_MESSAGE_CONTENT` (`TEXT_MESSAGE_START`/`END` are implied at message boundaries) |
| `reasoning` | `REASONING_MESSAGE_CONTENT` (`REASONING_*`) |
| `tool-call` | `TOOL_CALL_START` |
| *(new)* tool args delta | `TOOL_CALL_ARGS` |
| `tool-result` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` |
| `tool-progress` | `ACTIVITY_DELTA` |
| `status` | `ACTIVITY_SNAPSHOT` |
| `error` | `RUN_ERROR` |
| `done` | `RUN_FINISHED` (or `RUN_ERROR` when the status is failed) |
| `run-status` | `CUSTOM` `run-status` |
| `usage` | `CUSTOM` `usage` |
| `client-tool` | `CUSTOM` `client-tool` |
| `approval`, `approval-resolved` | `CUSTOM` `approval`, `approval-resolved` |
| `sandbox` | `CUSTOM` `sandbox` |
| `artifact` | `CUSTOM` `artifact` |

When an integration needs real AG-UI, add `GET /v1/runs/:id/events?format=ag-ui`. It translates
with this table on the server; the web app keeps using `reduce()`.

### D5 in detail: what counts as creation intent

| Message | Behaviour |
|---|---|
| "Can you explain what pneumothorax means?" | Answer. No boot. |
| "Could we make a chest X-ray Studio?" | The model replies with a **Create X-ray Studio** button (a card). Clicking it is the explicit intent. |
| "Create a chest X-ray Studio with five classification labels." | The model calls `boot_studio`. The boot starts **when the call starts**, from the preset table; the labels arrive as the refinement patch. |
| The user clicks **New Studio** or types `/studio chest x-ray` | Explicit; boots immediately from the table, no model turn needed for the first paint. |

The preset table (`registry/presets/intents.json`, data, not code) maps terms and file kinds to a
preset (x-ray, radiograph, CXR → `preset:image-2d`; CT, MRI → `preset:volume-3d`; ECG, EKG →
`preset:ecg`; video → `preset:video`; …). A model-based classifier is a later option, measured
against this table first.

---

## 3. The experience

**In-app chat:** "Create a chest X-ray Studio with five classification labels".

| t | User sees | Under the hood |
|---|---|---|
| ~0.2 s | The message lands; the thread shows "Thinking…" | Existing run stream |
| first model tokens | A **boot card** appears: "Setting up your Studio", shimmering | The model calls `boot_studio`; at call start the harness calls `POST …/boots` with the table's preset |
| + < 2 s | The tab navigates (SPA, view transition) to the draft task; the Studio chrome is there with a skeleton viewport, items rail and labels | `boot.started`; the shell renders from the preset; modules load independently |
| + 2–10 s | The viewer paints the first item from its preview; thumbnails fill in | Milestone 1 shell; Milestone 3 previews where available |
| + 5–20 s | Labels appear; the card ticks "Added 5 labels", "Tuned layout" | Refinement patch, validated by the API, arrives as `environment.updated` |
| ≤ 60 s | The card collapses to "Studio ready · 14 s · Undo · Publish" | `boot.ready`; revision recorded with its author |

If the user isn't on that tab (another tab, or the boot came from elsewhere), the boot card and the
Studio list show a deep link instead.

**Boot card / ledger.**
- **Header:** one line, shimmering while active (`role="status"`, `aria-live="polite"`, static
  under `prefers-reduced-motion`).
- **Rows:** expandable, fixed height, with states pending, active, done and failed.
- **Content:** artefacts are named, not tool ids.
- **Stop** keeps what's built.
- **Sources:** it's fed by project `boot.*` events, so it also works for boots the model didn't
  start, such as the New Studio button.

---

## 4. Milestones

### Milestone 1: fast Studio shell (`todo11-shell`)

The native Studio, opened by hand, should feel instant. Nothing here involves agents.

1. **Instrument.**
   - `performance.mark` at route enter, environment fetched, resolved, shell painted, each module
     loaded, first viewport frame and first item thumbnail.
   - A dev overlay plus a script that prints the timeline per preset: `image-2d`, `video`,
     `volume-3d`, `ecg`, `pathology`.
   - Record today's numbers in §7 **before** changing anything.
2. **Remove the boot gate.** `useEnvironment` (`DatasetStudioPage.tsx`) stops waiting on
   `Promise.all(env.modules.map(registry.preload))`. The shell renders once the environment
   resolves. Each viewport, panel and inspector suspends on its own module behind a layout-matched
   skeleton, so one slow or broken module doesn't block the others.
3. **Load in priority order.** Start the viewer module for the first item first, then visible panels,
   then the rest. Add `modulepreload` for the preset's viewer chunk on route enter.
4. **Stop remounting on item switch** for `image2d`. Engines take `setItem` instead of
   `key={item.id}`. Other engines follow in their Milestone 3 slices.
5. **Live in-tab apply.** `environment-edits.ts` diffs resolved modules and preloads only new ones,
   then `setEnv` inside `startTransition`.
6. **Exit:**
   - shell painted under 1.5 s warm and under 3 s cold for every preset (local);
   - first viewport frame for `image-2d` under 3 s cold;
   - a deliberately broken panel module leaves the viewport working;
   - item switching in `image2d` keeps one engine instance;
   - every existing e2e passes, with the same `data-testid`s.

### Milestone 2: server-side boot and live updates (`todo11-boot`, `todo11-live`)

A user can create a Studio from chat without opening the Studio first.

**Server (`todo11-boot`):**

1. `packages/environment-core`: a pure TypeScript resolver and validator over `schemas/catalog.json`
   and the environment schema. Used by `apps/web`, the Vite seed server (ending the 501 split brain)
   and `apps/agent`. It ships the conformance fixtures.
   - ✅ **Done (todo11-boot), validator part:**
     - `checkWrite` covers: the JSON Patch (all ops or none), the agent scope, shape against
       `environment.v1.json` with its id enums removed, and references.
     - References are checked against the schema's enums, or against an installed plugin, matched
       by the `<pluginId>.` prefix.
     - `reference-slots.json` is one table, read by both TypeScript and Python. It says where an
       environment names a contribution, and which paths an agent may patch.
     - `fixtures/cases.json` has 28 cases; the bundled presets validate.
   - ⏳ **Not yet:**
     - Moving the resolver itself (`extends` merge, overrides) into the package.
     - Switching `apps/web` and the Vite seed server (`dev/seed-server.ts`) over to it. Both are
       under `apps/web`, next to Milestone 1's files, so they wait for `todo11-shell` to merge.
     - `boundaries` already allows extension-host and shell to import it.
2. **API enforcement (D2):**
   - required `revision` on writes, 409 on stale;
   - the agent mutation-scope allowlist;
   - schema and reference checks in Python;
   - the conformance test against the fixtures.
   - ✅ **Done.** The checks live in `kernel/environment_policy.py` and run from
     `routes/environments.py` on every PUT and PATCH, for every caller:
     - **Revision:** a missing `revision` gets 422 (no more "last writer wins"); a stale one gets
       409.
     - **Who may write (D2.1):** an agent may write only the drafts booted for the same person, or
       the task the person had open when they minted its token. That task is stored in the new
       `session_delegations.task_id`, set by `POST /v1/sessions` from `X-Workspace-Id`.
     - **Scope (D2.3):** agents may patch `/title`, `/description`, `/task`, `/extends`,
       `/labels`, `/layout`, `/overrides`, `/studio` and `/viewports/<i>/config`. They may change
       `/modules/<id>` only for installed plugins, and may never PUT. Anything else gets 403.
     - **Shape and references:** errors get 422.
     - **Validate and catalogue:** `POST /api/environments/validate`, `GET /api/catalog` and
       `GET /api/catalog/schema` are now answered by the API (they returned 501).
       `/api/catalog/capabilities` and `/api/catalog/plugins/…` still need the dev server.
     - **Tests:** `test_environment_conformance.py` runs the same fixtures as the vitest suite.
     - **Approval:** the person-side approval path for permission-widening changes is unchanged
       (installs still go through plugin approval).
3. `POST /api/v1/projects/:id/boots {bootId, preset, patch?, files?, folders?, name?}`:
   - idempotent on `bootId`;
   - creates a **draft** task, links the given files or folders into its dataset, writes the
     environment, emits `boot.started`, `boot.step` and `boot.ready|failed`;
   - draft tasks get a `draft` state with a person-only `publish`;
   - the agent token is allowed on the boot routes, within D2's scope.
   - ✅ **Done.** The code is in `kernel/boots.py` and `routes/boots.py`.
     - **Ordering:** everything is validated before anything is created, so a refused boot leaves
       nothing behind.
     - **Revisions:** revision 1 is the preset and revision 2 is the refinement patch, so Undo
       reverts only the model's part.
     - **Replays:** replaying a `bootId` returns the same boot; reusing it with a different body
       gets 409.
     - **Failures:** a crash after validation is recorded as a `failed` boot plus `boot.failed`,
       in its own transaction.
     - **Reading back:** `GET /api/v1/boots/:id`.
     - **Publishing:** `POST /api/v1/tasks/:id/publish` is person-only. It isn't in
       `AGENT_ROUTES`, and the kernel refuses agents as well.
     - **Agent routes:** `AGENT_ROUTES` now includes the boot routes and `GET /api/v1/tasks/:id`;
       `docs/deployment-gcp.md` is updated.
     - **Migration:** `0008_todo11_boot_drafts_and_boots`, on head `0006b`, adds:
       - `tasks.state`, `boot_id`, `booted_by`, `published_by`, `published_at`;
       - a `boots` table;
       - `session_delegations.task_id`.
     - **Task fields:** `task_dict` now carries `state` and `bootId`.
     - **Ledger labels** name artefacts: "Created draft “X-ray Studio”", "Linked 2 files", "Set up
       from preset:image-2d", "Added 5 labels".
4. Project events (D3): `environment.updated {taskId, revision, patch?, author}` on every environment
   write, plus `boot.*`, on the existing stream with replay.
   - ✅ **Done.**
     - `studio_defs.save_revision` publishes `environment.updated` in the write's own
       transaction. Every write path goes through it: PUT, PATCH, boots, rollback, restore.
     - Payload: `{taskId, revision, author, authorKind, contentHash, parentHash, runId?, patch?}`.
     - `patch` is present for PATCH writes up to 64 KB; it's absent for PUT or rollback, where the
       client refetches.
     - The `boot.*` and `environment.updated` types are added to `PROJECT_EVENTS`, so they flow
       on `GET /v1/projects/:id/events` with `Last-Event-ID` replay.
5. `packages/studio-tools`, the shared tool layer (D10's "now" part): schemas plus an HTTP client for
   - `boot_studio({projectId, preset?, intent?, patch?, files?, folders?, name?, bootId})`;
   - `patch_studio({taskId, patch, revision})`;
   - `get_studio_state({taskId})`;
   - `search_catalog({query, detail})`.
   - ✅ **Done.** The package exports:
     - TypeBox schemas, and `STUDIO_TOOLS` in a fixed order (plus `offer_studio`);
     - `StudioClient`, whose errors are typed `StudioApiError {status, errors[], current}`;
     - framework-neutral `createStudioHandlers`, ready for MCP to reuse in Milestone 4;
     - `resolveIntent` and `isCreationIntent` (`none | offer | create`; no model);
     - `searchCatalog` and `compactPresetIndex`;
     - `deriveBootId`.

     It imports only `typebox`. 47 unit tests.
6. `apps/agent`:
   - register these as **server** tools (so no open Studio is needed);
   - the harness calls the boot route as soon as `boot_studio` starts (preset from the call, or from
     the intent table if absent);
   - the card tool for "Create X-ray Studio?" offers;
   - a `boot` profile prompt (explicit intent only, small patches);
   - replace the injected 30 KB catalogue with a compact preset index plus `search_catalog`;
   - give the system prompt and tool list a stable order for prompt caching;
   - the D4 guardrails: `ag-ui-map.ts` and its test; streamed `boot_studio` args, if pi exposes them,
     as the start / args-delta / end triple; new non-AG-UI events under the `custom` envelope.
   - ✅ **Done.**
     - **Registration:** `tools/studio.ts` registers the server tools on `assistant`,
       `environment-designer` and `coder`.
     - **Boot:** `boot_studio` posts the boot route as soon as it executes. Its `bootId` comes
       from run id + tool call id, so a retry is idempotent.
     - **Creation gate (D5):** the policy lets `boot_studio` run only when the person's own words
       are an explicit "create". Otherwise it soft-denies and steers the model to `offer_studio`.
       Side effect: a bare "yes, do it" after an offer is refused, which is one of the open
       points below.
     - **Offer card:** `offer_studio` is a server tool that creates nothing; todo11-live renders
       it.
     - **Prompt:** the `boot` profile is a prompt file, `prompts/boot.md`, added to those
       profiles. A new `ProfileName` would break the web's `Record<ProfileName,…>`.
     - **Catalogue:** the request's `catalogPrompt` is accepted but no longer injected. Instead
       the prompt gets a ~3.3 KB preset and module index from `schemas/catalog.json`, plus
       `search_catalog`.
     - **Order:** prompt parts and the tool list are in a fixed order; a test checks two sessions
       are byte-identical.
     - **Intent table:** it lives at **`registry/intents.json`**, not `registry/presets/`. The web
       globs `registry/presets/*.json` as presets.
     - **Env vars:** `INKLING_AGENT_CATALOG_FILE` and `INKLING_AGENT_INTENTS_FILE`.
     - **Dockerfile:** it now copies `registry/intents.json`.
     - ⏳ **D4 guardrails** (added on `main` after this work started): not done yet.

**Client (`todo11-live`):**

7. **Subscribe to project events in the Studio.**
   - `environment.updated` applies the patch, or refetches when the patch is missing or its
     revision is out of order. It loads only new modules, inside `startTransition`; the shell
     regions are wrapped in `<ViewTransition>`.
   - The environment query loses `staleTime: Infinity` in favour of event-driven updates.
8. **Navigation (D6).**
   - The tab whose chat started the boot navigates itself (SPA, view transition) on `boot.started`.
   - Otherwise, a deep link in the card, in the Studio list ("Draft · Publish") and in a toast.
9. **Boot card** in the thread and a compact top-bar pill while a boot runs. New test ids:
   `boot-card`, `boot-step`, `boot-pill`.
10. **Entry points:** a **New Studio** button and a `/studio <words>` command, both on the same boot
    route. Handle `run-status` in the agent reducer.
11. **Exit:**
    - an e2e with a scripted model: "Create a chest X-ray Studio with five classification labels"
      typed in the Overview drawer (no Studio open) navigates without a full page load, paints the
      shell under 2 s after the boot starts, shows the 5 labels and `boot.ready` under 20 s;
    - an environment `PATCH` via curl updates an open tab within 500 ms, with no reload;
    - API tests: an agent token can't publish, can't add an uninstalled module, and a stale
      `revision` gets 409;
    - conformance fixtures pass on both sides;
    - the AG-UI mapping test passes, and adding an unmapped event type fails it;
    - no web file other than the agent store consumes raw run events;
    - "explain pneumothorax" boots nothing;
    - input tokens per boot are down at least 70% against today, measured from `usage` events.
    - **Server-side exit status (todo11-boot):**
      - ✅ Agent token can't publish (403), can't add an uninstalled module (403), and a stale
        `revision` gets 409 (`apps/api/tests/test_boots.py`).
      - ✅ Conformance fixtures pass on both sides.
      - ✅ "Explain pneumothorax" boots nothing: `isCreationIntent` returns `none` and the policy
        gate refuses `boot_studio`.
      - ⚠️ **Tokens: −41%, not −70%.** These are characters of the environment-designer system
        prompt plus tool schemas, divided by 4 for tokens. The faux model's `usage` leaves out
        the system prompt and tools, so it can't measure this.
        - Total: 52,182 → 30,660 chars (~13.0k → ~7.7k tokens).
        - The catalogue part alone went from ~31.4k chars to ~8.9k (−72%).
        - What's left is mostly the browser's client-tool specs (~9.8k, owned by the web), project
          tools (~5.9k) and `base.md` (~3.1k).
        - To reach 70%:
          - the web stops sending the `list_modules` and `describe_contribution` client tools
            that `search_catalog` now covers;
          - expose project and file tools lazily;
          - shorten `base.md`.
      - ⏳ The navigation and 500 ms live-update e2e tests depend on `todo11-live`.
    - **todo11-boot open points (for the integrator):**
      - **Creation gate:** a bare "yes, create it", sent after an `offer_studio` card, is refused.
        The click on the card should call the boot route directly; that's `todo11-live`.
      - **Plugin ids:** an installed plugin's contributions count as valid by the `<pluginId>.`
        prefix, not by checking its pinned list of contributions.
      - **Environment writes and roles:** env writes don't yet require `write` role for a
        `viewer` member. That was the behaviour before too.
      - **Boot timing:** boots run synchronously inside the request (milliseconds), so
        `boot.started` arrives after the task exists.

### Milestone 3: progressive data ingestion (`todo11-ingest`), in slices

Time to first useful interaction matters here. Completing the whole ingest does not gate the Studio.

**Slice A: images (ships first).**

1. Item lifecycle (D8): the worker emits `item.registered|uploaded|probed|thumb_ready|preview_ready|ready|failed`.
   Derivatives: ThumbHash, a 256 px WebP thumbnail and a ~1600 px preview. The client posts its
   visible item ids and the worker serves those first.
2. `GET /api/v1/tasks/:id/items?after=<cursor>` plus `item.*` events replace task-document refetches.
   The items rail inserts at `registered`:
   - TanStack Virtual with stable ids;
   - skeletons sized by aspect ratio;
   - a "N new" pill when the user isn't at the end.
3. `image2d` paints the preview, then upgrades to full in place.
4. **Collections (D7).** When dropped files span kinds, the boot (or the Files drop) groups them into
   compatible collections (images, DICOM series by Series UID, videos, ECG records), then shows a
   card: "120 X-rays, 60 videos, 20 ECGs. Create one Studio per group? / Pick which to include /
   Put compatible ones together". Nothing is created until the user chooses. Default: one draft per
   group.
5. **Exit:**
   - an e2e drops 200 synthetic images: the first skeleton within 300 ms of `registered`, the first
     thumbnail painted within 500 ms of `thumb_ready`, the first item viewable before the batch
     finishes;
   - zero full page loads;
   - one engine instance across 20 switches;
   - background completion time recorded, not gated.

**Slice B: DICOM.** Series grouping, rendered thumbnails, Cornerstone3D staged HTJ2K retrieval when
served by DICOMweb (Google's Healthcare API in `spurby-phi`), an image load pool with priorities
(Interaction > Thumbnail > Prefetch), and no remount in the MPR viewer. Its own exit tests.

**Slice C: video.** Poster plus ThumbHash, a faststart H.264 proxy (GOP ≤ 0.5 s), sprite strips with
a VTT index, Mediabunny for frame-accurate seeking, and no remount. Its own exit tests.

**Slice D: signals.** Min/max pyramids, a zoom-level picker, and uPlot or WebGL by density. Its own
exit tests.

### Milestone 4: external agents (later; outline only)

Start when native boot (Milestone 2) is in daily use. Build only what real usage asks for:

- `apps/mcp` on `packages/studio-tools` (the same tools), aimed at spec `2026-07-28`, with
  `notifications/progress` and `resource_link` results;
- `add_files` from local paths, acting as the user with a personal dev token, refused in production
  until todo9's sign-in lands;
- session discovery (`find_sessions`) and general tab presence, if deep links prove insufficient;
- an MCP Apps boot card for Claude Desktop and ChatGPT;
- an AG-UI adapter for the run stream, if an integration needs it.

Write a todo12 for this when it starts.

---

## 5. Not now

- **AG-UI migration of the run protocol** (D4: the guardrails keep it compatible; an adapter comes
  later, if needed).
- **A model-based intent classifier in the critical path** (D5).
- **Tab presence infrastructure** (D6).
- **Automatically creating multiple tasks from a mixed drop without asking** (D7).
- **DICOM, video and signal optimisation as launch dependencies** (D9: separate slices).
- **The MCP server, external upload, MCP Apps** (D10: Milestone 4).
- **Client-side validation as a security boundary** (D2).
- **Multi-kind environments; WebSockets or WebTransport; relying on progressive JPEG XL or AVIF
  decode; letting the agent publish tasks or widen permissions.**

---

## 6. Workstreams

| Branch | Milestone | Owns | Must not touch |
|---|---|---|---|
| `todo11-shell` | 1 | boot instrumentation, `useEnvironment` / `DatasetStudioPage.tsx` boot gate, per-panel Suspense and skeletons, module priority, `environment-edits.ts` diffed preload, `image2d` engine `setItem` | API, agent, worker, other plugins' engines |
| `todo11-boot` ✅ (merged; D4 guardrails pending) | 2 (server) | `packages/environment-core` (+ fixtures), API enforcement and the conformance test, `POST …/boots`, draft tasks and publish, `environment.updated` / `boot.*` emission, `packages/studio-tools`, `packages/agent-protocol` additions + `ag-ui-map.ts` (D4), agent server tools, intent table, `boot` profile, compact catalogue, Vite seed server switch | `apps/web/src/studio/**` (beyond consuming environment-core), worker, `apps/mcp` |
| `todo11-live` | 2 (client) | Studio subscription to project events, live apply with view transitions, self-navigation and deep links, boot card and pill, New Studio button and `/studio`, `run-status` in the reducer | API internals, agent tools, viewer engines |
| `todo11-ingest` | 3 | worker derivatives and `item.*`, `GET …/items?after=`, visible-items priority, the items rail, collections card, viewer engines per slice | Studio shell boot path, boot route internals |

Milestone 1 runs alone first. `todo11-boot` and `todo11-live` run in parallel once Milestone 1 merges
(`todo11-live` can begin against the event contract immediately). `todo11-ingest` starts with Slice A
after Milestone 2's events land.

**Contracts** (names fixed; change only through the integrator):

- `environment.updated {taskId, revision, patch?: Operation[], author}`.
- `boot.started {bootId, taskIds[], preset, initiator: {kind: "person"|"agent", runId?}}`, used by
  the initiating tab to self-navigate (matched by `runId`).
- `boot.step {bootId, step, state, label, artefact?}`.
- `boot.ready {bootId, taskIds[], ms}`.
- `boot.failed {bootId, step, message}`.
- `item.registered|uploaded|probed|thumb_ready|preview_ready|ready|failed {taskId?, itemId, nodeId, kind, meta?}`.
- `POST /api/v1/projects/:id/boots {bootId, preset, patch?, files?, folders?, name?}` returns
  `202 {bootId, taskIds}`; 403 outside the agent scope, 409 on stale revision, 422 on validation
  errors (same error shape as environment `PATCH`).
- `packages/studio-tools` exports the four tool schemas and the HTTP client.
- **Run events:** every type in `packages/agent-protocol` has an entry in `ag-ui-map.ts`. New types
  follow AG-UI semantics or use the `custom` envelope (D4). `todo11-live` reads them only through
  `reduce()`.

**Rules** (as todo10 §11):
- branch slug in Alembic filenames;
- never merge, never edit this file;
- no Spurby renames (use `NAMING`);
- synthetic fixtures only;
- the `AGENTS.md` checks plus your exit tests before handing back.

**Merge order:** `todo11-shell` → `todo11-boot` → `todo11-live` → `todo11-ingest` (slice by slice).
After each merge, run the full checks and the boot timeline script.

---

## 7. Budgets

Two kinds, kept separate.

**Time to first useful interaction** (product budgets, gated in e2e):

| Moment | Target | Today |
|---|---|---|
| Studio route to shell painted (warm / cold) | < 1.5 s / < 3 s | TBD (Milestone 1 step 1) |
| Route to first viewport frame, `image-2d` cold | < 3 s | ~20–45 s implied by e2e waits; to measure |
| Explicit request to boot card visible | < 300 ms after the `boot_studio` call starts | n/a |
| Boot start to shell painted on the draft | < 2 s | n/a |
| Explicit request to usable preset (scripted model) | < 20 s | n/a |
| Agent setup complete (real model) | < 60 s | n/a |
| Item `registered` to skeleton; `thumb_ready` to thumbnail | < 300 ms; < 500 ms | n/a |
| First item viewable while a batch is still uploading | yes | no |

**Background ingest** (tracked, reported, **not** gates):

- bytes per second end to end;
- per-format time from `uploaded` to `ready`;
- worker queue depth;
- time to all `ready` for the 200-file fixture.

These depend on total bytes, bandwidth, formats, decode cost and workers, so a slow 200-file batch
never blocks declaring the Studio usable.

**Tokens:** input tokens per in-app boot down at least 70% against today (`usage` events).
**Measured by todo11-boot:** environment-designer prompt plus tools went from 52,182 to 30,660
chars (−41%). The catalogue portion went from ~31.4k to ~8.9k chars (−72%). See Milestone 2,
"Server-side exit status".

---

## 8. References

- **AG-UI 1.0:** https://docs.ag-ui.com/spec/1.0/schema; state events: https://docs.ag-ui.com/spec/1.0/events/state
- **MCP `2026-07-28`:** https://modelcontextprotocol.io/specification/2026-07-28/changelog; progress:
  https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress; Tasks:
  https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks
- **MCP Apps:** https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- **Anthropic:** advanced tool use (tool search) https://www.anthropic.com/research/advanced-tool-use;
  code execution with MCP https://www.anthropic.com/research/code-execution-with-mcp
- **OpenAI:** Responses streaming https://developers.openai.com/api/docs/guides/streaming-responses;
  ChatKit progress https://openai.github.io/chatkit-python/guides/update-client-during-response/
- **Vercel AI SDK stream protocol:** https://ai-sdk.dev/v6/docs/ai-sdk-ui/stream-protocol
- **Ledger patterns:** https://agentic-ux.com/patterns/progress-ledger; shimmer: https://ui.shadcn.com/docs/utils/shimmer
- **React:** `<ViewTransition>` https://react.dev/reference/react/ViewTransition; `<Activity>`
  https://react.dev/reference/react/Activity
- **SSE behind proxies:** https://www.server-sent-events.com/sse-protocol-fundamentals-architecture/proxy-and-cdn-configuration-for-sse/
- **Cornerstone3D progressive loading:** https://www.cornerstonejs.org/docs/concepts/progressive-loading/stackprogressive/;
  volumes: https://cornerstonejs.org/docs/concepts/progressive-loading/volumeprogressive/
- **OHIF interleaved HTJ2K:** https://github.com/OHIF/Viewers/pull/4276
- **Google Healthcare API DICOM (HTJ2K transcoding):** https://docs.cloud.google.com/healthcare-api/docs/dicom
- **Media and images:** ThumbHash https://evanw.github.io/thumbhash/; Mediabunny https://mediabunny.dev/api/VideoSampleSink;
  uPlot https://leeoniya.github.io/uPlot/
- **Lists and ingest:** TanStack Virtual https://tanstack.com/virtual/latest/docs/api/virtualizer; Uppy 5
  https://uppy.io/blog/uppy-5.0/; hash-wasm https://www.npmjs.com/package/hash-wasm
