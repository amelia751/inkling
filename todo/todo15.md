# The whole first run: sign in, empty, talk, drop, watch the Studio build itself

**Goal.** One sentence, and the acceptance test for this plan: *a person signs in, sees an empty
product, starts a conversation, drops in their data, and watches the assistant set up the dataset,
labels and Studio in front of them, on local dev (`pnpm dev`).* After todo9, todo14 and this
file, nothing else is needed for that sentence to be true. The MVP is local only; the deployed
site is paused (D7) and has no work in this plan.

**Status (2026-11-02).** M1 and M2 done on `main` 25edaeb (see §6). Plan was: todo9 is merged on `main`. todo14 is in flight
on `todo14-api` (M0 start empty, M1 sample copies, M2 preferences) and `todo14-web` (M0 dev "new
person", M1 sample picker, M2 first-run hints and empty states), not merged yet. This plan starts
when both are merged and does not redo their work.

**Naming.** The product name appears only in `packages/contracts/src/naming.ts` (`NAMING.displayName`
is "Spurby"). Env vars are written here without their prefix.

---

## Start here (agents)

1. Read `AGENTS.md`, then this file, then `todo/todo13.md` §3 (the journey) and §7 (flags and
   rollout), `todo/todo14.md` §2 and §4, `todo/todo9.md` §0.4, `docs/running.md`.
2. One worktree per workstream: `git worktree add .worktrees/todo15-<name> -b todo15-<name> main`.
   The root checkout is shared; never leave edits there.
3. Test the product yourself (browser, kernel API, MCP), not through the in-house agent. The only
   real-model runs are the ones in Milestone 2, counted and reported.
4. Hand back: items done against their exit tests, checks run, screenshots of each step of the
   journey, real-model runs made and their cost.

---

## 0. Where we are (audit 2026-11-02)

Each step of the sentence, checked against the code on `main` plus the two todo14 branches.

| Step | Local dev | Owner |
|---|---|---|
| **Sign in** | WorkOS code merged (todo9 Phases 1–13): `/api/auth/*`, `useSession`, agent JWT auth, org routes, keys, event sync, Emulate tests. Staging dashboard configured: Google with our client, email + password, redirects, sessions, "Spurby", roles and permissions from `infra/workos/seed.yml`. Local sign-in needs `AUTH_MODE=workos` with `secrets/workos.env` | todo9 → **M1 here** (local switch) |
| **Everything empty** | todo14 branches: no Samples membership, dev "new person", empty states | todo14 |
| **Start my own session** | Works, behind a **consent screen** stored in browser `localStorage` (`stores/agent.ts` 313, 431), not per person; local agent defaults to the **scripted** model (`docs/running.md` 171) | **M1, M2 here** |
| **Dump in data** | Works with the four `API_FEATURE_*` flags (on by default in dev, `config.py` 258) and the worker running (`pnpm dev` starts it) | done |
| **Set up live** | Drop: kernel classifies, plans, auto-applies, fast path boots the Studio (`drops_plan.py`, `boots.ts` 110). Text only: the fast path boots a preset (`HomeComposer.tsx` 82) but the agent may **not boot or label** it: `boot_studio` needs a "create" intent (`policy.ts` 118, `studio-tools` `isCreationIntent`), and "classification with five labels" isn't one | **M1, M2 here** |
| **Real model** | Only scripted runs so far (todo13 J1–J12) | **M2 here** |

What already works and is not in this plan: Studio boot and live items, drop cards, Shared in chat,
per-person rights attestation (`imports.py` 237), plugin pins for new projects (`installer.py` 64),
org-scoped projects and agent sessions (`orgId`, `sessions.ts` 68).

## 1. Gaps this plan closes

Found by the audit and not covered by todo9 or todo14:

1. **One browser, many people.** Persisted client state is keyed per *dev* principal on
   `todo14-web` (`personKey`), not per signed-in user: agent threads, sessions, conversations and
   consent (`stores/agent.ts`), recent projects (`stores/shell.ts`), Studio layout, file sort and
   recents, tool prefs. Sign-out (`user-menu.tsx` 42, `session.ts` 164) clears none of it, nor the
   react-query cache, the kernel-token cache (`kernel-token.ts` 24, keyed by workspace only) or
   `["agent-status"]`.
2. **The consent screen sits between "start my session" and the assistant.** A first message or
   drop from Home waits behind a full-panel consent (`assistant-panel.tsx` "Consent"), stored per
   browser.
3. **Text-only starts don't finish.** The assistant isn't allowed to boot a Studio unless the text
   is a "create" intent, so "Chest X-ray classification with five labels" can end with a preset
   Studio and no labels (todo13 J2 only passes scripted).
4. **Real models are unproven.** No real-model J1/J2 run; local dev has no documented real-model
   setup besides "set a key".
5. **Stuck states.** With the worker down, uploads stay "Checking files…" forever (`stores/uploads.ts`
   174); an unreachable agent looks like "not configured" (`assistant-panel.tsx` 583); a queued Home
   message is lost on reload (`pending-ask.ts` 9); features load with a 1.5 s timeout and default
   off (`features.ts` 52), so a slow api hides attach on first paint.
6. **Local sign-in isn't one command.** `pnpm dev` runs `AUTH_MODE=dev`; trying the real
   WorkOS sign-in locally means knowing which env vars to set for api, web and agent.
7. **Mocks on the journey path.** User menu shows a mock balance (`user-menu.tsx` 100); "Create
   organization" is a disabled item (`switchers.tsx` on `todo14-web`).

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **Client state belongs to the signed-in person.** Every persisted browser key goes through one helper, `personKey(base)`, that suffixes the session's user and org id in `workos` mode (the dev principal in `dev` mode). Sign-out calls `forgetClient()`: `queryClient.clear()`, the kernel-token cache, agent status, and removal of every `${RES}-*` key for that person. A different person on the same browser sees nothing of the previous one. |
| D2 | **No consent wall.** The first send is the acknowledgement: under the Home composer and the empty chat, one line says what the model receives ("Messages, file names and file facts go to <provider>. File contents never do.") with a link to details. The person's acknowledgement is stored server-side in `user_prefs` (todo14 D8) on first send. An org admin can turn the assistant off (`aiAssist`, org settings, already a column); then the composer says so and drops still work. |
| D3 | **A described task is a creation intent when the project has no Studio.** In a project without a task, any request naming a task kind, modality or labels may boot (policy: `creationIntent(text) || !project.hasTask`). The assistant's first turn on a new project must end with a booted Studio whose labels match the request (prompt rule plus a check in the J2 test). |
| D4 | **A drop with no text still gets a reply.** The queued drop message (`HomeComposer.tsx` `queue(projectId, text, pending)`) is sent even when `text` is empty; the assistant narrates what it found and what it set up. Already the code path once D2 removes the wall; the test asserts it. |
| D5 | **Fail loudly, never spin.** Upload inspection: after 2 minutes in "checking", show "Still checking. Inspection is slow or unavailable" with Retry and Keep uploading; after 10 minutes, mark the session failed with a reason. Agent: "The assistant is unavailable right now" (502/503/timeout, with retry) distinct from "not configured". Home's queued message survives a reload (sessionStorage, per person). The web waits for `/features` before rendering the composer's attach (skeleton, no 1.5 s default-off). |
| D6 | **Local dev runs a real model with one key.** `secrets/models.env` with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` plus `AGENT_MODEL=<provider:model>` (prefixed) from the allowlist; `pnpm dev` picks it up. `docs/running.md` gets a "Real model" section. Default stays `scripted`. |
| D7 | **The MVP is local; the deployed site is paused.** Since 2026-11-02 every Deployment in both GKE clusters is scaled to 0 (worker's KEDA ScaledObject paused, CronJobs suspended) and both Cloud SQL instances are stopped (`activation-policy NEVER`, data kept). Nothing is deleted. Bringing it back is §8, a separate plan for when there is someone to show it to. |
| D8 | **`pnpm dev:signin` runs the journey with real sign-in.** Same as `pnpm dev` but api, web and agent in `AUTH_MODE=workos` with `secrets/workos.env` (WorkOS Staging); `pnpm dev` stays dev auth for everyday work and e2e. |
| D9 | **Mocks on the journey path are hidden, not faked.** The user menu drops the balance until billing exists; "Create organization" works (WorkOS org + membership, switch into it) or is removed. |

## 3. Milestones

### Milestone 1. Product gaps (code, about 4 days, after todo14 merges)

Workstream `todo15-web` (D1, D2 web side, D4, D5 web side, D9):

- [ ] `lib/person-key.ts`: `personKey(base)` from `useSession` (workos) or the dev principal (dev);
  replace every `${RES}-…` persisted key (`rg "\\$\\{RES\\}-" apps/web/src` lists them) including
  zustand `persist` names; `forgetClient()` on sign-out and before an org switch's navigation.
- [ ] Kernel-token cache keyed by principal + org + workspace; cleared by `forgetClient()`.
- [ ] Consent screen removed; inline notice under the Home composer and the empty chat;
  `PUT /v1/me/prefs/aiNoticeSeen` on first send (todo14-api's prefs route); `aiAssist=false` shows "The assistant is off
  for this organization" and keeps drops.
- [ ] Empty-text drop messages are sent; reply visible within the drop card's conversation.
- [ ] Upload "checking" timeout states; agent unavailable vs unconfigured; queued Home message in
  sessionStorage per person; `/features` gate without default-off flash.
- [ ] User menu without balance; "Create organization" (POST to the org route from todo9 Phase 6,
  then `switch-org`) or removed.
- [ ] `pnpm dev:signin` (D8) and a "Sign in locally" section in `docs/running.md`.
- [ ] Tests: vitest for `personKey`/`forgetClient`; e2e `first_run_journey_test.py` (below).

Workstream `todo15-agent` (D3, D4 agent side, D2 server side):

- [ ] Policy: allow `boot_studio` when the project has no task and the text names a task kind,
  modality or labels; keep the deny for projects with Studios unless the intent is "create".
- [ ] Prompt: first turn on a new project ends with a booted Studio and the requested labels
  (`patch_environment` with label groups); drop-only first turn summarizes the drop and the
  Studio it opened.
- [ ] api: `user_prefs` key `aiNoticeSeen`; the agent refuses runs when the org's `aiAssist` is
  false (403 with a reason the web shows).
- [ ] Scripted fixtures for J2 (text only) and J1 (drop only, empty text) updated to the new
  behaviour; unit tests for the policy.

**Exit:** with the scripted model and Emulate, `first_run_journey_test.py` passes: sign in as a
new user → empty Home → type "Chest X-ray classification with five labels" → Studio with five
labels, no consent screen → second run: drop 12 PNGs with no text → Studio on the first ready
image, dataset in Datasets, assistant reply in the chat → sign out → sign in as another user on the
same browser → empty Home, no conversations, no recents.

### Milestone 2. Real model, proven (about 1 day, real-model budget below)

- [ ] D6 local setup and docs.
- [ ] Run J1 (drop, no text) and J2 (text only) with one cheap allowlisted model locally: 3 runs
  each, record time to Studio, time to labels, tokens and cost in this file. Fix prompt or policy
  issues found; rerun only the failing journey.
- [ ] Budget: at most 12 real-model conversations in total for this milestone, each capped at 12
  turns; never in `pnpm test` (live tests stay in `test/live`).

**Exit:** 3/3 passes of J1 and J2 locally, numbers recorded in §6.

The only thing this plan needs from a person: one model key in `secrets/models.env`.

## 4. Acceptance walk-through (what you do, what you see)

Run it on `http://localhost:5173` with `pnpm dev:signin` and a real model (D6). Every step has a
screenshot in the hand-back.

| # | You | You see |
|---|---|---|
| 1 | Open the site in a fresh browser profile | The hosted sign-in page (WorkOS AuthKit, "Spurby", email and Continue with Google) |
| 2 | Continue with Google (an account never used before) | Back on Home: "What are you working on?", "Or try a sample project", empty sidebar, "<First name>'s workspace" in the switcher. No consent screen |
| 3 | Type "Chest X-ray classification with five labels: normal, pneumonia, effusion, nodule, other" and send | A project named after it; the assistant drawer streams; within a minute a Studio is open with those five labels and an empty canvas saying "Drop files here" |
| 4 | Drop 20 chest X-ray PNGs (synthetic or public) on the canvas | Uploads show live; images appear in the Studio as they're ready; Files has them under "Shared in chat"; Datasets shows the dataset with one collection; the assistant says what it did |
| 5 | Go Home, drop a ZIP of DICOM CT slices with no text | A second project, the Studio opens on the first ready series, the assistant summarizes the drop |
| 6 | Sign out, sign in as a second new person on the same browser | Empty Home again; none of the first person's projects, chats or recents |
| 7 | First person invites the second to their workspace | The second person sees the projects, not the first person's conversations |
| 8 | Stop the worker, drop a file | "Still checking…" then a clear failure with Retry, never an endless spinner |

## 5. Out of scope (doesn't block the sentence)

The deployed site (§8), real patient data (needs the todo12 A9 perimeter, which needs the deployed
site), billing and payments, SSO/SCIM per customer, FGA sharing, remote MCP OAuth,
Microsoft/GitHub/Apple sign-in, a custom domain, custom AuthKit domain, pipeline connectors and GPU
workers, CI federation for `spurby-ai`, todo12 pipeline Phase 2.

## 6. Results (filled in by Milestone 2)

| Run | Where | Model | Journey | Time to Studio | Time to labels | Tokens | Cost | Pass |
|---|---|---|---|---|---|---|---|---|
| 1 | local (dev auth, `first_run_journey_test.py`) | openai:gpt-6-sol | J2 text | 0.1 s (fast path) | — (offered instead) | 24.8k (24.4k cached) | $0.031 | ✗ |
| 1 | local | openai:gpt-6-sol | J1 drop, no text | 1.2 s | reply 7.2 s | 15.8k | $0.026 | ✓ |
| — | fix: boot_studio's deny in a project that already has the fast-path Studio now says "patch_studio the labels", not "offer" (`policy.ts`) | | | | | | | |
| 2 | local | openai:gpt-6-sol | J2 text | 0.1 s | 17.7 s | 92.5k (10 tool calls) | $0.051 | ✓ |
| 2 | local | openai:gpt-6-sol | J1 drop, no text | 1.2 s | reply 6.0 s | 15.8k | $0.026 | ✓ |
| 3 | local | openai:gpt-6-sol | J2 text | 0.1 s | 13.2 s | 52.5k (5 tool calls) | $0.040 | ✓ |
| 3 | local | openai:gpt-6-sol | J1 drop, no text | 1.7 s | reply 7.0 s | 15.8k | $0.026 | ✓ |
| 4 | local | openai:gpt-6-sol | J2 text | 0.1 s | 20.9 s | 92.5k (11 tool calls) | $0.054 | ✓ |
| 4 | local | openai:gpt-6-sol | J1 drop, no text | 1.9 s | reply 7.8 s | 15.8k | $0.026 | ✓ |

8 real-model conversations of the 12 budgeted, $0.28 in total. J1 and J2 3/3 after the fix. Times are
from the send or drop; "Time to Studio" for J2 is Home's preset fast path, labels arrive from the
assistant. Run with `STUDIO_E2E_AGENT_MODEL=openai:gpt-6-sol python3 apps/web/e2e/first_run_journey_test.py`
(caps: 12 tool calls, $0.50 per run).

## 7. Config added

| Key | Service | Default | Meaning |
|---|---|---|---|
| `WEB_INSPECTION_STALL_SECONDS` | web | `120` | When "checking" turns into "Still checking" (D5) |
| `AGENT_MODEL` | agent | `scripted` under `pnpm dev` (`tools/dev.mjs`; the agent's own default is unchanged) | Set in `secrets/models.env` for a real model (D6) |
| `E2E_AGENT_SCRIPT` | e2e only | `tests/e2e/fixtures/journey-script.json` | Scripted fixture for `first_run_journey_test.py` |
| `E2E_AGENT_MODEL` | e2e only | unset (scripted) | Real model for `first_run_journey_test.py` (M2, by hand only) |

## 8. Later: bringing the deployed site back (not part of this plan)

Paused on 2026-11-02 (D7). When it's needed:

1. Start Cloud SQL: `gcloud --configuration=spurby-phi sql instances patch studio
   --activation-policy=ALWAYS`, same for `agent` in `spurby-ai`.
2. Scale up: `kubectl -n studio scale deploy --all --replicas=<as in the overlay>` in both clusters
   (or re-apply the overlays), remove the `autoscaling.keda.sh/paused-replicas` annotation from
   the worker ScaledObject, unsuspend the `agent-sweeper` CronJob.
3. The worker: run it without GKE Sandbox while data is synthetic (drop the `runtimeClassName:
   gvisor` patch in `overlays/gke/phi/patches/kustomization.yaml`), so it fits on the existing
   nodes and needs no quota increase; put the sandbox back before real data.
4. Sign-in on GKE (todo9 Phase 14), the four flags, samples in the objects bucket, then A9 before
   any real patient data.

Still billing while paused, by choice (deleting them isn't reversible): the two Autopilot cluster
fees, the two Memorystore Redis instances, Cloud SQL storage, load balancer and NAT. If even that
should go, deleting the Redis instances and clusters is a separate decision.
