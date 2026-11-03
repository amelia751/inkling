# Projects are folders, chats are threads: name it, then work in it with the assistant

**Goal.** The model is `mkdir` and `cd`:

1. **Making a project is making a folder.** One dialog with a name field and a Create button, like
   Google Drive's "New folder". No goal, no preset, no files needed.
2. **Inside a project, the assistant does the work.** Drops, Studios, labels and exports all
   start from its chat.
3. **A project has many chats (threads).** Each one is named automatically after its first
   exchange. They run side by side, and any chat can **branch** from a message.
4. **Outside a project (Home), the assistant only routes.** It can list your projects, make a
   new one and send you into one. It never works on project data from there (see §1 for why).

**Status (2026-11-03, `main` a10f7d4).** Plan only. Built from code reads. todo20 W3 already
moved chats to the server and added a chat list. This plan covers what's still missing and the
Home question.

---

## 0. Where it stands (evidence)

| # | What a person sees | Code |
|---|---|---|
| S1 | **Projects get names like "35 files", "4 images" and "zz drag test".** A send or drop on Home makes a project at once, named from the folder or the message, with no chance to name it. | `app/entry/HomeComposer.tsx` `startNew` (71) → `projectTitle({goal, picked})` (`start-project.ts`). |
| S2 | **"New project" exists but is easy to miss.** It's a small outline button in the Recent projects header. | `NewProjectButton` (`HomeComposer.tsx` 139) is a name dialog already, but it's only reached from `HomePage` / `ProjectsPage`, and there's no sidebar entry or shortcut. |
| S3 | **Chats are a dropdown, not a list.** You can't see which chats exist or which one is working without opening the menu. | `components/ai/assistant-panel.tsx` `ChatSwitcher` (614): a `DropdownMenu` of titles. |
| S4 | **Only one chat per project can run.** Starting a second chat's request while the first is running is blocked, or the first stops showing progress. | `stores/agent.ts` `runs: Record<projectId, ActiveRun>` (126, 311–315). `streaming` and `running` are keyed by project too. |
| S5 | **Chat titles are the first 80 characters of the first message** ("can you look at these and tell me which…"). There's no rename, and the server never updates a title. | Web `chatTitle` (`agent.ts` 162) and the optimistic title (632). Agent `createSession` takes `title` once (`apps/agent/src/app.ts` 36). There's no `PATCH /v1/sessions/:id`. |
| S6 | **Files dropped in a chat land in `Shared in chat/Chat Nov 3, 10.53`.** The folder is named before the chat has a title and never renamed. | `apps/api/.../kernel/drops.py` `landing_folder` (236). |
| S7 | **Home has no assistant.** The composer creates a project and opens the drawer there. Sessions need a project. | `agent_sessions.project_id text NOT NULL` (`apps/agent/src/store/migrations.ts` 15). `PersistentAgentDrawer` takes a project (`agent-drawer.tsx` 57). |
| S8 | **Cross-project reads exist only as one explicit tool.** It copies files from another project or a sample, after the rights card. | `apps/agent/src/tools/drops.ts` `copy_into_project` (238). |

---

## 1. Home: a router assistant, not a workspace-wide agent (recommendation)

There were two options.

- **A. Like Cursor:** Home has a full assistant that sees every project, reads and writes in any of
  them, and branches anywhere.
- **B. Home routes, projects work:** Home's assistant knows *which* projects exist (names, kinds,
  counts, recent activity, its own chats' titles) and can do three things: answer about them,
  create a project, and hand a request into a project. All work on data happens in a project's
  chat.

**Pick B.** In a code editor A works because one person owns the whole workspace. Here the
project is the boundary that matters:

- **Permissions are per project.** Roles, the rights attestation, a sample's license and
  restricted samples all apply to one project. An assistant spanning projects would need to
  re-check all of them on every call. One missed check and the wrong project's data is read.
- **Prompt injection.** A file name or CSV cell in project A could tell a workspace-wide agent
  to act in project B. With B, a chat's tools can only reach its own project. The one
  cross-project path (S8) stays explicit and needs the person's approval.
- **Context stays small and correct.** A chat about project A never loads B's tree, labels or
  Studios, so it's cheaper and answers don't mix two projects' files.
- **It still feels like branching.** "Do X in project Y" from Home makes a new chat in Y, seeded
  with your request, and opens it. Inside a project you branch chats freely (D5). You get the
  Cursor feeling of starting many threads, each scoped to one project.

A Home chat sees **metadata only** (the project list API: titles, `kinds`, counts, activity) and
has **no write tools** except `create_project` and `open_in_project`. It never gets file names,
trees or contents.

---

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **New project = a name dialog.** One field, prefilled with an editable suggestion and selected so typing replaces it. Enter creates it. The project opens with its chat open, empty, focused. Entry points: a **New** button at the top of the sidebar on every page (Drive's "+ New"), the Home and Projects page buttons, and the `N` key on Home and Projects. Duplicate names are allowed (Drive allows them); the list shows the date to tell them apart. |
| D2 | **A Home send or drop opens the same dialog first.** Nothing is created until you confirm the name. The suggestion is the dropped folder's name, else the drop's main kinds ("Chest X-rays", from the kind counts, never "35 files"), else a short name from the message (D4's titler). The message and files wait in the dialog and are delivered into the new project's first chat after Create (the existing `queue` and `drop` paths). Cancel keeps the text in the composer. |
| D3 | **Chats are a visible list in the assistant panel.** A collapsible rail on the panel's left lists the project's chats, newest first. Each row shows its title, a working spinner while a run is active, and an unread dot when a run finished while you were elsewhere. A row's menu has Rename, Branch and Delete. The dropdown goes. When the panel is narrow (under 520 px), the rail collapses to the title button and the list opens over the thread. |
| D4 | **Chats name themselves.** After the first assistant reply in a chat, the agent service makes a 2–6 word title from **only the first user message and the first reply's text** (already in the model's context). It uses the cheapest allowlisted model with no tools. With `AGENT_MODEL=scripted` or no model, a heuristic does it instead: the first message's first clause, up to 6 words. A title the person typed is never replaced. The service stores the title (`PATCH /v1/sessions/:id`, also used by Rename) and emits `session.updated`; the list updates live. |
| D5 | **Branch from a message.** "Branch from here" on any message (and Branch in a row's menu, from the last message) makes a new chat in the same project. It copies the transcript up to that message, with no model call. It records `branchedFrom: {sessionId, messageIdx}` and shows "Branched from <title>" at the top. The branch names itself on its first new exchange (D4). Runs in the source chat are unaffected. |
| D6 | **Chats run side by side.** Runs, streaming and pending asks are keyed by **chat** (session id), not by project. Two chats in one project can run at once. Studio edits from two runs are already serialised by environment revisions: a stale write fails with the existing conflict and the assistant retries on the new revision. The tool must surface that to the model. |
| D7 | **Chat folders follow the chat's name.** A drop's landing folder is keyed by the chat id (`drops.conversation_id`), not its name. When a chat gets or changes its title, the kernel renames its `Shared in chat/<title>` folder, unless a person renamed the folder. The pre-title default name becomes `Chat <date> <time>` and is renamed on the first title. |
| D8 | **Home's assistant routes (§1).** Home sessions have `project_id = NULL` and `scope = "home"` (migration). Their tools are `list_projects` (metadata), `create_project` (it opens D1's dialog prefilled, so the person still confirms the name) and `open_in_project(projectId, request)`, which makes a new chat in that project seeded with the request and navigates there. Nothing else. They're listed on Home under the composer as "Recent chats here", separate from project chats. |
| D9 | **Project chats stay scoped to their project.** No new cross-project tools. `copy_into_project` keeps its rights card. Policy test: every tool in a project session refuses a `projectId` other than the session's. |

---

## 3. Work

Paths are relative to the repo root; the web is under `apps/web/src/studio/`.

### W1 New project is a name dialog (D1, D2), first and small

- [ ] Move `NewProjectButton`'s dialog into `app/entry/new-project-dialog.tsx`: `useNewProject().open({ suggestion, pending })` from anywhere. It resolves with the project, or null on Cancel.
- [ ] Sidebar (`components/layout/app-layout.tsx`): a **New** button at the top, the same dialog. Register the `N` command (`useCommands`, declared in the shell's commands, no hard-coded key).
- [ ] `HomeComposer.tsx` `begin`: open the dialog with `suggestion = projectTitle(...)` and `pending = gesture`, then `deliver` after Create. On Cancel, keep the text and drop the picked files (say "Not uploaded").
- [ ] `start-project.ts` `projectTitle`: for a drop with no folder name, name it from the detected kinds of the picked files (extension guess, `guessKind`): "Chest X-rays" if the file names say so, else "Images and videos". Never "N files".
- [ ] e2e `apps/web/e2e/new_project_test.py`: sidebar New → name → Create → the chat opens focused. A Home drop opens the dialog prefilled, and Create lands the files in the new project's first chat. Cancel creates nothing.

### W2 Chats run side by side (D6)

- [ ] `stores/agent.ts`: re-key `runs`, `streaming` and `running` by session id. Selectors take `(projectId, chatId)`. `active` becomes the open chat's run. Drop the deprecated `running`.
- [ ] `components/ai/assistant-panel.tsx`: the composer's busy state and Stop are per chat. Switching chats never stops a run.
- [ ] Agent service: confirm two concurrent runs in one project's sessions are allowed (`runtime/`, lease per session). Add a test with the scripted model.
- [ ] Environment tools (`apps/agent/src/tools/`): on a revision conflict, return "the Studio changed, re-read it" instead of failing the run.
- [ ] Unit test (`agent-chats.test.ts`): two chats stream at once and each keeps its own thread.

### W3 Chat list and auto names (D3, D4, D7)

- [ ] Agent: `PATCH /v1/sessions/:id {title}` (owner only, ≤ 80 characters, trimmed, sets `meta.titleBy = "person"`). Include `title`, `titleBy`, `running`, `lastRunAt` and `branchedFrom` in `summarize`.
- [ ] Agent `runtime/`: after a session's first completed run, if `meta.titleBy` is unset, run the titler (`agent/titler.ts`). It's one call with no tools, a 30-token cap, the cheapest allowlisted model, and only the first user message and reply text as input. The scripted model uses the heuristic. It sets `titleBy = "auto"` and publishes `session.updated`. Log the cost on the run's usage line.
- [ ] Web: `assistant-panel.tsx` `ChatRail` replaces `ChatSwitcher` (keep `data-testid`s `agent-chat-list`, `agent-chat-item`, `agent-chat-new`). It has inline Rename (double-click, or the row menu), a working spinner, an unread dot (`lastRunAt` > last opened), and Delete with undo. `stores/agent.ts` applies `session.updated` from the run-event stream.
- [ ] Kernel (D7): `drops.py` keys the landing folder by `conversation_id`. New `POST /api/v1/projects/{p}/conversations/{id}/title` (called by the agent service with its service token on a title change) renames the folder if its name is still the default or the previous title. Test: a drop before the title exists, then the title, then the folder is renamed. A person-renamed folder stays.

### W4 Branch a chat (D5)

- [ ] Agent store: `branchSession(sourceId, uptoIdx, owner)` copies `agent_transcript` rows `< uptoIdx` into a new session with `meta.branchedFrom`, in one transaction, for both stores (`postgres.ts`, `file.ts`). Route: `POST /v1/sessions/:id/branch {messageIdx}`.
- [ ] `sessions.thread` maps a message index to a transcript index (a message can span several entries). Branching from a tool result branches after that assistant turn.
- [ ] Web: "Branch from here" in each message's hover actions, and Branch in the row menu. A new branch opens and its rail row is indented under its source.
- [ ] Test: branch at message 2 of 4. The new thread has 2 messages, the source still has 4, and a send in the branch doesn't touch the source.

### W5 Home routes (D8, D9), after W1–W4

- [ ] Agent migration: `agent_sessions.project_id` becomes nullable and `scope text NOT NULL DEFAULT 'project'` is added. A Home session has `scope = 'home'`, `project_id NULL`.
- [ ] A `home` profile (`apps/agent/src/agent/profiles`) with three tools: `list_projects` (the API's list: id, title, kinds, counts, last activity; no trees, no file names), `create_project` (a client tool: it opens the W1 dialog prefilled and returns the confirmed project or "cancelled") and `open_in_project` (it creates a project session seeded with the request as its first user message, then the client navigates there and the run starts in the project).
- [ ] Web: Home's composer sends into a Home chat when the message isn't a drop. "Recent chats here" sits under the composer. A drop on Home still goes to W1's dialog (files always need a project).
- [ ] Policy test (D9): a project session's tools reject a different `projectId`. A Home session has no data tools. The titler never receives tool outputs.

---

## 4. Acceptance (`tests/e2e/projects_and_chats_test.py`, scripted model)

1. Sidebar **New** → type "Liver CT" → Enter → the project opens. The chat panel is open with
   one empty chat, and the composer is focused.
2. Drop the 35-file sample into the chat → it uploads into "Liver CT". The chat is titled
   automatically after the first reply (heuristic in scripted mode). The landing folder is
   `Shared in chat/<that title>`.
3. **New chat** → send → while it runs, switch to chat 1 and send there. Both run, each rail row
   shows a spinner, and both finish with their own answers.
4. Rename chat 2 → reload → the name stays and isn't replaced by an automatic one.
5. In chat 1, **Branch from here** on message 2 → the new chat has messages 1–2 and is listed
   under chat 1. Chat 1 still has all its messages.
6. Home → drop a folder `knee-mri/` → the dialog opens with "knee-mri" → Create → the files land
   in the new project's first chat. Cancel instead creates nothing and uploads nothing.
7. (W5) Home → "which of my projects has videos?" → the reply names projects from metadata only.
   "Start a segmentation chat in Liver CT" → a new chat opens in Liver CT with that request.
   The Home chat had no file names in its context (asserted from the transcript).

Plus unit and API tests for each workstream. Live-model runs: one conversation for the titler's
wording (about 6 calls, under $0.01), run by hand only.

## 5. Order

W1 (a day, it fixes the "35 files" names), then W2 (needed before anyone runs two chats),
W3 and W4 together, then W5. W1 to W4 ship without W5; Home stays as it is (the composer opens
the new-project dialog) until W5 lands.
