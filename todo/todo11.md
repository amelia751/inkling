# Live boot: talk to an agent, watch the Studio build itself

**Goal.** Ask the in-app agent ("boot up an environment for chest x-ray"), or point an external agent
at a folder ("Claude, find my session and drop these 200 images and videos in"). The Studio then
builds in front of you:

- something on screen within 2 seconds;
- usable within 20 seconds on seed data;
- done within 60 seconds.

It shows a calm, OpenAI-style progress ledger while it works, and items fill in one by one without
page reloads. The same boot works from:

- our agent (OpenAI today);
- Claude Code or Cursor over MCP, using the user's own model, which saves our tokens;
- later, Claude Desktop or ChatGPT showing a live MCP Apps card.

**Status (2026-10-31).** Research and plan only; nothing started. Decisions D1–D10 need the user's
go-ahead (recommendations given). Agents: start at "Start here (agents)".

**Audit date:** 2026-10-31, against `main` 235b9fe (todo10 merged).

---

## Start here (agents)

This file is the whole brief, together with `AGENTS.md`.

1. **Read, in order:**
   1. `AGENTS.md`;
   2. this file: §0 (where we are), §1 principles, §2 decisions, your workstream's phases in §4,
      and §6 (ownership, contracts, rules);
   3. `docs/agent.md`, `docs/modules.md`, `docs/deployment-gcp.md`;
   4. the files in your workstream's row in §6.
2. **Set up:**
   `git worktree add .worktrees/todo11-<name> -b todo11-<name> main`. Work only there; never merge,
   never edit this file (report instead).
3. **The data boundary from todo10 still holds** (`todo/todo10.md`, "Start here", point 3):
   - nothing an agent reads may contain item bytes; metadata, thumbnails rendered in the *browser*,
     and summaries only;
   - an external agent uploading the user's own files acts **as the user** (like dragging into the
     browser), never with the agent token;
   - the model never gets the bytes back.
4. **Hand back:**
   - done per phase against its exit tests;
   - commits, migrations, env vars, events and routes added;
   - checks run (`AGENTS.md` list plus your e2e);
   - what's left.

**Prompt for each agent:**

> Read `/Users/anhlam/inkling/todo/todo11.md` from "Start here (agents)" and follow it. You are
> workstream `todo11-<name>`. Do every phase §6 assigns to you, to its exit tests.

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

1. **Paint first, refine after.** The shell and skeletons appear before the model finishes, from the
   nearest preset. The model only sends a *diff* against that preset.
2. **The server owns the boot; every surface watches the same events.** A boot is a server-side
   operation. Our agent, MCP, and the browser all observe it through the project event stream. A
   Studio tab never has to be open for a boot to happen, and an open tab always shows it.
3. **Nothing reloads.** Environment changes arrive as patches. Only modules that are new get loaded.
   Items are inserted, never re-fetched wholesale. Viewers swap data instead of remounting.
4. **Every step tick is a real event.** The progress ledger shows only what actually happened, and a
   stop keeps the partial work.
5. **Few, coarse, idempotent tools.** The same five tools serve our agent and MCP. Results are small,
   with links instead of payloads.
6. **One implementation of "what is a valid environment".** Shared TypeScript for web, agent, MCP and
   the seed server; no 501 path.
7. **Measure it.** Boot timing marks in the browser and server; budgets asserted in e2e.

---

## 2. Decisions (recommendations; confirm before Phase 1)

- [ ] **D1. A boot is a server-side operation.** `POST /api/v1/projects/:id/boots` with a
  client-supplied `bootId` (idempotent) creates a **draft task**, writes the environment, links
  data, and emits `boot.*` events. The agent token may create draft tasks; a person publishes them
  (undoable, so this keeps todo10's rule that the model can't widen permissions).
  *Alternative:* keep booting as browser client tools. That needs an open tab, so it's rejected.
- [ ] **D2. `packages/environment-core`.** A pure TypeScript resolver and validator over
  `schemas/catalog.json` and the environment schema (no React, no icons). Used by `apps/web`,
  `apps/agent`, `apps/mcp` and the Vite seed server. The API stays storage plus events; writers
  validate with environment-core before `PUT`/`PATCH` with `revision`.
  *Alternative:* a Python port. That means two implementations, so it's rejected.
- [ ] **D3. The project event stream carries everything the Studio needs.** Add:
  - `environment.updated {taskId, revision, patch?, author}`;
  - `boot.started|step|ready|failed {bootId, taskId, step}`;
  - `item.*` lifecycle events (D8);
  - `presence.*` (D6).

  The Studio applies these whoever caused them (our agent, MCP, another tab). Keep the 250 ms outbox
  poll for now; Postgres `NOTIFY` as a wake-up signal is a later optimisation.
- [ ] **D4. `agent-protocol` v2 uses AG-UI 1.0 event names and shapes.**
  - `RUN_STARTED/FINISHED/ERROR`, `STEP_STARTED/FINISHED`, `TEXT_MESSAGE_*`;
  - `TOOL_CALL_START/ARGS/END/RESULT`;
  - `STATE_SNAPSHOT/DELTA` for the environment being written;
  - `ACTIVITY_*` for the ledger;
  - `CUSTOM` for approvals, client tools and sandbox events.

  The web reducer accepts v1 and v2 during the switch. *Alternative:* extend v1 ad hoc. It's cheaper
  now but diverges from the standard.
- [ ] **D5. Speculative preset boot.**
  - On a new message, the harness classifies intent in under 1 s, using keyword rules plus the kinds
    of the project's files, with a small fast model as fallback.
  - It starts a boot from the nearest `registry/presets/<id>.json` **before** the main model answers.
  - The main model then emits a JSON Patch against it; a wrong guess swaps with a `ViewTransition`.
- [ ] **D6. Presence and "follow the agent".** An open Studio tab heartbeats
  `PUT /api/v1/presence {projectId, taskId, tabId}` every 20 s (Postgres row with a TTL, so services
  stay stateless). `find_sessions` (agent and MCP) lists live tabs with deep links.
  - A tab that started the boot from its own chat **navigates itself** to the new task.
  - Other tabs show a "Studio ready, open it" toast.
  - A per-user "Follow agent" toggle allows auto-navigation for external agents too.
- [ ] **D7. Mixed drops make one task per data kind.**
  - A boot over 200 mixed files groups them by detected kind (x-ray images, videos, DICOM series,
    ECG) and creates one draft task per group, each with its preset.
  - A task switcher shows them as they become ready.
  - Multi-kind environments are a later decision.
- [ ] **D8. Items have a lifecycle and arrive incrementally.**
  - Lifecycle: `registered` (name, size, hash, sniffed kind) → `uploaded` → `probed` (dimensions,
    duration, series UIDs, ThumbHash) → `thumb_ready` → `preview_ready` → `ready` | `failed`.
  - `GET /api/v1/tasks/:id/items?after=<cursor>` plus `item.*` events replace "refetch the task
    document".
  - Items appear at `registered` as skeletons sized from the aspect ratio.
- [ ] **D9. Viewers render progressively and don't remount.** Each viewer starts from the best
  derivative available and upgrades in place:
  - images: ThumbHash, then thumbnail, then preview, then full or tiles;
  - DICOM: HTJ2K stages when served by DICOMweb;
  - video: poster, then the faststart proxy;
  - signals: the pyramid.

  Switching items swaps data inside a live engine; `key={item.id}` goes. Decodes share one priority
  queue (Interaction > Thumbnail > Prefetch).
- [ ] **D10. MCP: the same five coarse tools, dev-only person auth for now.**
  - stdio for Claude Code and Cursor; compatible with spec `2026-07-28` and `2025-11-25`.
  - `add_files` reads **local paths** and uploads through the import API **as the user**, using a
    personal dev token from `pnpm mcp login` or dev trust headers.
  - It is refused when `INKLING_ENV=production` until todo9's OAuth lands. Results carry metadata and
    links only, never bytes.

---

## 3. The experience (what "done" looks like)

**In-app chat:** "boot up an environment for chest x-ray".

| t | User sees | Under the hood |
|---|---|---|
| 0.2 s | The message lands; a ledger appears in the thread: "Setting up your Studio", shimmering | `RUN_STARTED`; boot opened with a `bootId` |
| < 1 s | Ledger row "Chose X-ray template" ticks | D5 classifier picks `preset:image-2d`; `boot.started`; draft task created |
| < 2 s | The page moves to the new task (view transition); Studio chrome with skeleton viewport, items rail and labels | Tab follows `boot.started` (D6); shell renders from the preset; viewer chunk preloading |
| 2–10 s | Skeleton items fill with thumbnails; the viewer paints the first image from its preview | `item.*` events; preview derivative; Cornerstone warmed |
| 5–20 s | Labels panel fills in ("Pneumothorax, Effusion, …"); the ledger ticks "Added labels", "Tuned layout" | Model streams `boot_studio` arguments; each completed field becomes `environment.updated` with a patch |
| ≤ 60 s | Ledger collapses to "Studio ready · 14 s" with an Undo | `boot.ready`; `RUN_FINISHED`; revision recorded with its author (todo10) |

**Claude Code:** "find my Inkling session and drop ~/scans/* in".

1. It calls `find_sessions`, which returns the tab the user has open.
2. It calls `add_files(projectId, paths)`, which streams `notifications/progress` per file. In the
   browser, items appear as they register.
3. It calls `boot_studio({projectId, fromFiles: true})`, which makes one draft task per kind group. The
   open tab gets "3 Studios ready: X-ray (120), Video (60), ECG (20)" and follows the first one.
4. Claude Code prints the deep links. Nothing in the tab reloads.

**Ledger design.**

- **Header:** one line, shimmering while active (shadcn `shimmer` utility, `role="status"`,
  `aria-live="polite"`, no animation under `prefers-reduced-motion`).
- **Rows:** expandable, fixed height. States: pending, active, done, failed, blocked; elapsed time on
  the header.
- **Placement:** the same component appears in the assistant thread and as a compact pill in the
  Studio top bar while a boot runs.
- **Stop** keeps what's been built.
- **Content:** artefacts are named ("Added 7 labels"), not tool ids.

---

## 4. Phases

### Phase 0: measure (all workstreams depend on it; `todo11-protocol` does it first)

1. `performance.mark` at:
   - route enter;
   - environment fetched;
   - resolved;
   - shell painted;
   - first viewport frame;
   - first item thumbnail.

   Also server-side timings per boot step. Results go into a `boot.metrics` event, and the e2e reads
   them.
2. Baseline today's numbers for `image-2d`, `video`, `volume-3d` and `ecg` on seed data; record them in
   §7.
3. **Exit:** a script prints the boot timeline for each preset.

### Phase 1: protocol and events (D3, D4, D6)

1. `packages/agent-protocol` v2 (AG-UI 1.0 names). The agent's projector emits v2, and `/v1/runs/:id/events?v=2`
   serves it. The web reducer accepts both.
2. Project event stream: add `environment.updated`, `boot.*`, `item.*`, `presence.*` (contracts in
   `packages/contracts`, emitted from the API). The stream close interval stays, and replay stays
   `Last-Event-ID`.
3. Presence: a `presence` table with a TTL, `PUT/DELETE /api/v1/presence`, and `GET /api/v1/presence?projectId=`.
   Add it to the agent route allowlist (read only).
4. **Exit:**
   - an environment `PATCH` from curl updates an open Studio tab within 500 ms, with no reload
     (e2e);
   - presence lists an open tab within 1 s and drops it within 60 s of closing.

### Phase 2: boot core (D1, D2, D5)

1. `packages/environment-core`: resolve plus validate over `schemas/catalog.json` and the environment
   schema; shared fixtures prove it agrees with today's web resolver. The Vite seed server and
   `apps/web` use it.
2. `POST /api/v1/projects/:id/boots` (idempotent on `bootId`):
   - creates draft task(s);
   - links files or folders into the task's dataset;
   - writes the environment from a preset, plus an optional patch;
   - emits `boot.*`.

   Draft tasks get a `draft` state that only a person can publish. Allow the agent token on the boot
   routes.
3. Boot steps as data: `template`, `task`, `data`, `labels`, `layout`, `ready`. Each is a
   `boot.step` event carrying the artefact it produced.
4. Speculative classifier in `apps/agent`: keyword rules plus project file kinds, with a fallback to a
   small fast model (`INKLING_AGENT_FAST_MODEL`). It runs on message receipt and calls the boot route
   before the main model turn.
5. **Exit:**
   - `curl` boot of `image-2d` on seed data reaches `boot.ready` in under 3 s server-side;
   - environment-core and the web resolver agree on every preset and every e2e fixture.

### Phase 3: agent tools and token diet (D4, D5)

1. Server-side tools in `apps/agent`, shared with MCP through a small `packages/studio-tools` (HTTP
   client plus schemas):
   - `find_sessions`;
   - `boot_studio({projectId, intent?, preset?, patch?, files?|folders?|fromFiles?, bootId})`;
   - `patch_studio({taskId, patch, revision})`;
   - `get_studio_state({taskId})`;
   - `search_catalog({query, detail: "names"|"summary"|"full"})`.

   The environment client tools stay for in-tab edits; they are no longer needed to boot.
2. Partial arguments:
   - **verify whether pi exposes streamed tool-call arguments.**
   - If it does: parse incrementally (`partial-json`); each newly completed top-level field of
     `boot_studio.patch` becomes an `environment.updated` patch, and a module id is preloaded the
     moment it's complete. Validate only at `TOOL_CALL_END`.
   - If not: the harness applies the patch in field order after the call, so the visual result is
     the same, only later.
3. Token diet:
   - replace the injected 30 KB catalogue with a compact index (preset ids and one-line
     descriptions, ≤ 2k tokens) plus `search_catalog`;
   - put the system prompt and tool list in a stable order for prompt caching;
   - the model writes a diff against the preset, not a full environment.
4. `boot` profile prompt: pick a preset, set the task name, add labels for the stated finding, keep
   the patch small.
5. **Exit:**
   - with a scripted model, "boot up an environment for chest x-ray" from the project Overview (no
     Studio open) ends with a booted draft task and the tab on it, first paint under 2 s and
     `boot.ready` under 20 s;
   - with the real model, under 60 s;
   - input tokens per boot are down at least 70% against Phase 0.

### Phase 4: the live Studio (D3, D6, D9 shell side)

1. **Shell first.** `useEnvironment` no longer waits for every module. The shell renders as soon as
   the environment resolves. Each viewport and panel suspends on its own module with a
   layout-matched skeleton.
2. **Live apply.** On `environment.updated`, diff the resolved modules and preload only new ones,
   then `setEnv` inside `startTransition` (batched per animation frame). Name the shell regions in
   `<ViewTransition>` so a preset swap animates. Use `<Activity mode="hidden">` to pre-render
   predicted panels.
3. **Follow.** On `boot.started` for a boot this tab started, navigate within the SPA with a view
   transition. Otherwise show a toast, or follow if "Follow agent" is on. Draft tasks show a
   "Draft · Publish" chip.
4. **Ledger component** (`BootLedger`) in the thread and the top-bar pill, fed by `boot.*` and
   `ACTIVITY_*`. New `data-testid`s: `boot-ledger`, `boot-step`, `boot-pill`. Keep every existing
   test id.
5. Handle `run-status` in the agent reducer.
6. **Exit:**
   - e2e: a boot started from the Overview drawer shows `boot-ledger`, navigates without a full page
     load (asserted through `performance.getEntriesByType("navigation")` count), and paints the
     shell under 2 s;
   - a preset swap animates and keeps annotations;
   - Lighthouse-style check: no layout shift over 0.1 during the boot.

### Phase 5: progressive items and viewers (D7, D8, D9)

1. **Item lifecycle.**
   - The worker emits `item.*` at each stage.
   - Derivatives:
     - images: ThumbHash, 256 px WebP, ~1600 px preview;
     - video: poster, faststart H.264 proxy (GOP ≤ 0.5 s) and sprite strip with a VTT index;
     - signals: min/max pyramid;
     - DICOM: series grouping by UID, rendered thumbnail.
   - Priority: the client posts its visible item ids (debounced) and the worker serves those first.
2. **Incremental items.** `GET /api/v1/tasks/:id/items?after=` replaces document refetches. The items
   rail inserts at `registered` (TanStack Virtual, stable ids, skeletons sized by aspect ratio, a
   "N new" pill when the user isn't at the end).
3. **Mixed drops (D7).** The boot groups files by kind (DICOM series by Series UID, WFDB by record
   name) and creates one draft task per group. The task switcher shows readiness counts.
4. **Viewers.**
   - image2d: preview first, then full; Cornerstone `imageLoadPoolManager` priorities; HTJ2K staged
     retrieval when the source is DICOMweb.
   - Video: poster, then proxy, with Mediabunny for frame-accurate seeking.
   - ECG: pyramid level per zoom.
   - Remove `key={item.id}` remounts; engines take `setItem`.
5. **Exit:**
   - e2e drops 200 mixed fixtures (synthetic): the first skeleton within 300 ms of `registered`, the
     first thumbnail within 3 s, every item `ready` within the budget in §7;
   - zero full page loads;
   - the viewer engine instance count stays at 1 while switching 20 items;
   - memory stays flat (within 20% after 200 switches).

### Phase 6: MCP for Claude Code and Cursor (D10)

1. **Rebuild `apps/mcp` on `packages/studio-tools`.** Tools: `find_sessions`, `boot_studio`,
   `patch_studio`, `get_studio_state`, `search_catalog`, `add_files`, `open_in_browser`.
   - Every tool has `outputSchema` plus `structuredContent`, and returns `resource_link`s for
     `catalog.md` and `environment.v1.json` rather than inlining them.
   - The tool list is stable and ordered.
   - It talks to the API (no more Vite-only paths) with environment-core for validation.
2. **`add_files(projectId, paths[], bootId?)`.**
   - Recurse folders and hash with BLAKE3.
   - Upload through the import API as the user, with resumable chunks.
   - Send `notifications/progress` per file when the client gave a `progressToken`.
   - Use the Tasks extension when the client supports it.
   - It returns counts and item ids, never bytes.
3. **Auth.**
   - `pnpm mcp login` mints a personal dev token (a person principal, scoped to a workspace, expiring
     in 12 h), stored under `~/.config/<NAMING>/mcp.json`.
   - The server refuses to start with `INKLING_ENV=production`.
   - The agent-token allowlist is unchanged.
4. **Client setup.**
   - A documented `claude mcp add …` line.
   - A `.cursor/mcp.json.example`.
   - `docs/running.md` section "Drive the Studio from Claude Code or Cursor".
5. **MCP Apps card.** `ui://studio/boot` renders the ledger from `tool-input-partial` and boot events
   in Claude Desktop and ChatGPT, with a link to open the real Studio. Claude Code and Cursor get the
   deep link and the open tab does the rest.
6. **Exit:**
   - an MCP stdio client (scripted, `tests/e2e/`) runs find, add 200 files, boot, and the open
     browser tab fills in progressively and follows the first Studio, with no reload;
   - all of it under 60 s on synthetic fixtures;
   - no tool result contains file bytes (asserted).

---

## 5. What we will not do (now)

- **Make MCP our live channel.** MCP is stateless and has no resumability; the browser plus our SSE is
  the live surface.
- **Multi-kind environments.** D7 uses one task per kind instead.
- **WebSockets or WebTransport.** SSE suffices; WebTransport adds UDP and Safari risk.
- **A Python port of the resolver** (D2).
- **Rely on progressive JPEG XL or AVIF decode.** Derivatives are the portable path.
- **Production MCP over HTTP with OAuth.** That stays in todo9.
- **Let the agent publish tasks or widen permissions** (todo10 rule).

---

## 6. Workstreams

| Branch | Phases | Owns | Must not touch |
|---|---|---|---|
| `todo11-protocol` | 0, 1 | `packages/agent-protocol` v2, the agent projector and run SSE (`apps/agent/src/runtime/events.ts`, `http/events.ts`), project event types and emitters in `apps/api` (`kernel/events.py`, `routes/projects.py` stream), presence (table, routes), boot timing marks | agent tools, `apps/mcp`, Studio components beyond the reducer, worker |
| `todo11-boot` | 2, 3 | `packages/environment-core`, `packages/studio-tools`, `POST …/boots` and draft tasks in `apps/api`, the classifier, server tools and `boot` profile in `apps/agent`, the compact catalogue, the Vite seed server switch | run SSE format, Studio shell, worker derivatives, MCP server |
| `todo11-studio` | 4 | `apps/web/src/studio/**` shell (boot gate, live apply, follow, `BootLedger`, top-bar pill, view transitions), `useEnvironment`, `environment-edits.ts`, the agent thread UI | protocol package internals, API, plugins' viewer engines, items rail internals |
| `todo11-ingest` | 5 | worker derivative jobs and `item.*` emission, `GET …/items?after=`, the visible-items priority route, the items rail (virtual list), viewer engines in `plugins/*/ui` and `packages/renderers` (progressive load, no remount) | Studio shell, boot route, MCP |
| `todo11-mcp` | 6 | `apps/mcp` (tools, auth, Apps card), `pnpm mcp login`, client config examples, the `docs/running.md` section | `packages/studio-tools` internals (consume them; ask `todo11-boot` for changes), Studio |

**Contracts between workstreams** (names are fixed; change them only through the integrator):

- **Project events.**
  - `environment.updated {taskId, revision, patch?: Operation[], author}`;
  - `boot.started {bootId, taskIds[], preset}`;
  - `boot.step {bootId, step, state, label, artefact?}`;
  - `boot.ready {bootId, taskIds[], ms}`;
  - `boot.failed {bootId, step, message}`;
  - `item.registered|uploaded|probed|thumb_ready|preview_ready|ready|failed {taskId?, itemId, nodeId, kind, meta?}`;
  - `presence.changed {projectId}`.
- **Boot route:** `POST /api/v1/projects/:id/boots {bootId, intent?, preset?, patch?, files?, folders?, fromFiles?}`
  returns `202 {bootId, taskIds}`.
- **`packages/studio-tools`** exports the five tool schemas and an HTTP client. `apps/agent` and
  `apps/mcp` both import it, plus `add_files` and `open_in_browser`, which only MCP uses.
- **Agent run stream v2:** AG-UI 1.0 event names; `CUSTOM` names `approval`, `client-tool`,
  `sandbox`, `artifact`.

**Rules:** as in todo10 §11:

- branch slugs in Alembic filenames;
- never merge; never edit this file;
- no Spurby renames (use `NAMING`);
- synthetic fixtures only;
- the `AGENTS.md` checks plus your exit tests before handing back.

**Merge order:** `todo11-protocol` → `todo11-boot` → `todo11-studio` → `todo11-ingest` →
`todo11-mcp`. After each merge, run the full checks and the boot timeline script (Phase 0) on
`main`.

---

## 7. Budgets

| Moment | Budget | Measured by |
|---|---|---|
| Message to ledger visible | < 300 ms | `RUN_STARTED` to `boot-ledger` paint |
| Message to shell painted on the new task | < 2 s | `performance.mark` "shell painted" |
| Shell to first viewport frame (seed image) | < 3 s | "first viewport frame" |
| `boot.ready` (scripted model) | < 20 s | `boot.metrics` |
| `boot.ready` (real model) | < 60 s | `boot.metrics` |
| `registered` to item skeleton | < 300 ms | e2e |
| `thumb_ready` to thumbnail painted | < 500 ms | e2e |
| 200 mixed synthetic files all `ready` (local) | < 60 s | e2e |
| Input tokens per in-app boot | −70% against Phase 0 | `usage` events |

Phase 0 fills in today's numbers here: TBD.

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
