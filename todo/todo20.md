# A project works like a Codex project: name it, chat in it, drop files, one Studio

**Goal.** One mental model, no parallel paths:

1. You **create a project** (a name).
2. Inside it the **chat is always open**. A project has a list of chats, kept on the server.
3. You **drop files into the chat** (or anywhere in the project). They upload into this project,
   never into another one.
4. They show up in **the project's Studio**: one Studio per project by default, every file in
   it, each opened by its own viewer. More Studios exist only when someone asks for one.

**Status (2026-11-02, `main` 733d751).** Plan only. Built from the tester's session (screenshot:
the Studio picker in `prj-e46d49e0373441be` lists eight Studios, and the one open is an
image-only "Annotate" with 12 of 35 files), database records and code reads. todo19's
server side is correct. `tests/e2e/mixed_drop_test.py` passes 11/11: a fresh mixed drop gives
one Studio that accepts six kinds. What confuses people is everything *around* it.

**Already fixed (uncommitted, 2026-11-02):** chat landing folders were named `Chat Nov 2, 19:32`.
Since todo19 composes the presets' rules, `:` is forbidden, so every later drop into that chat
was refused ("The path contains forbidden characters" ×35). The fix is in
`kernel/drops.py` (`landing_folder` takes the project's forbidden characters; the default name
uses `19.32`) and `kernel/imports.py`, with a test in `apps/api/tests/test_drops.py`. Ten
existing dev folders were renamed (backup `/tmp/api.db.bak-colon`). Commit it with W1.

---

## 0. What happened, root causes

| # | What the tester saw | Root cause (evidence) |
|---|---|---|
| R1 | **An image-only "Annotate" Studio (12 items) opened after dropping 35 mixed files, twice.** | A second, older Studio-making flow (todo8) still runs beside the drop plan. After each import's inspection, `kernel/explore.py` `build_proposals` (~470–497) proposes a dataset for **only the most common kind** (`_main_kind`: 12 images), preset `image-2d`, task "Annotate". The Overview card `ImportResult` (`app/routes/ProjectOverviewPage.tsx` ~296–323) shows it as "Looks like 12 images · **Create dataset & set up the task**". Clicking it made `ds-a0152…`/`tsk-03cd…` (17:11) and `ds-c36e…`/`tsk-716f…` (17:28), both published, with no boot. The Explore page offers the same thing. |
| R2 | **Dropping the same 35 files again did nothing visible.** The chat said "Read dropped files · 0 files, your upload is still starting". | The bytes were already in the project, so the plan is one `link_existing` action. No dataset and no Studio, and nobody says so (`drop_plans` row of `drp-0d92…`: `applied.tasks = []`). The assistant read the drop before it settled and reported "0 files". |
| R3 | **The picker lists eight Studios: six per-kind ones from the 14:32 drop, then "Annotate", "Annotate".** | The per-kind Studios predate todo19 and were kept on purpose (todo19 D5). "Combine into one Studio" was never built. The picker (`components/layout/switchers.tsx` ~187) shows every task, including empty drafts, under the heading **"Tasks"**, next to "Task setup…". The words Studio, Task and Annotate are used for one thing. |
| R4 | **"The chat isn't contained to its project."** | A Home drop with any existing project asks "**Add to <your last project>?**" (`app/entry/HomeComposer.tsx` 99, 135–165), so new files land in an old project. Each project has **one** conversation, created in the browser (`stores/agent.ts` 383–389, `conversations[projectId]`). The visible thread lives in **localStorage only** (zustand `persist`). The agent server stores sessions and transcripts (`apps/agent/src/store/migrations.ts`), but the web never lists them. The assistant drawer is global, with one run per tab across projects (`agent.ts` 392). There's no chat list, a reload on another browser loses the thread, and "New chat" (`reset`) drops the old one. |
| R5 | **A refused drop stays "uploading" forever,** and its error card repeats one sentence 35 times. | `drp-047d…` is still `uploading`. A rejected import never moves its drop to `failed`. The card joins per-file findings instead of grouping identical ones. |
| R6 | The BraTS `_seg` is its own item in the Studio. | todo19 D6 (slots) isn't built. The e2e test asserts the seg is a `mask` item of the same task. |
| R7 | The API hung after a code change (dev). | `uvicorn --reload` waits forever for open event streams (SSE) to close (`apps/api/package.json` `dev`). |

---

## 1. Decisions

| # | Decision |
|---|---|
| D1 | **A project is created first and explicitly.** Home is "your projects" plus **New project** (a name, prefilled from a dropped folder's name when you drop on Home). A Home drop **always creates a new project**. The "Add to your last project?" dialog goes. Inside a project, every drop (chat, Studio canvas, Files) goes into **that** project. |
| D2 | **Chats belong to a project and live on the server.** Conversation = agent session (`agent_sessions.project_id` already exists): one id, `conv-…` retired. A project page has a chat list (newest first, titled from the first message) and the chat panel is **always open** (it can be collapsed, never absent). "New chat" makes another session and keeps the old one listed. The thread is rebuilt from the server (transcript + run events), and localStorage is only a cache. The drawer shows only the current project's chats. A run in project A doesn't block project B. |
| D3 | **There is one way a drop becomes Studio items: the drop plan.** Delete the dataset proposal from `explore.build_proposals` and the Overview card `ImportResult`, and remove dataset proposals from the Explore page. Table relationship and label-mapping proposals stay: they *enrich* the Studio (labels from a CSV) instead of creating one. Old `dataset` proposals still `proposed` are dismissed by migration. |
| D4 | **A project has one default Studio, and drops add to it.** The first drop creates it ("Studio", accepting every kind). Later drops **add their items to it** (same task, the dataset gains a commit) instead of creating Studio #2. The fast path opens it on the first ready new item. A drop made inside an open Studio adds to that Studio. More Studios only come from "New Studio from these items" (Files, a filter, the assistant). `kernel/drops_plan.py` `apply` (370) has two outcomes: `new_default_studio` or `add_to_studio(task_id)`. |
| D5 | **Re-dropping known files is never silent.** An all-duplicate drop links the existing nodes into the default Studio if they aren't in it. Chat and toast say "These 35 files are already in this project · Open in Studio". A partly duplicate drop says "12 new, 23 already here". The assistant waits for the drop to settle (`ready`, `failed` or `duplicate`) before it reports. |
| D6 | **One word: Studio.** The picker heading becomes "Studios". "Task setup…" becomes "Studio settings…". Default names are "Studio", then "<filter or purpose> Studio", never "Annotate". The picker hides drafts that have no items, and an applied drop never leaves a draft behind. |
| D7 | **Clean up existing projects once.** Kernel migration: in every project, the per-kind Studios a single drop booted (`boot_id` like `drop-<drp>-col-*`) with **no annotations** are combined into one default Studio (accepts = union), and the rest go to the **Trash** (one trash batch per project, restorable). Studios with annotations are left alone and get a "Combine into the project Studio" action (todo19 §2 B P2). Image-only "Annotate" Studios made from dataset proposals with no annotations go to the Trash the same way. |
| D8 | **A drop always ends in a state.** `ready`, `partly ready (n failed)`, `duplicate` or `failed (reason)`. A refused import fails its drop at once. Findings are grouped by rule ("35 files: the folder name has `:`, renamed automatically" / "…refused"), never one line per file. |
| D9 | **A mask is a slot of its subject** (todo19 D6, masks only now). In the item list a subject with a `_seg` is one item, and its mask loads as the reference layer. Full hanging protocols stay in todo19 M4. |
| D10 | **The dev API restarts in seconds:** `uvicorn … --reload --timeout-graceful-shutdown 3`. |

---

## 2. Work

Paths are relative to the repo root; the web is under `apps/web/src/studio/`.

### W1 Stop the second Studio path (D3, D6), first, small

- [ ] Commit the landing-folder fix (above).
- [ ] `apps/api/src/studio_api/kernel/explore.py`: drop the `dataset` proposal from `build_proposals`. Keep relationship and mapping. Fix the tests that expect it (`rg -l '"dataset"' apps/api/tests | xargs rg -l proposal`).
- [ ] `app/routes/ProjectOverviewPage.tsx`: delete `ImportResult`. The Overview's "latest import" card links to the Studio (or the drop's card) instead.
- [ ] `app/routes/ExplorePage.tsx`: no dataset or task column for proposals. Relationships and mappings stay.
- [ ] Migration `0028`: `dataset` proposals with status `proposed` → `dismissed` (reason `superseded`).
- [ ] `components/layout/switchers.tsx`: heading "Studios", "Studio settings…", hide drafts with no items. Rename "Task setup" in the page title and breadcrumb too (keep `data-testid`s).
- [ ] `core/datasets/NewDatasetDialog.tsx`: the default Studio name is "Studio". With no preset chosen, it accepts every kind in the picked folders (todo19 profiles), not a single preset.

### W2 One default Studio per project (D4, D5, D7)

- [ ] `kernel/drops_plan.py` `apply`: if the project has a default Studio (new column `projects.default_task_id`, migration `0028`), add the drop's nodes to its dataset and task. If not, boot it and record it. `link_existing` follows the same rule (D5).
- [ ] `kernel/boots.py`: a boot can target an existing task (`add_to_task`) instead of creating one.
- [ ] `kernel/drops.py` `summary`: a `duplicate` state and a `new / already here` count.
- [ ] `core/drops/PlanCard.tsx` and the chat drop card: "Added 35 files to Studio · Open", "Already in this project · Open in Studio".
- [ ] Migration `0029` (D7): combine per-drop per-kind Studios with no annotations, and trash the rest plus the image-only "Annotate" Studios from proposals. It's reversible through Trash. Test it on a copy of the dev database first (as for 0027).
- [ ] The Overview's "Open Studio" button goes to the default Studio.

### W3 Projects first, chats in projects, on the server (D1, D2)

- [ ] `app/entry/HomeComposer.tsx`: remove the "Add to <last project>?" dialog (`choice`). A drop or a send on Home always runs `startNew`. The project name comes from the folder name (or the message), editable inline afterwards. Home lists projects as cards (open one to continue).
- [ ] Agent service: `GET /v1/sessions?projectId=` (the owner's sessions in a project: id, title, updatedAt) and `GET /v1/sessions/{id}/thread` (messages rebuilt from transcript plus run events, the same shape the drawer renders). `apps/agent/src/store/postgres.ts` 126 already filters by project.
- [ ] `stores/agent.ts`: `conversations[projectId]` becomes `{ activeSessionId }`. The thread loads from the server, and localStorage is a cache keyed by session. `conversation(projectId)` returns the active session (created on first use). `reset` becomes `newChat` (the old session stays listed). The `send` guard is per project, not per tab.
- [ ] `components/ai/assistant-panel.tsx`: a chat list (switcher at the top of the panel, like Codex), always open on project pages. Drops carry the session id as `conversationId`, so the API's `Shared in chat/<chat>` folder and `drops.conversation_id` stay as they are.
- [ ] API: `conversations/{id}/deleted` keeps working with session ids.

### W4 Drops always settle (D8)

- [ ] `kernel/imports.py` / `kernel/drops.py`: a rejected import (422 from `check`) marks its drop `failed` with the grouped findings. A drop whose sessions all ended is `ready`, `partly ready` or `failed`, never `uploading`.
- [ ] `core/panels/upload-card.tsx` and the chat drop card: group findings by rule with a count. Show a fixed file's new name once.
- [ ] Agent drop tool: wait for the drop to settle (bounded) or say "still uploading (12 of 35)", never "0 files".

### W5 Masks as slots (D9)

- [ ] `kernel/drops_classify.py` subject groups: the `_seg` node is a `slot: "reference"` part of the subject item. `projects.task_document` emits one item with `parts`.
- [ ] The volume plugin's `groupItems` reads `parts` and loads the reference as a label layer. Update the e2e assertion in `tests/e2e/mixed_drop_test.py` (the seg is a part, not an item).

### W6 Dev reload (D10)

- [ ] `apps/api/package.json` `dev`: add `--timeout-graceful-shutdown 3`. Do the same for the worker if it serves streams.

---

## 3. Acceptance (the tester's exact path, `tests/e2e/codex_flow_test.py`)

1. Home → New project "Demo" → the project opens with the chat panel open and one empty chat.
2. Drop the 35-file sample folder into the chat → upload → **one** Studio named "Studio" with
   every file. The BraTS subject is one item with its mask. Names are the original filenames. No
   proposal card on the Overview, and no other Studio in the picker.
3. Drop the same folder again → "Already in this project · Open in Studio". Still one Studio.
4. Drop 3 new X-rays → "Added 3 files to Studio". Still one Studio, now 38 files.
5. "New chat" → two chats in the list. Reload → both chats and their messages are still there
   (from the server).
6. Back to Home → New project "Other" → its chat list is empty, and "Demo"'s chats aren't shown.
7. A drop that the rules refuse (a test rule forbidding `x`) → the drop card says why once and
   the drop is `failed`, not "uploading".

Plus unit and API tests for each workstream, and migration tests on a copy of the dev database
(0028, 0029).

## 4. Order

W1 and W6 first (an hour, they stop the confusion today), then W2, W4, W3, W5. W1 + W2 + W4 can
ship without W3; W3 is the Codex-style chat model.
