# Everything a signed-in person makes is saved; dev mode stays on the laptop

**Goal.** After this todo, a person who signs in with WorkOS finds all of their work on the
server, keyed to them and their organization. That covers projects, files, every chat thread, the
Studio (layout, environment, notes, annotations) and their preferences. It survives a reload, a
second browser or device, a sign-out and sign-in, and a redeploy. Nothing they'd miss lives
only in one browser.

Dev mode stays as it is today: no sign-in, the `user:local-expert` identity with the samples,
data in git-ignored folders. It runs **only on a laptop**. A deployed service refuses to start in
dev mode, so it can't be shipped by accident.

**Status (2026-11-03, `main` a10f7d4).** Plan only, built from code reads.

- WorkOS sign-in is code-complete (todo9 Phases 1–13 merged) and runs locally with
  `pnpm dev:signin`, but no deployed stage uses it.
- Chats are on the server since todo20 W3.
- The GKE clusters are being torn down; deployment moves to Cloud Run, as costed on 2026-11-03.

Depends on todo21 W2–W3 (runs keyed by chat, chat titles) for the chat parts.

---

## 0. Where it stands (evidence)

| # | What's true today | Code |
|---|---|---|
| S1 | **Deployed config defaults to dev sign-in.** The base config trusts dev headers; only the `prod` overlay and the GKE `workos` component switch it off. The GKE deployment ran in dev mode behind an IP allow-list. | `infra/k8s/base/api/configmap.yaml` (`STUDIO_API_AUTH_MODE: dev`, `STUDIO_API_DEV_TRUST_HEADERS: "1"`), `base/agent/configmap.yaml` (`STUDIO_AGENT_AUTH_MODE: dev`). |
| S2 | **Nothing refuses dev mode in production.** With `ENV=production` the api still accepts dev auth, trusted headers, a SQLite URL and the local blob store. The agent accepts dev auth and the file store, which writes inside the container and is lost on restart. | api `config.py` `load_settings`: the production branch checks only `secret_key`, `database_url`, `worker_token` and `approval_secret`. Agent `config.ts` 276–290. |
| S3 | **Some per-person state lives only in one browser** and is lost on another device. See the "Today" column of the D3 table. | `StudioLayout.tsx` 101/125, `stores/shell.ts`, `stores/items-view.ts`, `stores/tool-prefs.ts`, `stores/sources.ts`, `files/tree-footer.tsx`, `lib/theme.tsx`, `stores/agent.ts` `partialize` (846). |
| S4 | **Chat threads are on the server, except the parts the browser adds** (cards, approvals, boots). Those parts are missing on another device. | `stores/agent.ts` `mergeThread` and `SERVER_PARTS` (text, reasoning, tool, drop only). |
| S5 | **The server already keeps a lot per person and organization:** preferences, resume points, project members, environments with revisions, Studio notes, last-known-good, annotations with commits, stars and recents, and agent sessions with `owner` and `org_id`. | `models.py` `UserPref`, `ProjectResume`, `ProjectMember`, `WorkspaceEnvironment(Revision)`, `TaskStudioNotes`, `StudioKnownGood`, `AnnotationDocumentRow`/`AnnotationCommit`, `NodeStar`, `NodeRecent`. Agent `store/migrations.ts` 65–74. `/v1/me/prefs` (`lib/prefs-api.ts`). |
| S6 | **Dev data is already git-ignored and local.** | `apps/api/.data/` (SQLite, dev secret key, signing key), `apps/agent/.data/` (file store), both covered by `**/.data/`. `seed-data/` (samples, plus `.annotations` when Vite serves them without the kernel). `secrets/*`. |
| S7 | **Dev identity.** Requests without a token act as `user:local-expert`. "Start as a new person" picks `user:dev-<id>` for one tab. The production web build compiles this out. | `lib/dev-principal.ts` (`import.meta.env.DEV`), api `dev_principal`, `API_DEV_TRUST_HEADERS`. |
| S8 | **Settings mocks left.** Billing pages and some account fields still read the mock. | `lib/account-mock.ts` (`ACCOUNT`, `ORG`, `USAGE`, `INVOICES`, `BILLING_DETAILS`), used by `lib/session.ts`, `BillingPages.tsx`, `settings/kit.tsx`. |

---

## 1. Decisions

- **D1. Two modes, nothing in between.**
  - `dev` is laptop only: no sign-in, `user:local-expert` (or a per-tab dev person), SQLite, local
    files, the agent's file store, and data in git-ignored folders.
  - `workos` is every deployed stage (staging and production): sign-in required, Postgres, Cloud
    Storage, and the agent's Postgres store.
  - `pnpm dev:signin` is the one crossover: real WorkOS **staging** sign-in, still local data.
- **D2. Dev mode can't be deployed, enforced three ways.**
  - Config fails closed: `ENV=production` refuses dev auth, trusted headers, SQLite, the local
    blob store, the agent's file store and `AGENT_AUTH_MODE=dev`.
  - Deployed config defaults to `workos`. The words `dev` and `trusted headers` appear only in
    `pnpm dev` and `infra/docker/env/*`.
  - A check rejects any rendered deploy config that sets dev mode.

  The web image is built with `WEB_AUTH_MODE=workos`. The dev-principal code is already gone from
  production builds.
- **D3. What is saved where.** Rule: anything a person would be upset to lose, or expects on
  another device, is on the server, keyed by principal (plus project or organization where it
  applies). The browser keeps only caches of server data, tab-scoped in-flight state and dev
  flags.

  | State | Today | Target |
  |---|---|---|
  | Studio panel layout, per project and task | localStorage | `user_prefs` key `layout:<project>:<task>` |
  | Shell (sidebar, panels), items view, tool prefs, sources, tree footer, theme | localStorage | `user_prefs`, one key each |
  | Chat list, active chat per project, last opened | browser cache plus server sessions | server: agent session `last_opened_at`, active chat in `user_prefs` |
  | Chat notes and per-chat profile | localStorage | agent session columns |
  | Thread parts the browser adds (cards, approvals, boots) | browser only | recorded in the agent's run record, replayed on any device |
  | Environment, notes, last-known-good, resume, annotations, stars, recents | server | unchanged |
  | Reorg plan being reviewed, unsaved edits across the sign-in redirect | sessionStorage | unchanged (tab state by design) |
  | Boot-priority hints, the stars fallback in seed mode | localStorage | unchanged (per-device cache, dev only) |
- **D4. The browser cache follows the person.** Keys are already per person (`person-key.ts`).
  Sign-out clears the cache. On sign-in the server is the source of truth and the cache refills
  from it.
- **D5. Organization scope.**
  - Projects, chats, annotations and environments carry `org_id`; switching organization shows
    only that organization's.
  - Preferences are per person across organizations; layouts are per project, so they're
    org-scoped through the project.
- **D6. Stores in a deployed stage, with no Redis.**
  - api: Cloud SQL `studio` with `JOB_QUEUE=sql` and `EVENT_BUS=sql` (both exist).
  - agent: Cloud SQL `agent` in the agent project, `AGENT_STORE=postgres`, and the in-memory
    event bus with the agent pinned to one instance. A shared bus comes before a second agent
    instance.
  - Blobs: Cloud Storage. Secrets: Secret Manager, never files.
  - WorkOS: the staging environment for staging, the production environment for production.
- **D7. Dev data never meets cloud data.**
  - Local config never points at a deployed database, bucket or WorkOS production key.
    `secrets/workos.env` holds staging keys only.
  - Local data is never imported into a deployed stage. Demo projects are recreated there from
    synthetic files.
- **D8. Size limits on preferences.** A `user_prefs` value is at most 64 KB and its key matches
  `^[a-z][a-z0-9:._-]{0,127}$`. A layout bigger than that is refused and stays local, with a
  warning in the log.

---

## 2. Work

### W1. Fail closed in production (D2)

- api `config.py` `load_settings`, production branch: refuse `auth_mode != workos`,
  `dev_trust_headers` on, a `sqlite:` `database_url` and `blob_store=local`. Key names only in the
  error.
- agent `config.ts`: production requires `AGENT_AUTH_MODE=workos` and `AGENT_STORE=postgres`.
- MCP: the remote server in production requires its OAuth settings (todo17 D12). The stdio
  server stays a local tool.
- Tests: `apps/api/tests/test_config_production.py` and `apps/agent/test/unit/config.production.test.ts`,
  one case per refusal.
- Check that `infra/docker/compose.yaml` still runs with `ENV=development`.

### W2. Deploy config defaults to signed-in (D2)

- Flip the base ConfigMaps to `workos` with `DEV_TRUST_HEADERS: "0"`. The `workos` component
  becomes the default, and the IP allow-list goes once a sign-in is verified.
- The Cloud Run service definitions (W6) set the same values.
- `tools/check-deploy-auth.mjs` (in `pnpm lint`) renders every overlay and Cloud Run service. It
  fails on `AUTH_MODE` other than `workos`, `DEV_TRUST_HEADERS=1`, `AGENT_STORE=file` or a
  `sqlite:` URL.

### W3. Per-person state on the server (D3, D8)

- `lib/person-prefs.ts`: `usePersonPref(key, fallback)` over `/v1/me/prefs`.
  - localStorage is a write-through cache for the first paint.
  - Writes are debounced (500 ms) and go last-writer-wins.
  - It works the same in dev, where the person is `user:local-expert`.
- Move `StudioLayout`, `stores/shell.ts`, `stores/items-view.ts`, `stores/tool-prefs.ts`,
  `stores/sources.ts`, `files/tree-footer.tsx` and `lib/theme.tsx` onto it. Keep their storage
  keys as the cache keys so the first load after the change uploads what's already there.
- api: enforce D8 in `routes/prefs.py`. Add a test that a second browser context sees the first
  one's layout.

### W4. Chats complete on the server (D3, after todo21 W2–W3)

- Agent session columns `notes jsonb`, `profile`, `last_opened_at`, with a migration in
  `store/migrations.ts`. `PATCH /v1/sessions/:id` (todo21 W3) accepts them.
- Record the browser-made parts as run events so a thread replays the same on any device:
  `ui_part {messageId, part}` for cards, approvals and boots. `mergeThread` then has nothing left
  to add, and `SERVER_PARTS` covers every type.
- `partialize` keeps only a cache: chats and threads per project, refilled from the server on
  open.
- Approvals stay single-use on the server (`approvals_used`). A replayed approval card shows as
  used, never as live.

### W5. The Studio saves to the kernel in every signed-in stage

- In `workos` mode every save goes to the kernel: environment revisions, notes, annotations,
  resume. The Vite file store (`WEB_ANNOTATIONS_DIR`, `seed-data/.annotations`) is a dev path
  only, and Vite refuses `WEB_AUTH_MODE=workos` without `API_URL` (already true).
- `lib/session.ts` stops reading `account-mock.ts` in `workos` mode. Billing stays mocked
  (todo9 Phase 12) and is labelled as such.

### W6. Deployed stage configuration (Cloud Run, D6)

- **Terraform, Studio project.** A `run.tf` defining:
  - services `web`, `api`, `versioning`, `pipeline` and a worker pool `worker`;
  - Direct VPC egress to Cloud SQL;
  - service accounts from `iam.tf` (no Workload Identity bindings);
  - secrets mounted from Secret Manager;
  - one HTTPS load balancer for the Studio host.

  Cloud SQL `studio` goes zonal on a 1-vCPU tier while data is synthetic
  (`sql_high_availability=false`).
- **Terraform, agent project.** `run.tf` with the `agent` service (max instances 1), Cloud SQL
  `agent` on a small tier, and Vertex access as today.
- **The agent reaching the api.** The agent calls the api's agent host with its scoped token.
  The fixed NAT addresses and IP allow-lists go away (organization policy blocks cross-project
  IAM).
- **Env per service:**
  - api: `AUTH_MODE=workos`, `WORKOS_*`, `PUBLIC_URL`, `DATABASE_URL`, `BLOB_STORE=gcs`,
    `JOB_QUEUE=sql`, `EVENT_BUS=sql`.
  - agent: `AUTH_MODE=workos`, `WORKOS_CLIENT_ID`, `STORE=postgres`, `DATABASE_URL`, `TOKEN`.
  - web: built with `WEB_AUTH_MODE=workos`.
- **WorkOS staging:** add the staging host's redirect URI and sign-out URL. Production later
  gets its own environment and Google client (todo9 Phase 14).
- **Plugin isolation:** the worker runs plugin code in Cloud Run's first-generation sandbox,
  with egress only to the api. Until the perimeter is enforced (A9), data stays synthetic.
- Record the stage in `docs/deployment-gcp.md`, with no IDs or addresses.

### W7. Dev mode, kept and documented (D1, D7)

- `pnpm dev`: `user:local-expert`, samples, no WorkOS. `pnpm dev:signin`: WorkOS staging,
  local data. Both are unchanged.
- `pnpm dev:reset` wipes `apps/api/.data`, `apps/agent/.data` and the dev annotations folder
  after a confirmation prompt. It never touches `secrets/` or `seed-data/` samples.
- `docs/running.md`: a "Dev mode and signed-in stages" section with the D1 table, and a note
  that a deployed stage refuses dev mode (W1).

---

## 3. Acceptance

- `tests/e2e/persistence_test.py`, against WorkOS Emulate with the api in `workos` mode:
  1. User A signs in, makes a project, drops synthetic files, opens two chats, renames one,
     changes the Studio layout and a preference, annotates an item, then signs out.
  2. A fresh browser context (empty storage) signs in as A and sees all of it, including the
     cards in the chat thread.
  3. User B, in another organization, sees none of it.
  4. After restarting the api and the agent, A still sees all of it.
- `test_config_production.py` and `config.production.test.ts` (W1) pass.
- `check-deploy-auth` (W2) passes on every overlay and Cloud Run service.
- On the staging deployment: sign in, run the same flow by hand on synthetic data, then confirm
  that dev headers are refused (`X-Dev-Principal` returns 401).

## 4. Order

W1 and W2 come first (small, and they close the "dev deployed" hole). Then W3, then W4 once
todo21 W2–W3 land, then W5. W6 can run alongside from the start; W7 any time.
