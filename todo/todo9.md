# Accounts on WorkOS: sign-in, organizations, members, keys

**Goal.** Today nobody signs in. The API trusts an `X-Dev-Principal` header (default
`user:local-expert`), the account menu shows a hard-coded person, and the organization pages
added on `settings-mock` (Team & Access, Security, API keys, Audit log, Profile) run on an
in-memory mock (`apps/web/src/studio/lib/account-mock.ts`). This plan replaces all of that with
WorkOS: people sign in through AuthKit, every request carries a verified identity and
organization, members and invitations are WorkOS organization memberships, and org admins
configure MFA, SSO, directory sync and domains through the WorkOS Admin Portal, so we build none of
those screens ourselves.

The mocked pages already have the shape WorkOS returns (user, organization, membership,
invitation, role slugs, API key), so each phase swaps a mock call for a real one without
redesigning the UI.

**Audit date:** 2026-10-30, against `main` 5428c5a plus `settings-mock` (mocked settings UI).
Research: WorkOS docs fetched 2026-10-30 (`workos` 10.6.0 on PyPI, `@workos-inc/node` 12.1.0,
`workos-go/v10`); the full dossier with every source link is kept next to this file as
[todo9-workos-research.md](todo9-workos-research.md).

**Scope.** `apps/api` (auth, context, members, keys, events), `apps/worker` (event sync),
`apps/agent` (verifies user tokens), `apps/web` (session, settings pages, nginx), `apps/mcp`
(API key now, OAuth later), `infra/` (secrets, egress, overlays), `tests/e2e`. Not in scope:
payments (billing pages stay mocked until a billing provider is chosen; see Phase 12).

## Status (2026-11-01)

- Mocked UI **merged to `main`**: `/organization/{members, projects, security, api-keys,
  audit-log, settings}`, `/billing/{usage, invoices, details}`, `/settings/profile`, the project
  settings Members tab, and a Settings section in the sidebar (`account-mock.ts`,
  `routes/settings/*`).
- **Update 2026-11-02:** Phases 1–13 are merged on `main` (sign-in, session, org boundary,
  members, invitations, project members, API keys, event sync, security, audit, profile, Emulate
  tests, CI). The Staging dashboard is configured (Google with our own client, redirects,
  sessions, display name "Spurby"; keys in `secrets/workos.env`). Left: Phase 14 on GKE (now
  tracked in todo15 Milestone 3 step 4), the Phase 0 sales/BAA thread, branding logo and colours.
- The product's display name is now **Spurby** (`NAMING.displayName`); ids, schema and env
  prefixes are unchanged.
- The plan was written before todo12 and todo13 landed and before the Google Cloud deployment.
  §0.4 lists what changed; the phases below are updated to match. **Good to go** once Phase 0's
  dashboard and sales answers exist; nothing in the code blocks it.
- Start with the **minimum sign-in** cut in §3 (about 1.5 weeks): it is what todo14 (empty
  first run, per-person data) needs.

---

## 0. Where we are

### 0.1 Identity today

| Caller | How the API knows who it is | Where |
|---|---|---|
| Browser | Nothing is sent. With `STUDIO_API_DEV_TRUST_HEADERS=1` (on everywhere, even in `infra/k8s/base/api/configmap.yaml`) the request acts as `X-Dev-Principal` or `user:local-expert`, in `X-Workspace-Id` or `default`. | `apps/api/src/studio_api/context.py` `resolve_context` |
| Agent runs | `Authorization: Bearer <session token>` minted by `POST /v1/sessions` (`agent:<name>`, `on_behalf_of` = minter); the web mints it with dev headers. | `routes/kernel.py`, `apps/web/src/studio/lib/agent/kernel-token.ts` |
| Browser to agent | Vite and nginx add the shared `STUDIO_AGENT_TOKEN`; the agent compares it. The browser never holds it. | `apps/web/vite.config.ts`, `apps/web/nginx/default.conf.template`, `apps/agent/src/app.ts` |
| Worker | `X-Worker-Token`, then a scoped session token per job. | `routes/worker.py` |
| api to versioning | Ed25519 JWT, 60 s, minted by api. | `kernel/versioning/auth.py`, `apps/versioning/internal/authn/jwt.go` |
| MCP (stdio) | No login; `STUDIO_MCP_AUTHOR` names the author. | `apps/mcp/src/main.ts` |

Organizations exist in Postgres (`organizations`, `organization_members` with roles
`owner | editor | viewer`, `projects.org_id`). `kernel/projects.py` creates a personal org per
`user:` principal on first use and checks `role_in(org)` in `require_project`. There are no HTTP
routes for org membership, invitations or keys.

### 0.2 The mocked settings (settings-mock)

| Page | Mock calls today (`useAccount`) | WorkOS behind it (this plan) |
|---|---|---|
| Organization › Team & Access | `invite`, `resendInvite`, `revokeInvite`, `setRole`, `removeMember` | Invitations + organization memberships (Phase 6) |
| Organization › Projects | real `useProjectList` + mock member counts | our `project_members` (Phase 6) |
| Organization › Security | local state | Org MFA policy, Admin Portal links (SSO, directory sync, domains), session settings (Phase 9) |
| Organization › API keys | `createKey`, `revokeKey` | WorkOS API keys, organization-owned (Phase 8) |
| Organization › Audit log | `audit` list | our audit table, exported to WorkOS Audit Logs later (Phase 10) |
| Organization › Settings | `ORG` object | `organizations` row + WorkOS org name (Phase 6) |
| Billing › * | constants | Not WorkOS (Phase 12) |
| Your profile | `ACCOUNT` object, fake sessions | `update_user`, sessions list/revoke, MFA enrollment (Phase 11) |
| Project settings › Members | `projectTeam`, `addToProject`, `setProjectRole`, `removeFromProject` | our `project_members` (Phase 6); FGA later (Phase 15) |
| Account menu | `ACCOUNT`, `ORG` | `GET /api/auth/session` (Phase 4) |

### 0.3 What WorkOS gives us, and what we use

| Product | Use | When |
|---|---|---|
| AuthKit (hosted sign-in, sessions, users) | Sign-in with email + password, Google, Microsoft, magic link, passkeys; MFA; Radar bot protection | Now |
| Organizations, memberships, invitations | Our organizations and Team & Access | Now |
| RBAC (roles, permissions in the access token) | Organization roles: Admin, Member, Billing manager | Now |
| Admin Portal | Customer IT sets up SSO, directory sync, domain verification, audit-log streams | Now (domains), per customer (SSO, directory) |
| API keys | Organization keys for scripts, PACS bridges, MCP | Now |
| Events API | Keep our users/members tables in sync | Now |
| Audit Logs | Customer-visible export and SIEM streaming | Later |
| FGA | Project and dataset sharing | Later |
| Connect (OAuth server) | Remote MCP sign-in, customer machine-to-machine clients | Later |
| Vault, Pipes, API Gateway, standalone SSO/MFA APIs | Not used (own secrets broker; gateway would route medical traffic through WorkOS) | No |

### 0.4 What changed since 2026-10-30 (audit 2026-11-01, `main`)

| Area | Now | What this plan must do differently |
|---|---|---|
| Migrations | `apps/api` is at `0012_todo13_collections_drop_plans_structures.py` | Phase 2 migration is `0013_accounts.py` |
| Deployment | Real stage is `infra/k8s/overlays/gke/{phi,ai}` (Google Cloud, todo12 Part A). `dev`, `staging`, `prod` overlays exist but aren't deployed | Phase 1 and 14 change the `gke` overlays too; D9's "staging" WorkOS environment serves the `gke` stage until a separate prod exists |
| Trusted headers on GKE | `DEV_TRUST_HEADERS=1` from `base/api/configmap.yaml` is live on the deployed Studio; the only guard is the ingress allowlist `STUDIO_ALLOW_CIDRS` (`gke/phi` overlay) | Phase 14: `workos` mode on `gke/phi`, trust headers off, then drop the allowlist |
| Agent in another project | The agent runs in `spurby-ai` behind `agent.<ip>.sslip.io`; the Studio's nginx calls it over HTTPS with `AGENT_TOKEN`, and the agent ingress admits only phi's NAT address | Phase 5's `auth_request` design still works (nginx forwards the Bearer across). The agent verifies WorkOS JWTs itself; its egress already allows public 443 |
| api egress | `gke/phi/network.yaml` lets api reach only the restricted Google APIs VIP, metadata and the agent's ingress IP | Phase 1: api and worker need `api.workos.com:443`. Use a GKE FQDN network policy if available on the cluster, else an egress ipBlock for 443 on api only; VPC Service Controls don't apply (not a Google API) |
| Agent conversations | `apps/agent` stores sessions under `owner = principal ?? "local"`: on GKE every person shares one chat history | Phase 5: owner = verified user, plus `org_id` on `agent_sessions` (agent store migration) |
| Samples | `ensure_principal` makes every new `user:` principal an editor of the shared Samples org, so nobody ever starts empty and edits to samples are visible to everyone | Phase 3 `bootstrap`: no Samples membership; samples become opt-in copies (todo14 D2) |
| todo13 objects | `drops`, `dataset_collections`, `drop_plans`, `dataset_structures`, "Shared in chat" folders | All hang off `project_id`, so the org boundary in `require_project` covers them; add them to the cross-org test (Phase 3) |
| CI | e2e workflows are manual-only (`workflow_dispatch`) | Phase 13: auth tests run as api unit tests against Emulate in `ci`; browser auth e2e is manual like the rest |
| SDKs | PyPI `workos` is still 10.6.0; GitHub `main` documents v11 (iterating a page no longer auto-paginates; `auto_paging_iter()` does) | Keep `<11`; always use `auto_paging_iter()` so the v11 upgrade is a no-op |

---

## 1. Decisions

- [ ] **D1. Login pattern: the API owns the session (backend-for-frontend).**
  **Recommended.** `apps/api` serves `/api/auth/login | callback | logout | session | switch-org`,
  exchanges the code with the Python SDK and keeps a sealed, HttpOnly cookie holding the access
  token, the refresh token and the user. The SPA never sees a token.
  Rejected: `@workos-inc/authkit-react` (without a paid custom AuthKit domain it keeps the
  refresh token in localStorage), `@workos-inc/authkit-react-router` (needs server loaders; our
  web is a static SPA).

- [x] **D1a. WorkOS hosts the sign-in screen; we build none.** AuthKit's hosted pages (on the
  environment's AuthKit domain, `*.authkit.app` on staging; a custom `auth.<host>` before GA,
  Phase 14) do sign-in, sign-up, "Continue with Google", email verification, password reset,
  magic codes, MFA enrollment and challenge, organization selection and invitation acceptance.
  Our `/api/auth/login` only redirects there and `/api/auth/callback` receives the code. We style
  it in the dashboard (Branding: logo, colours, the product name from `NAMING.displayName`,
  "Spurby"); its look is not code in this repo. The only auth UI we build: the account menu,
  the org switcher, and a "Signing you in…" state while the callback redirects. A signed-out
  visit to any page goes straight to the hosted page (Phase 4), so there is no sign-in route in
  the SPA.

- [ ] **D2. Other services get a JWT, never the cookie.** Sealed cookies are language-specific
  (Python seals with Fernet, Node with iron, Go its own), so only api reads the cookie. The agent
  receives the WorkOS access token as a Bearer that nginx obtains from api via `auth_request`
  (Phase 5). versioning and worker keep their self-minted credentials unchanged.

- [ ] **D3. Principal format `user:<workos user id>`** (e.g. `user:user_01JD7K…`). Agents stay
  `agent:<name>` with `on_behalf_of` = the user; annotations, revisions, commits and audit rows
  keep principal strings, so their shape doesn't change.

- [ ] **D4. Organizations map 1:1.** Each `organizations` row gets a `workos_org_id`;
  the WorkOS organization's `external_id` is our org id. Personal organizations stay:
  on first sign-in without an organization, api creates one (WorkOS org + membership as Admin),
  then refreshes the session into it.

- [ ] **D5. Organization roles live in WorkOS; project roles live in our database.**
  - WorkOS environment roles: `admin`, `member` (default), `billing`. Code checks **permissions**,
    never role slugs (custom per-org roles get unpredictable slugs).
  - Permissions (short, they ride in the cookie): `org:manage`, `members:manage`,
    `billing:manage`, `apikeys:manage`, `audit:read`, `project:create`, plus the widget
    permissions on `admin` (`widgets:users-table:manage`, `widgets:api-keys:manage`,
    `widgets:sso:manage`, `widgets:domain-verification:manage`).
  - Project roles (`owner` shown as "Project admin", `reviewer`, `annotator`, `viewer`) are a
    new table `project_members`. Org Admins are implicitly project admins everywhere.
    FGA replaces the table later only if sharing needs grow (D13).
  - Existing `organization_members.role`: `owner` → `admin`, `editor` and `viewer` → `member`.
    Seed principals (`user:local-expert`, …) are dev-only and aren't migrated.

- [ ] **D6. Sync with the Events API, not webhooks.** One consumer in the worker, cursor in
  Postgres, ordered, 90 days of history, no inbound endpoint to expose (better for hospital and
  on-prem stages). The callback also upserts the signed-in user right away.

- [ ] **D7. Settings pages call our api, not WorkOS widgets.** api wraps the WorkOS calls
  (`/v1/org/members`, `/v1/org/invitations`, `/v1/org/api-keys`, …) and enforces permissions; the
  pages stay shadcn. Rejected: `@workos-inc/widgets` (brings Radix Themes and a second CSS
  system), headless `/_widgets/*` endpoints (less documented, needs CORS and widget tokens in JS).

- [ ] **D8. Dev and CI run without WorkOS by default.** `STUDIO_API_AUTH_MODE = dev | workos`.
  `dev` keeps today's header identity, so the seed-mode e2e suite and its `data-testid`
  contracts keep working. Tests of the WorkOS path run against **WorkOS Emulate** (in-memory
  WorkOS API on :4100). A real WorkOS staging environment is used for manual and nightly checks.
  `workos` mode refuses to start with `DEV_TRUST_HEADERS=1`.

- [ ] **D9. WorkOS environments per stage.** local → Emulate (opt-in: the shared "dev" staging
  environment); k8s `dev` and `staging` → WorkOS staging; `prod` → WorkOS production. One
  AuthKit application per WorkOS environment.

- [ ] **D10. Short access tokens, real session limits.** Access token 5 min; inactivity timeout
  60 min; maximum session 12 h (clinical workstations). Revocation and role changes take effect at
  the next refresh, so the short access token is what bounds the lag.

- [ ] **D11. No PHI to WorkOS, and a BAA before PHI-adjacent customers.** WorkOS signs a HIPAA
  BAA only on enterprise plans and hosts in the US only. WorkOS gets names, emails, IPs, org
  names; never file names, study descriptions, patient ids or anything clinical in metadata,
  `external_id`, audit-log targets, JWT templates or invitation text. Start the sales
  conversation in Phase 0, in parallel.

- [ ] **D12. API keys from WorkOS, organization-owned.** Validated by api with a short cache
  (validation is a network call and counts towards rate limits). User-owned keys later if
  people ask for personal tokens.

- [ ] **D13. Later, each behind its own decision:** FGA for project/dataset sharing, SSO and
  directory sync per enterprise customer (paid per connection), Audit Logs export, Connect for
  remote MCP and M2M, impersonation (only with a banner, PHI export blocked, audited), custom
  AuthKit domain (needed before GA for branding).

- [ ] **D14. Names.** Code says `workos_env`, `workos_org_id`, `workos_user_id` (WorkOS
  "environment" ≠ our environment; the kernel "workspace" ≠ organization). The cookie
  name comes from naming config (`<naming id>_session`), never a product literal. Env vars are
  `STUDIO_<ROLE>_WORKOS_*`; the SDKs' unprefixed `WORKOS_*` vars are never set.

---

## 2. Target design

### 2.1 Request flow

```text
Browser (SPA, same origin)          cookie: <naming>_session = sealed {access, refresh, user}
  ├── /api/auth/*   ─────────────► api   login, callback, logout, session, switch-org, verify
  ├── /api/*        ─────────────► api   resolve_context: unseal → verify JWT (JWKS) → refresh if expired
  │                                       → RequestContext(principal=user:<sub>, org_id, permissions)
  └── /api/agent/*  ─► web nginx ─ auth_request /api/auth/verify ─► api (200 + X-Access-Token)
                         └── proxy to agent with Authorization: Bearer <WorkOS access token>
                             agent: verifyAccessToken → claims

agent  ── kernel session token (on_behalf_of=user:<sub>) ──► api      (unchanged shape)
api    ── Ed25519 60 s JWT (actor=user:<sub>, org) ─────────► versioning (unchanged)
worker ── worker token + session token ─────────────────────► api      (unchanged)
worker ── Events API pull (cursor in Postgres) ─────────────► WorkOS   (new)
MCP stdio ── organization API key ──────────────────────────► api      (new)
```

### 2.2 Access-token claims we use

| Claim | Use |
|---|---|
| `sub` | `principal = "user:" + sub` |
| `org_id` | `RequestContext.org_id`; every project access checks `project.org_id == ctx.org_id` |
| `permissions` | `ctx.can(permission)` |
| `sid` | logout, session list and revoke |
| `act` | impersonation (later): banner, block exports |
| `auth_time` | step-up before export, delete, key creation (`max_age` on the authorize URL) |
| JWT template `organization_membership_id` | membership calls without a lookup; FGA later |

`iss` differs between the docs (`https://api.workos.com/` vs
`https://api.workos.com/user_management/<client_id>`): decode a staging token before enforcing
it (Phase 0).

### 2.3 Environment variables

| Var | Service | Secret | Notes |
|---|---|---|---|
| `STUDIO_API_AUTH_MODE` | api | no | `dev` (default) or `workos` |
| `STUDIO_API_WORKOS_API_KEY` | api, worker | yes | `sk_…`, shown once in production |
| `STUDIO_API_WORKOS_CLIENT_ID` | api, worker | no | `client_…`, also builds the JWKS URL |
| `STUDIO_API_WORKOS_COOKIE_PASSWORD` | api | yes | **A Fernet key** (Python rejects arbitrary passwords): `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Same on every replica. |
| `STUDIO_API_WORKOS_REDIRECT_URI` | api | no | `https://<host>/api/auth/callback`, exactly as in the dashboard |
| `STUDIO_API_WORKOS_ISSUER` | api | no | after Phase 0 confirms the value |
| `STUDIO_API_WORKOS_BASE_URL` | api, worker | no | Emulate in dev/CI (`http://localhost:4100/`) |
| `STUDIO_API_PUBLIC_URL` | api | no | for `return_to` validation and Admin Portal return URLs |
| `STUDIO_AGENT_WORKOS_CLIENT_ID` | agent | no | JWKS; add `STUDIO_AGENT_WORKOS_API_KEY` only if the client-id-only client can't verify |
| `STUDIO_AGENT_WORKOS_ISSUER` | agent | no | |
| `STUDIO_MCP_API_KEY` | mcp | yes | organization API key (stdio) |
| `/config.json` `auth` | web | no | `{ "mode": "dev" \| "workos" }`; nothing secret |

The worker reads the API's WorkOS key under its own role name if `check:names` requires it
(`STUDIO_WORKER_WORKOS_API_KEY`); decide in Phase 1 by running the check.

---

## Phase 0. Accounts, procurement and the WorkOS dashboard

No code. One person, about a day, plus the sales thread.

- [x] Create the WorkOS team and project; note the staging and production environments.
  (Done: one project with Staging and Production environments.)
- [x] Staging API key and client id in the git-ignored `secrets/workos.env`
  (`STUDIO_API_WORKOS_API_KEY`, `STUDIO_API_WORKOS_CLIENT_ID`; key names in
  `secrets/workos.env.example`). Checked 2026-11-01: the key lists organizations (200) and the
  client id's JWKS resolves. On Google Cloud the same values go into Secret Manager (Phase 1),
  never into a repo file.
- [ ] Email WorkOS sales: BAA plan and price, EU or dedicated hosting, pricing for API keys, FGA,
  Connect/MCP, Audit Logs (Appendix B lists every open question). Record the answers here.
- [x] Staging, done 2026-11-01 (application › Redirects): redirect URIs
  `http://localhost:5173/api/auth/callback` and `https://<gke studio host>/api/auth/callback`
  (the sslip.io name; the latter is the default); initiate login URI
  `http://localhost:5173/api/auth/login` (switch to the GKE host in Phase 14: invitation and
  password-reset links land here); sign-out URIs `http://localhost:5173/` and the GKE host's `/`.
  Sessions: maximum 12 h, access token 5 min, inactivity 1 h. Branding: display name "Spurby"
  (logo and colours still to do). The hosted sign-in page shows "Continue with Google".
  Add `:5175` and any new host here when needed.
- [ ] Staging environment, application **Redirects** tab (the original plan):
  - Redirect URIs `http://localhost:5173/api/auth/callback`, `http://localhost:5175/api/auth/callback`,
    `https://dev.<host>/api/auth/callback`, `https://staging.<host>/api/auth/callback` (exact
    match, no trailing slash).
  - Default **Sign-out URI** (`/`), else logout ends on an error page.
  - **Initiate login URI** `/api/auth/login` (needed by invitations, password reset, bookmarked
    pages, impersonation).
- [ ] **Sessions** tab: access token 5 min, inactivity 60 min, maximum 12 h (D10).
- [ ] **Authentication**: email + password, Google, Microsoft, magic link, passkeys on;
  sign-up open (invite-only per org later); MFA "optional" (per-org policy in Phase 9);
  impersonation off; Radar on. State of Staging on 2026-11-01:
  - [x] Email + password enabled (minimum length 10, complexity 3).
  - [x] Google enabled with **our own OAuth client** (2026-11-01): `spurby-ai` › Google Auth
    Platform, app name "Spurby", audience External, web client "WorkOS AuthKit (staging)" whose
    only redirect URI is the one on WorkOS's Google provider page. Client id and secret are
    entered in WorkOS (Providers › Google › Manage › Your app's credentials); a backup of the
    client JSON is in the git-ignored `secrets/google-oauth-staging.json`. Scopes: email and
    profile only, so no Google verification is needed.
  - [x] **Google app published** (In production; email and profile scopes need no review).
    Branding: app name "Spurby", home page `https://spurby.ai`, authorized domains `workos.com`
    and `spurby.ai`. Add privacy and terms links once the site has those pages.
  - [ ] Production: a second client ("WorkOS AuthKit (production)") with the Production
    environment's redirect URI; add the logo under Branding (that triggers brand verification).
  - Sign in with Apple stays **off** for now (decided 2026-11-01). Microsoft and GitHub are on
    with demo credentials; turn them off or give them own clients before production.
  - [ ] Magic Auth and passkeys still off; SSO shows "Redirect URI is missing" until the
    Redirects tab above is filled in.
- [ ] **JWT template**: add `organization_membership_id`. Keep it tiny (cookie size).
- [ ] **Authorization**: create the permissions and roles of D5; default role `member`; multiple
  roles off; organization API key permissions = `datasets:read`, `annotations:write`,
  `studio:tools`, `admin` (the four scopes on the mocked API keys page).
- [ ] Write the roles and permissions as a seed file (`infra/workos/seed.yml`, applied with
  `npx workos@latest seed --file=…`) so staging, prod and Emulate stay identical. Verify the CLI
  flags with `workos --help --json` first.
- [ ] Branding (this is the whole sign-in screen, D1a): logo, colours from the brand tokens in
  `globals.css` (never the AI lime), product name "Spurby" as in `NAMING.displayName`.
- [ ] Sign in once on staging with a test user, decode the access token, record the real `iss`,
  `exp` lifetime and claim names in §2.2.

**Exit:** a staging sign-in works in the WorkOS dashboard's preview; the seed file reproduces
roles and permissions; open questions are sent.

## Phase 1. Config, secrets and naming

- [ ] `apps/api/src/studio_api/config.py`: add `auth_mode`, `workos_api_key`, `workos_client_id`,
  `workos_cookie_password`, `workos_redirect_uri`, `workos_issuer`, `workos_base_url`,
  `public_url` to `Settings` and the env map (`API_AUTH_MODE`, `API_WORKOS_*`). Validate at
  startup: `workos` mode requires key, client id, cookie password (must load as a Fernet key) and
  redirect URI, and forbids `dev_trust_headers`.
- [ ] `apps/worker/src/studio_worker/config.py`: WorkOS key, client id, base URL.
- [ ] `apps/agent/src/config.ts`: `workosClientId`, `workosIssuer`, `authMode`.
- [ ] `apps/mcp/src/main.ts` → move env reads into a config module; add `apiKey`.
- [ ] `apps/web/src/extension-host/runtime-config.ts`: `auth.mode`; Vite `define` default `dev`.
- [ ] `secrets/workos.env.example` (key names only), `secrets/README.md` row; `docs/running.md`
  "Signing in" section (dev mode, Emulate, staging).
- [ ] k8s: `workos-secrets` Secret (api, worker), ConfigMap keys per service, `prod` and
  `gke/phi` overlays set `STUDIO_API_AUTH_MODE=workos` and `STUDIO_API_DEV_TRUST_HEADERS=0`
  (`gke/phi` only when Phase 14 flips it). On GKE the values come from Secret Manager through
  the existing External Secrets store, like every other secret (`docs/deployment-gcp.md`).
- [ ] NetworkPolicy egress to `api.workos.com:443` from api and worker in `gke/phi/network.yaml`
  (§0.4: today they reach only Google APIs). The agent's policy in `gke/ai/app/network.yaml`
  already allows public 443.
- [ ] `infra/docker/env/*.env`: Emulate service in the `deps` profile (`workos-emulate --seed
  infra/workos/emulate.yaml`, port 4100, health `/health`).
- [ ] Python deps: `workos>=10.6,<11` in `apps/api` and `apps/worker` (`uv add`). Node:
  `@workos-inc/node@^12` in `apps/agent`.

**Exit:** `pnpm check:names`, `uv run ruff check`, `pnpm typecheck`; api starts in both modes;
`workos` mode with a bad cookie password fails at startup with a clear message.

## Phase 2. Data model

Alembic migration `0013_accounts.py` (after todo13's `0012`; renumber if something lands first).

- [ ] `users`: `id` (= `user:<workos id>` principal), `workos_user_id` unique, `email`
  (lower-cased), `first_name`, `last_name`, `avatar_url`, `email_verified`, `last_sign_in_at`,
  `workos_updated_at`, `deleted_at`.
- [ ] `organizations`: add `workos_org_id` unique nullable, `workos_updated_at`.
- [ ] `organization_members`: add `workos_membership_id` unique nullable, `status`
  (`pending | active | inactive`), `role_slugs` (array/JSON), `workos_updated_at`. Data migration:
  `owner` → `admin`, `editor`/`viewer` → `member` (D5).
- [ ] `project_members`: `project_id`, `principal`, `role` (`owner | reviewer | annotator |
  viewer`), `added_by`, `added_at`; PK (`project_id`, `principal`). Backfill: each project's
  `created_by` as `owner`.
- [ ] `workos_event_cursor` (`consumer`, `last_event_id`, `updated_at`) and
  `workos_events_processed` (`event_id` PK, `processed_at`) for idempotent replay.
- [ ] `api_key_cache` is **not** a table: use Redis (already deployed) with a 60 s TTL keyed by
  SHA-256 of the key.
- [ ] Models in `models.py`, SQLite-compatible for unit tests (JSON instead of arrays).
- [ ] Rule in code: upsert with `ON CONFLICT … WHERE excluded.workos_updated_at > t.workos_updated_at`.

**Exit:** `alembic upgrade head` and `downgrade -1` on Postgres and SQLite; existing API tests pass.

## Phase 3. api: sign-in, session and request context

New package `apps/api/src/studio_api/auth/` (`client.py`, `cookie.py`, `routes.py`,
`session.py`, `bootstrap.py`). All WorkOS calls use `AsyncWorkOSClient`.

- [ ] `client.py`: one `AsyncWorkOSClient(api_key, client_id, base_url, jwt_issuer)` per process,
  built from settings; nothing reads `WORKOS_*` directly.
- [ ] `GET /api/auth/login?return_to=…`: validate `return_to` is a same-origin path; random
  `state` + PKCE verifier in a short-lived (10 min) signed cookie (stateless replicas);
  `get_authorization_url(provider="authkit", redirect_uri, state, code_challenge, …)`; also
  accepts `organization_id`, `invitation_token`, `login_hint`, `screen_hint=sign-up`; 302.
- [ ] `GET /api/auth/callback`: handle `error` first; verify `state`;
  `authenticate_with_code(code, code_verifier, ip_address, user_agent)`; seal with
  `workos.session.seal_session_from_auth_response(...)` (the SDK quickstart's
  `session={"seal_session": …}` argument doesn't exist in 10.x); set the cookie (`HttpOnly;
  Secure; SameSite=Lax; Path=/`, host-only, max-age = maximum session); upsert `users` and the
  membership; if the token has no `org_id`, run `bootstrap.personal_org()` (create WorkOS org with
  `external_id`, our `organizations` row, membership as `admin`, `refresh(organization_id=…)`); 302 to
  `return_to`. The personal org is empty: no Samples membership (todo14 D2; today
  `ensure_principal` adds one), so a new person lands on the empty Home.
- [ ] `session.py` `current_session(request)`: `load_sealed_session(...).authenticate()`; on an
  expired JWT `await refresh()` and re-set the cookie on the response. `invalid_grant` → clear the
  cookie, 401. 408/429/5xx/JWKS failures → 503 and **keep** the cookie (never sign out on a
  transient error). Concurrent refreshes converge within WorkOS's 30 s replay window.
- [ ] `context.py` `resolve_context`: order is Bearer session token (unchanged) → Bearer API key
  (Phase 8) → cookie (`workos` mode) → dev headers (`dev` mode only). Add `org_id` and
  `permissions` to `RequestContext`; add `ctx.can(permission)` next to `ctx.allows(scope)`.
  Agent tokens: `can()` uses the delegating user's permissions (looked up by `on_behalf_of`,
  cached) **and** the token's scopes.
- [ ] Org boundary: `require_project` checks `project.org_id == ctx.org_id`, then
  `project_members` role (or org Admin). A project id from another org is a 404, not a 403.
- [ ] `GET /api/auth/session` → `{ user, organization: {id, name}, role, permissions,
  organizations: [...], impersonator, expiresAt }` for the SPA (memberships list cached 60 s).
- [ ] `POST /api/auth/switch-org {organizationId}` → `refresh(organization_id)`; if the org
  requires SSO/MFA the refresh fails → respond `{ redirect: <authorize URL with organization_id> }`.
- [ ] `POST /api/auth/logout` (POST + CSRF header, never GET) → `get_logout_url(return_to)`,
  clear the cookie, return the URL.
- [ ] `GET /api/auth/verify` (internal, for nginx `auth_request`): 200 with
  `X-Access-Token: <jwt>` (after refresh if needed) or 401. Not routed by the ingress.
- [ ] CSRF: state-changing `/api/*` requests with a cookie must carry `X-Requested-With:
  fetch` (the web `fetch` wrapper adds it); SameSite=Lax covers the rest.
- [ ] Audit: `auth.signed_in`, `auth.signed_out`, `auth.org_switched` rows in our audit
  table (ids only).
- [ ] `/readyz`: in `workos` mode, check the JWKS is reachable (cached), not on every probe.
- [ ] Unit tests with Emulate: sign-in, callback errors, tampered `state`, expired access token
  refresh, `invalid_grant`, transient 5xx keeps the session, cross-org project access.

**Exit:** with Emulate, `curl` through login → callback → `/api/auth/session` works; existing
API tests pass in `dev` mode; `uv run lint-imports`.

## Phase 4. Web: session, sign-in and the account menu

- [ ] `apps/web/src/studio/lib/session.ts`: `useSession()` (react-query on `/api/auth/session`,
  `staleTime` 60 s). In `dev` mode (or seed mode without an API) it returns the mock account, so
  the e2e suite keeps running unchanged.
- [ ] Boot: in `workos` mode, a 401 from `/api/auth/session` sends the browser to
  `/api/auth/login?return_to=<current path>`. A global react-query `onError` does the same for
  any 401 (session expired mid-work), after saving unsaved annotation state the way the Studio
  already does on navigation.
- [ ] The shared `fetch` wrapper adds `X-Requested-With: fetch` and `credentials: "same-origin"`.
- [ ] `user-menu.tsx`: name, email, User ID, Org ID, organization name from `useSession`; Log out
  calls `POST /api/auth/logout` and navigates to the returned URL.
- [ ] `switchers.tsx`: the hard-coded "Personal" organization switcher lists
  `session.organizations`; picking one calls `switch-org`, clears react-query caches and goes to
  `/`.
- [ ] Hide or disable controls by permission (`can("members:manage")`, …) in the settings pages;
  the API still enforces every check.
- [ ] `account-mock.ts` shrinks to what's still mocked (billing) as each phase lands; delete it at
  the end.
- [ ] e2e (`apps/web/e2e/auth_test.py`, `workos` mode against Emulate with `--interactive`
  login pages): sign in, menu shows the user, switch org, sign out, deep link survives login.

**Exit:** `pnpm typecheck`, `pnpm test`, all existing e2e tests in seed mode, the new auth e2e
against Emulate.

## Phase 5. Agent and kernel token

- [ ] Web nginx (`default.conf.template`): `location = /_auth { internal; proxy_pass
  http://api/api/auth/verify; proxy_pass_request_body off; proxy_set_header Cookie $http_cookie; }`;
  `/api/agent/` gets `auth_request /_auth; auth_request_set $token $upstream_http_x_access_token;
  proxy_set_header Authorization "Bearer $token";`. `STUDIO_AGENT_TOKEN` stays for
  service-to-service calls only.
- [ ] Dev: the Vite proxy for `/api/agent` does the same (call api `/api/auth/verify` with the
  browser's cookie, then forward the Bearer) when `auth.mode` is `workos`.
- [ ] Agent (`app.ts`): accept either the shared service token or a WorkOS access token
  (`workos.userManagement.verifyAccessToken`, client-id-only client if it works, else `jose` with
  the JWKS URL). Put `principal`, `org_id` on the run. SSE streams verify once at connect.
- [ ] `apps/agent/src/runtime/sessions.ts`: replace the single local principal (`principal ??
  "local"`) with the verified user; runs are keyed by user + project. Agent store migration: add
  `org_id` to `agent_sessions`, index (`owner`, `org_id`); listing conversations filters by both
  (todo14 §4). Existing rows on GKE are test data owned by `local`: leave them, nobody can list them.
- [ ] Cross-project path on GKE: the Studio's nginx (phi) forwards `Authorization: Bearer <WorkOS
  access token>` to the agent's ingress in `spurby-ai` over HTTPS. `AGENT_TOKEN` moves from
  `Authorization` (where nginx puts it today, `default.conf.template` line 42, checked in
  `app.ts` line 134) to its own header, `X-Agent-Service-Token`, which the agent still requires
  on browser-proxied calls, so the agent ingress stays closed to anything but our nginx.
  The token carries only ids (`sub`, `org_id`, `sid`), no names or emails, so nothing personal
  crosses into `spurby-ai` beyond what the transcript already holds.
- [ ] Kernel token (`kernel-token.ts` → `POST /v1/sessions`): the web call now carries the cookie,
  so the minted agent token's `on_behalf_of` is the real user. Scopes unchanged.
- [ ] Versioning JWT (`kernel/versioning/auth.py`): `actor` = `user:<sub>` or the agent, add an
  `org` claim; the Go side ignores unknown claims (check `jwt.go`).
- [ ] Revocation: `organization_membership.deleted/deactivated` events (Phase 7) delete kernel
  session tokens that are `on_behalf_of` that user in that org.
- [ ] e2e (`tests/e2e/agent_auth_test.py`): agent call without a session is 401; with one, the run
  records the user; a token from org A can't open org B's project.

**Exit:** `tests/e2e/agent_test.py` passes in both modes.

## Phase 6. Members, invitations, roles and project members

api routes (`routes/org.py`), all checking `ctx.can(...)`; they call WorkOS and update the mirror
immediately (events reconcile later).

| Route | Permission | WorkOS call (Python 10.6) |
|---|---|---|
| `GET /v1/org/members` | any member | local mirror (`users` ⨝ `organization_members`), plus project counts |
| `PATCH /v1/org/members/{membershipId}` `{role}` | `members:manage` | `organization_membership.update_organization_membership(id, role=RoleSingle(role_slug))` |
| `DELETE /v1/org/members/{membershipId}` | `members:manage` | `deactivate_organization_membership` (keeps history, revokes sessions) |
| `GET /v1/org/invitations` | `members:manage` | `user_management.list_invitations(organization_id)` |
| `POST /v1/org/invitations` `{emails[], role, projects[]}` | `members:manage` | `send_invitation(email, organization_id, role_slug, expires_in_days=7, inviter_user_id)`; project grants stored as pending `project_members` rows keyed by invitation id |
| `POST /v1/org/invitations/{id}/resend` | `members:manage` | `resend_invitation` |
| `DELETE /v1/org/invitations/{id}` | `members:manage` | `revoke_invitation` |
| `PATCH /v1/org` `{name, zeroRetention, aiAssist}` | `org:manage` | `organizations.update_organization(name)`; the two flags are our own columns |
| `GET/POST/PATCH/DELETE /v1/projects/{id}/members` | project owner or org Admin | local `project_members` |

- [ ] Guards: you can't change your own role or remove yourself; an org keeps at least one Admin;
  pending memberships can only be revoked.
- [ ] Role changes reach the affected user's token at their next refresh (≤ 5 min, D10). For the
  acting user, api refreshes their session in the same response.
- [ ] When an invitation is accepted (`invitation.accepted` + `organization_membership.created`),
  pending project grants become real `project_members` rows.
- [ ] Contracts: `packages/contracts` types `OrgMember`, `Invitation`, `ProjectMember`; run
  `pnpm emit:schemas`.
- [ ] Web: replace `useAccount` calls in `MembersPage`, `ProjectMembers`, `OrgPages`
  (`OrgSettingsPage`, `OrgProjectsPage` counts) with react-query hooks in
  `lib/org-api.ts`; keep the `data-testid`s (`members-table`, `invite-open`, `invite-email`,
  `invite-submit`, `project-add-user`, …).
- [ ] Domain constraint from WorkOS: invitations to consumer domains must match the address
  exactly; corporate domains accept any address on the same domain. Show WorkOS's error text.
- [ ] e2e (`tests/e2e/members_test.py` against Emulate): invite → accept as the second user →
  appears Active with the project role; role change hides org settings for that user after
  refresh; removing a member ends their agent session tokens.

**Exit:** the Team & Access and project Members pages work end to end against Emulate; nothing
on those pages reads `account-mock.ts`.

## Phase 7. Event sync

- [ ] `apps/worker`: `workos_sync` loop (one replica holds a Postgres advisory lock):
  `events.list_events(events=[…], after=<cursor>, limit=100)` every 5 s; per event, skip if in
  `workos_events_processed`, apply in a transaction, store the id and advance the cursor.
- [ ] Handlers (data only; side effects like revoking tokens run after commit):
  `user.created|updated|deleted`, `organization.created|updated|deleted`,
  `organization_membership.created|updated|deleted`, `invitation.created|accepted|revoked`,
  `session.created|revoked`, `organization_domain.*`, `api_key.created|revoked`,
  `connection.*`, `dsync.*` (later), `authentication.*` (into the our audit table).
- [ ] Out-of-order safety: create stubs for unknown users/orgs; never overwrite a newer
  `workos_updated_at`.
- [ ] `user.deleted`: tombstone, anonymize the display name, keep the principal on historical
  annotations, revisions and commits (provenance must survive).
- [ ] Nightly reconciliation job: `list_users`, `list_organization_memberships` per org; fix drift,
  log counts.
- [ ] Metrics: lag (now − newest processed event time), events/s, failures; alert if lag > 5 min.

**Exit:** changing a name or role in the WorkOS dashboard shows in the product within 10 s; replaying
the last 100 events changes nothing.

## Phase 8. API keys and MCP

- [ ] Routes: `GET/POST /v1/org/api-keys`, `DELETE /v1/org/api-keys/{id}` (`apikeys:manage`) →
  `api_keys.create_organization_api_key(organization_id, name, permissions, expires_at)`,
  `list_organization_api_keys`, `delete_api_key`. The secret is returned once and never logged.
- [ ] `resolve_context`: a Bearer that isn't a kernel session token is validated with
  `api_keys.create_validation(value)`, cached 60 s in Redis by SHA-256 of the key. Principal
  `apikey:<id>`, `org_id` from the owner, permissions = key permissions. Find the WorkOS key
  prefix in Phase 0 to route without a lookup.
- [ ] Key permissions map to kernel scopes (`datasets:read`, `annotations:write`,
  `studio:tools`, `admin`).
- [ ] `last used`: update a Redis timestamp on validation; the page shows it.
- [ ] Web: `ApiKeysPage` and `CreateKeyDialog` call the routes; keep `api-key-create`,
  `api-key-submit`, `api-key-secret`.
- [ ] MCP stdio: `STUDIO_MCP_API_KEY` sent as Bearer on every call; `STUDIO_MCP_AUTHOR`
  removed (the key's org and name identify the caller).
- [ ] Step-up: creating a key requires `auth_time` within 10 min, else the dialog sends the user
  through `/api/auth/login?max_age=600`.

**Exit:** a key created in the UI authenticates `apps/mcp` against a local stack; revoking it
stops the next call within 60 s.

## Phase 9. Security page: MFA, sessions, SSO, directory, domains

- [ ] MFA: `PATCH /v1/org/security {mfaRequired}` (`org:manage`) sets the WorkOS organization
  MFA policy (check the exact API in the organization-policies reference; if it's dashboard-only,
  the toggle becomes a link and a note). MFA doesn't apply to SSO users; say so on the page.
- [ ] Sign-in methods: per-org restrictions come from organization policies; environment-wide
  methods stay in the dashboard. Show what's on, read-only, unless the API allows per-org edits.
- [ ] Admin Portal: `POST /v1/org/admin-portal {intent}` (`org:manage`) →
  `admin_portal.generate_link(organization, intent, return_url, success_url,
  external_user_id=<principal>)`; intents `sso`, `dsync`, `domain_verification`, `audit_logs`,
  `log_streams`. The link lasts 5 min, so the button generates it on click and opens it in a new
  tab.
- [ ] Status: SSO connection, directory and domains from the local mirror (fed by `connection.*`,
  `dsync.*`, `organization_domain.*` events) or `list_connections`/`list_directories` with a
  60 s cache.
- [ ] Note on the page: setting up SSO disables the other sign-in methods for that organization
  (WorkOS behaviour).
- [ ] Session length is environment-wide in WorkOS: the Sessions control on the mocked page
  becomes read-only text unless WorkOS adds per-org limits.
- [ ] e2e: the Admin Portal button returns a URL on the Emulate host; MFA toggle round-trips.

**Exit:** an org Admin on staging verifies a domain and connects the WorkOS test identity
provider through the portal, then signs in with SSO.

## Phase 10. Audit log

- [ ] Source of truth stays the our audit table. Add the account events from Phases 3–9 so
  the Audit log page has sign-ins, membership changes, keys, exports and reviews.
- [ ] `GET /v1/org/audit?action&actor&before` (`audit:read`), paginated; the page drops the mock.
- [ ] CSV export from our own table (the "Export CSV" button), IDs and non-clinical labels only.
- [ ] Later (D13): forward a fixed set of actions to WorkOS Audit Logs
  (`audit_logs.create_event` with `idempotency_key`), define schemas first, and offer the
  `audit_logs` / `log_streams` Admin Portal intents for SIEM. Check retention pricing (30 days
  default, can't be lowered once raised).

**Exit:** every action on the settings pages appears in the Audit log with actor and IP.

## Phase 11. Your profile

- [ ] `PATCH /v1/me {firstName, lastName, marketing}` → `user_management.update_user`; `marketing`
  is our own column.
- [ ] Email change for password users: `send_email_change` → code → `confirm_email_change`;
  SSO-managed users see "managed by your organization".
- [ ] Sessions: `GET /v1/me/sessions` (`list_sessions(user_id)`), `DELETE /v1/me/sessions/{id}`
  (`revoke_session`), "Sign out other sessions". The current session is marked from `sid`.
- [ ] Authenticator app: link to the hosted AuthKit MFA enrollment, or the factor APIs
  (`multi_factor_auth.enroll_factor` …) if a custom flow is wanted; start with hosted.
- [ ] Web: `ProfilePage` on these routes; remove `SESSIONS` and `ACCOUNT` mocks.

**Exit:** name change shows in the account menu; signing out another session ends it at its next
refresh.

## Phase 12. Billing (outside WorkOS)

The usage, invoices and billing details pages stay mocked. When a billing provider is chosen
(Stripe is the obvious one), WorkOS's Stripe add-on can put `entitlements` in the access token
for plan gating; the `billing:manage` permission already guards the pages. Separate plan.

## Phase 13. Testing and CI

- [ ] `infra/workos/emulate.yaml`: users (`admin@example.com`, `member@example.com`,
  `billing@example.com`), two orgs, memberships, roles and permissions identical to the seed file,
  pinned ids.
- [ ] `tests/e2e/auth/` harness: start Emulate, api in `workos` mode pointing at it, Vite with
  `auth.mode=workos`; helper that signs in by password through the API and injects the cookie
  (never drive hosted AuthKit in CI: Radar and rate limits).
- [ ] The Emulate-backed api tests run in the regular `ci` workflow (fast, no browser). The
  browser auth e2e joins the e2e workflow, which is manual-only (`workflow_dispatch`) for the
  MVP; the seed-mode suite is unchanged.
- [ ] Test list: callback `error` and tampered `state`; refresh rotation; logout revokes; 5xx
  during refresh keeps the session; multi-org selection; org boundary; permission gates on every
  route in Phase 6/8/9; event replay idempotency; API key cache expiry.
- [ ] Nightly against WorkOS staging (real AuthKit): one sign-in with a staging test user, one
  invitation, one SSO sign-in with the staging test identity provider.

**Exit:** `e2e-auth` green in CI; `pnpm affected` and all checks in AGENTS.md pass.

## Phase 14. Production rollout

- [ ] WorkOS production environment: billing info added (required even when free), seed applied,
  redirect URIs https only, production API key into the k8s Secret (shown once).
- [ ] Custom AuthKit domain `auth.<host>` and email domain (before GA, $99/mo), DNS records.
- [ ] Email: custom sender domain so invitations don't come from a WorkOS address.
- [ ] Flip `prod` overlay to `workos` mode; staging first for a week with the team.
- [ ] GKE stage (`gke/phi`, `gke/ai`), the one actually deployed: add the stage's callback
  (`https://<studio host>/api/auth/callback`; the sslip.io name until real DNS) to the WorkOS
  staging environment's Redirects, flip `gke/phi` to `workos` mode with trust headers off, verify
  sign-in, then remove the `STUDIO_ALLOW_CIDRS` ingress allowlist. Keep the allowlist until
  sign-in works: without it the Studio is open to anyone who sends `X-Dev-Principal`.
- [ ] Migration of real data: none today (no production users). For any pilot org created before
  the switch: create the WorkOS org with `external_id`, invite its people, map principals.
- [ ] Runbook (`docs/running.md` + `infra/k8s/README.md`): rotate the cookie password (all
  sessions end), rotate the API key, WorkOS outage behaviour (signed-in users keep working until
  refresh fails transiently; new sign-ins fail), how to revoke a user everywhere.
- [ ] Dashboards: sign-in success/failure, refresh errors by kind, event sync lag, API key
  validation cache hit rate.

**Exit:** production sign-in, invitation and API key flows checked by hand; the staging nightly
is green for a week.

## Phase 15. Later (each needs its own decision)

- [ ] **FGA** for project and dataset sharing: resource types `project` (parent org) →
  `dataset`; roles `project-viewer | annotator | reviewer | admin`; checks with
  `organization_membership_id` from the JWT. Soft limit ~5,000 resources per type per org, so
  tasks, items and annotations stay local and inherit.
- [ ] **SSO and directory sync** per enterprise customer through the Admin Portal (paid per
  connection). Ask WorkOS support to enable Directory Provisioning so directory users become
  AuthKit users; IdP group → role mapping overrides roles set in our UI, so show "managed by your
  identity provider" on those members.
- [ ] **Remote MCP**: AuthKit as the OAuth authorization server (CIMD/DCR, resource indicator =
  MCP URL, `/.well-known/oauth-protected-resource`), tokens without permissions → look up the
  membership role (cached).
- [ ] **M2M** for customer pipelines: Connect M2M applications per customer org.
- [ ] **Impersonation** for support: banner, exports blocked while `act` is present, 60 min,
  audited with reason.
- [ ] **Invite-only organizations** and **domain capture** (JIT membership by verified domain).
- [ ] **Groups** (WorkOS) if the Nebius-style group column on Team & Access becomes real.

---

## 3. Order and size

| Phase | Depends on | Size | Can run in parallel with |
|---|---|---|---|
| 0 Dashboard, procurement | – | 1 day + sales thread | everything |
| 1 Config, secrets | 0 (names only) | 0.5 day | 2 |
| 2 Data model | – | 1 day | 1 |
| 3 api sign-in and context | 1, 2 | 3–4 days | 4 (against a stub) |
| 4 Web session | 3 | 2 days | 5 |
| 5 Agent | 3 | 2 days | 4, 6 |
| 6 Members, invitations, project members | 3, 4 | 3 days | 7 |
| 7 Event sync | 2, 3 | 2 days | 6 |
| 8 API keys, MCP | 3 | 2 days | 6, 7 |
| 9 Security page | 6 | 1.5 days | 10, 11 |
| 10 Audit log | 3 | 1 day | 9, 11 |
| 11 Profile | 4 | 1 day | 9, 10 |
| 13 Testing, CI | grows with each phase | 2 days | – |
| 14 Production | all above | 2 days + a week on staging | – |

**Minimum sign-in (do first, about 1.5 weeks).** What an MVP with real people needs, and what
todo14 builds on:

- Phase 0 (dashboard, Redirects, Sessions; send the sales questions but don't wait for answers
  before building against staging);
- Phases 1 and 2 (only `users`, the `organizations` and `organization_members` columns;
  `project_members` waits for Phase 6);
- Phase 3 (sign-in, cookie, `resolve_context`, the org boundary, personal org bootstrap without
  Samples);
- Phase 4 (session, account menu, org switcher);
- Phase 5 (agent verifies the user; conversations keyed by user and org);
- from Phase 6, only "invite by email" and "remove member", against WorkOS directly;
- Phase 13's Emulate api tests; Phase 14's GKE step.

Phases 7–11 and the rest of 6 follow when a second organization uses the product. Until Phase 7
lands, a name or role changed in the WorkOS dashboard shows at the person's next sign-in.

About four weeks of work for one person, or two weeks with two working in parallel worktrees
(`.worktrees/todo9-api` for Phases 1–3, 5, 7, 8; `.worktrees/todo9-web` for 4, 6, 9–11 against
the API contract from Phase 3).

## 4. Gotchas to remember while building

1. The Python cookie password must be a Fernet key, not "any 32 characters" as the Node docs say.
2. Python SDK 10.x differs from the AuthKit Python quickstart: seal with
   `workos.session.seal_session_from_auth_response`; memberships are under
   `organization_membership`; widget tokens are `widgets.create_token`. Pin `<11`, and iterate
   lists with `auto_paging_iter()` (in v11, iterating a page yields only that page).
3. Refresh tokens rotate on every use: always write the new cookie back.
4. Never sign people out on 408/429/5xx/JWKS errors.
5. Role changes and revocations bite at the next refresh; keep access tokens short.
6. Membership id ≠ user id for role updates.
7. Check permissions, not role slugs (custom org roles use `org-…` slugs).
8. The cookie holds both tokens, the user and permissions: watch the ~4 KB limit; keep the JWT
   template and permission slugs short; don't put many feature flags in the token.
9. Redirect URIs match exactly (trailing slash included); production requires https.
10. Without an Initiate login URI, invitations and password resets break.
11. Admin Portal links expire in 5 minutes: generate on click.
12. Rate limits are per API key and per WorkOS environment: cache API key validations and
    membership lookups.
13. The SDKs read unprefixed `WORKOS_*` env vars on their own: never set them (naming check,
    implicit config).
14. WorkOS hosts in the US only and signs a BAA only on enterprise plans.

## Appendix A. Mock → real, per UI action

| UI action (settings-mock) | testid | Real call |
|---|---|---|
| Invite (Team & Access) | `invite-open`, `invite-email`, `invite-submit` | `POST /v1/org/invitations` → `send_invitation` |
| Resend / revoke invitation | row menu | `resend_invitation` / `revoke_invitation` |
| Change role | row menu › Change role | `update_organization_membership(role=RoleSingle)` |
| Remove from organization | row menu | `deactivate_organization_membership` |
| Add user to project | `project-add-user`, `add-user-submit` | `POST /v1/projects/{id}/members` (local) |
| Change project role / remove | row menu | local `project_members` |
| Create API key | `api-key-create`, `api-key-submit`, `api-key-secret` | `create_organization_api_key` |
| Revoke API key | row menu | `delete_api_key` |
| Require MFA | `mfa-required` | organization MFA policy |
| Set up SSO / Connect directory / Add domain | buttons on Security | `admin_portal.generate_link(intent=sso \| dsync \| domain_verification)` |
| Organization name, zero retention, AI suggestions | `zero-retention` | `update_organization(name)` + our columns |
| Profile name, marketing | – | `update_user` + our column |
| Sign out other sessions | – | `list_sessions` + `revoke_session` |
| Log out (account menu) | `user-menu` | `POST /api/auth/logout` → `get_logout_url` |

## Appendix B. Questions for WorkOS (send in Phase 0)

1. BAA: which plan, what price, does it cover Events and Audit Logs data?
2. Any EU or dedicated-region hosting on enterprise plans?
3. Exact `iss` of session access tokens, with and without a custom domain.
4. Default access-token lifetime and the allowed range.
5. Can `verifyAccessToken` in `@workos-inc/node` run with only a client id (no API key on the
   agent)?
6. Prefix/format of organization and user API key values.
7. Pricing of API keys, FGA, Connect/M2M, MCP auth, Feature Flags.
8. Can the organization MFA policy and sign-in methods be set by API, or only in the dashboard?
9. Are extra non-production environments (a separate "dev") free?
