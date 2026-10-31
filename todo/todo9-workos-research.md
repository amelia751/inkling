# WorkOS for Inkling — research dossier

Prepared 2026-10-30 for whoever writes the step-by-step implementation plan. No repo code was
changed. Sources: the local WorkOS skill (`~/.cursor/skills/workos/` + `workos-widgets/`), the
live docs (`https://workos.com/docs/llms.txt` and the `.md` version of every page cited below,
fetched today), the published SDK packages (inspected from PyPI / npm / the Go module proxy), the
WorkOS security page, the DPA and the 2026 changelog.

Conventions in this file:

- **UNVERIFIED** = I could not confirm it in a doc fetched today; treat as a question for WorkOS
  support or a staging spike.
- **SKILL DRIFT** = the local skill says something the live docs / published SDK contradict. The
  live source wins.
- Dashboard locations are described conceptually ("the application's Redirects tab", "the
  Authorization page") because the docs use those words. No click-paths are invented.
- Terminology collision to keep straight in the plan: Inkling **environment** = the Studio JSON
  spec; WorkOS **environment** = staging/production instance. Inkling **stage** = dev/staging/prod
  k8s overlay. Inkling **Organization** (`organizations` table, "Workspace" in UI copy) maps to a
  **WorkOS Organization**; Inkling **Workspace** (kernel, 1:1 with a project) has no WorkOS
  equivalent. In this file "WorkOS env" always means the WorkOS one.

---

## 0. TL;DR

1. Use **AuthKit (hosted UI)** with a **backend-for-frontend (BFF) login in `apps/api`**: FastAPI
   owns `/api/auth/login|callback|logout|switch-org|session`, exchanges the code with the Python
   SDK and stores a **sealed session cookie** (HttpOnly, Secure, SameSite=Lax). The SPA never sees
   a refresh token. Do **not** use `@workos-inc/authkit-react-router` (framework-mode only, needs
   a server) and only consider `@workos-inc/authkit-react` if you also buy a custom AuthKit
   domain (otherwise the refresh token sits in `localStorage`).
2. Services validate **WorkOS access-token JWTs against JWKS**
   (`https://api.workos.com/sso/jwks/<client_id>`). `api` reads it out of the sealed cookie;
   `agent` receives it as a Bearer that **nginx injects via `auth_request`** (replacing the shared
   `INKLING_AGENT_TOKEN` for user traffic). `versioning`, `worker` keep their internal
   Inkling-minted credentials (no WorkOS needed). `mcp` becomes an OAuth resource server with
   **AuthKit as the authorization server** when it goes remote (HTTP transport); stdio stays on
   user API keys or CLI Auth (device flow).
3. Products **now**: AuthKit (sessions, orgs, memberships, invitations, RBAC roles/permissions,
   domain verification + JIT, MFA policy, impersonation), Events API (sync), Admin Portal
   (SSO/Directory Sync self-serve), API Keys (org + user scoped), Widgets or the headless widget
   API for the members/API-keys/profile pages. **Later**: SSO + Directory Sync per enterprise
   customer (paid per connection), Audit Logs (paid streaming/retention), FGA (projects/datasets
   ACL), Feature Flags, MCP auth via Connect, M2M apps, custom domains. **No**: Pipes, Vault
   (Inkling has its own secrets broker), Radar standalone API, standalone SSO/MFA APIs.
4. **Compliance blocker to resolve first**: WorkOS will sign a **HIPAA BAA only on enterprise
   plans** and is **US-hosted only (no EU region)**. Identity data (names, emails, IPs) goes to
   WorkOS; never put PHI in WorkOS metadata, JWT templates, audit-log metadata, org names or
   feature-flag targets.

---

## 1. Product map

| WorkOS product | What it does | Inkling | Why |
|---|---|---|---|
| **AuthKit** (User Management) | Hosted sign-in/up UI, email+password, social, passkeys, magic auth, MFA (TOTP), SSO routing, sessions (JWT access + rotating refresh), users, organizations, memberships, invitations, roles. [docs](https://workos.com/docs/authkit), [hosted UI](https://workos.com/docs/authkit/hosted-ui) | **Now** | Replaces `dev_trust_headers` / `X-Dev-Principal` with real identity. Free to 1M MAU. |
| **Organizations + memberships** | Tenant object; users ↔ orgs with `pending/active/inactive` memberships; multi-org users; custom roles per org. [users-organizations](https://workos.com/docs/authkit/users-organizations) | **Now** | Maps 1:1 onto Inkling `organizations` / `organization_members`. |
| **RBAC** (roles + permissions) | Environment roles, org-scoped custom roles, multiple roles per membership, permissions in the JWT. [roles-and-permissions](https://workos.com/docs/authkit/roles-and-permissions), [rbac/configuration](https://workos.com/docs/rbac/configuration), [custom roles](https://workos.com/docs/rbac/custom-roles) | **Now** | Org-level gates (manage members, billing, create project) straight from `permissions` claim. |
| **Invitations** | Org invites by email, resend/revoke, invite-only signup. [invitations](https://workos.com/docs/authkit/invitations) | **Now** | "Members › Invites" page. |
| **Domain verification + JIT** | DNS TXT via Admin Portal; auto-membership by verified domain; SSO JIT. [domain-verification](https://workos.com/docs/authkit/domain-verification), [jit-provisioning](https://workos.com/docs/authkit/jit-provisioning) | **Now** (feature flagged per org) | Hospitals/labs want "everyone @ourhospital.org joins our org". |
| **Organization policies** | Domain policy, require SSO, require MFA per org. [organization-policies](https://workos.com/docs/authkit/organization-policies) | **Now** | Medical customers will demand MFA. |
| **MFA in AuthKit** | Built-in TOTP enrollment/challenge in hosted UI; env-wide "Required" or per-org policy; not for SSO users. [authkit/mfa](https://workos.com/docs/authkit/mfa) | **Now** (config only) | No code; standalone MFA API not needed. |
| **Impersonation** | WorkOS staff/dashboard admin signs in as a user; `act` claim + `impersonator` field; 60-min sessions; `session.created` records reason. [impersonation](https://workos.com/docs/authkit/impersonation) | **Later**, gated | Useful for support but a PHI-exposure path; enable only with policy + UI banner + audit. |
| **Re-authentication (step-up)** | `auth_time` claim + `max_age` on authorize URL. [reauthentication](https://workos.com/docs/authkit/reauthentication) | **Now/soon** | Before export of datasets, deleting projects, rotating API keys. |
| **Admin Portal** | WorkOS-hosted setup UI for the customer's IT admin: SSO, Directory Sync, domain verification, audit logs view, log streams, cert renewal, BYOK. Links expire in 5 min. [admin-portal](https://workos.com/docs/admin-portal), [generate link](https://workos.com/docs/reference/admin-portal/portal-link/generate) | **Now** (domain verification) / **Later** (SSO, dsync) | Zero UI to build for enterprise onboarding. |
| **SSO** (via AuthKit) | SAML/OIDC per org; routing by domain; IdP group → role mapping. [authkit/sso](https://workos.com/docs/authkit/sso), [sso/test-sso](https://workos.com/docs/sso/test-sso) | **Later** (per enterprise deal) | $125/connection/month. No code beyond AuthKit. |
| **Directory Sync** (+ Directory Provisioning) | SCIM/HRIS → directory users/groups → (with Directory Provisioning, enabled by WorkOS support) AuthKit users + memberships + role mapping. [quick-start](https://workos.com/docs/directory-sync/quick-start), [directory-provisioning](https://workos.com/docs/authkit/directory-provisioning) | **Later** | Deprovisioning is the HIPAA-relevant win. Paid per connection. |
| **Groups** (WorkOS-native) | Named sets of memberships in an org; group role assignments; FGA subjects. [groups](https://workos.com/docs/authkit/groups) | **Later** | Matches the Nebius-style "Groups" tab; can wait. |
| **API Keys** | Org-scoped and user-scoped keys with permissions; validate endpoint; widget; `api_key.*` events. [api-keys](https://workos.com/docs/authkit/api-keys) | **Now** | The "Service accounts / API keys" settings page and the stdio MCP credential. |
| **Connect** (OAuth apps / M2M) | WorkOS as an OAuth 2.0/OIDC authorization server for third-party apps; M2M = client_credentials per customer org. [connect](https://workos.com/docs/authkit/connect), [m2m](https://workos.com/docs/authkit/connect/m2m) | **Later** | M2M for customer integrations (pipelines pushing data). |
| **MCP auth** | AuthKit as the MCP OAuth AS: CIMD/DCR, resource indicators, `/.well-known/oauth-protected-resource`. [authkit/mcp](https://workos.com/docs/authkit/mcp) | **Later** (when `apps/mcp` gets HTTP transport) | Lets Claude/Cursor connect to a hosted Inkling MCP with the user's identity. |
| **CLI Auth** (device flow) | RFC 8628 device authorization for CLIs/native. [cli-auth](https://workos.com/docs/authkit/cli-auth) | **Later** | Option for stdio MCP / an Inkling CLI login. |
| **API Gateway** | Managed reverse proxy that turns API key or AuthKit session into a signed `X-WorkOS-Gateway-Assertion` JWT. **Beta, contact WorkOS.** [api-gateway](https://workos.com/docs/authkit/api-gateway) | **No (for now)** | Interesting but beta and would route medical API traffic through WorkOS; not compatible with "no PHI to third parties". |
| **JWT templates** | One per WorkOS env; add custom claims (membership id, metadata); ≤3072 bytes rendered. [jwt-templates](https://workos.com/docs/authkit/jwt-templates) | **Now** (add `organization_membership_id`) | Needed for FGA checks and for cheap membership id lookups. |
| **Actions** | Synchronous allow/deny webhooks on authentication and user registration. [actions](https://workos.com/docs/authkit/actions) | **Later** | E.g. block registration from unapproved domains for a hospital deployment. |
| **Events API / Webhooks** | Event stream (`user.*`, `organization_membership.*`, `invitation.*`, `session.*`, `dsync.*`, `api_key.*`, …). [data-syncing](https://workos.com/docs/events/data-syncing) | **Now** (Events API) | Keep local mirror tables in sync. |
| **Audit Logs** | Customer-facing audit trail per org, export CSV, log streams to SIEM, platform events. [audit-logs](https://workos.com/docs/audit-logs) | **Later** | Inkling already has `plugin_audit`; WorkOS Audit Logs is for *customer-visible* export/SIEM. Watch metadata for PHI. |
| **FGA** | Resource-scoped roles on a hierarchy (org → project → dataset), access checks <50 ms p95. [fga](https://workos.com/docs/fga) | **Later** | Project/dataset sharing; keep annotations/items out (high-cardinality). |
| **Feature Flags** | Flags in `feature_flags` claim; org/user targeting; Node runtime client for custom targets. [feature-flags](https://workos.com/docs/feature-flags) | **Later / optional** | Inkling already has `extension-host/flags.ts`; WorkOS flags only if per-customer rollout is needed. |
| **Stripe Entitlements** | `entitlements` claim from Stripe subscriptions. [add-ons/stripe](https://workos.com/docs/authkit/add-ons/stripe) | **Later** (if billing on Stripe) | Workspace balance/billing page. |
| **Widgets** | React components (User Management, User Profile, User Security, User Sessions, API Keys, Org Switcher, Admin Portal SSO/Domain). Peer deps Radix Themes + TanStack Query. [widgets](https://workos.com/docs/widgets/quick-start) | **Now (headless)** | Inkling is shadcn/Tailwind: call the widget endpoints with a widget token and render with `@studio/ui` (see §4.15). |
| **Custom domains** | AuthKit domain (`auth.<inkling>`), email domain, Admin Portal domain; prod only; $99/mo. [custom-domains](https://workos.com/docs/custom-domains) | **Later** (before GA) | Branding + required if using `authkit-react`. |
| **Email** | WorkOS sends invites/magic/verification; custom sender domain or own provider. [email](https://workos.com/docs/email) | **Now** (config) | Configure sender domain; consider custom email provider for deliverability limits. |
| **Radar** | Bot/fraud protection, built into hosted AuthKit. [authkit/radar](https://workos.com/docs/authkit/radar) | **Config only** | Standalone API not needed. |
| **Vault** | EKM / encrypted KV per org, BYOK. [vault](https://workos.com/docs/vault) | **No** | Inkling has its own secrets broker; sending secrets to WorkOS is a new third-party data flow. |
| **Pipes** | OAuth to third-party data providers for your users. [pipes](https://workos.com/docs/pipes) | **No** | Not a use case today. |
| **Standalone SSO API / standalone MFA API** | Pre-AuthKit APIs | **No** | AuthKit covers both. |
| **WorkOS Emulate** | Open-source in-memory WorkOS API emulator for tests. [authkit/testing](https://workos.com/docs/authkit/testing) | **Now** (dev/CI) | Fits Inkling's "e2e with frozen fixtures" culture. |

---

## 2. Recommended architecture

### 2.1 Choice of AuthKit pattern

Three documented patterns were evaluated against Inkling's shape (static SPA behind nginx,
same-origin `/api` and `/api/agent`, stateless replicas, medical data):

| Pattern | How | Verdict |
|---|---|---|
| **A. Backend-hosted login + sealed session cookie (BFF in `apps/api`)** | Python SDK `get_authorization_url` → hosted AuthKit → `GET /api/auth/callback` → `authenticate_with_code` → seal `{access_token, refresh_token, user}` into an HttpOnly cookie → every request `load_sealed_session(...).authenticate()` / `.refresh()`. [authkit/vanilla/python](https://workos.com/docs/authkit/vanilla/python), [sessions](https://workos.com/docs/authkit/sessions) | **Recommended.** Matches the docs' guidance that "the access token should be stored as a secure cookie … refresh token … secure cookie or persisted on your backend" ([sessions#integrating-sessions](https://workos.com/docs/authkit/sessions)). No tokens in JS, works in staging without a custom domain, stateless (cookie carries state, cookie password shared via k8s Secret). |
| **B. Client-only `@workos-inc/authkit-react`** | `<AuthKitProvider clientId apiHostname>`; SDK does PKCE in the browser; `getAccessToken()` → `Authorization: Bearer` to api/agent; every service verifies JWKS. [authkit/react](https://workos.com/docs/authkit/react), [sdks/authkit-react](https://workos.com/docs/sdks/authkit-react) | Viable **only with a custom AuthKit domain** in prod: "If you have not set up a custom authentication domain in WorkOS, set `devMode={true}` … This will keep the refresh token in local storage instead of a secure, HTTP-only cookie." `devMode` auto-enables on localhost. Also: cannot be nested in an iframe; needs CORS origin configured. Access token lives in JS memory. |
| **C. `@workos-inc/authkit-react-router`** | Loaders `authLoader` / `authkitLoader` | **Not applicable.** README: "early-stage port … features focus on framework mode (e.g. Remix)" — requires server loaders. Inkling uses `createBrowserRouter` in a static SPA (no Node server for web). **SKILL DRIFT**: the router's framework detection would route Inkling (has `react-router`) to this reference; ignore it. |

Why A over B for Inkling specifically:

- Medical product: keep long-lived credentials (refresh tokens) out of JS entirely.
- `api` already owns request context (`studio_api/context.py` `resolve_context`), audit and
  permission checks; the cookie slots into that one function.
- Org switching, invitation acceptance, step-up and logout are server-side redirects — easy in
  FastAPI, no SPA state machine.
- Works in local dev and staging (`*.authkit.app` domain) without paying for a custom domain.
- Downside: the SPA needs an endpoint to learn "who am I" (`GET /api/auth/session`) and a way to
  feed tokens to Widgets (§4.15). Both are small.

### 2.2 Request flow (target)

```text
Browser (SPA, same origin)
  │  cookie: inkling_session=<sealed {access_token, refresh_token, user}>   (HttpOnly, Secure, Lax)
  ├── /api/auth/*  ─────────────► api (FastAPI)  — login/callback/logout/switch-org/session
  ├── /api/*       ─────────────► api            — resolve_context(): unseal → verify JWT (JWKS)
  │                                               → RequestContext(principal="user:<workos user id>",
  │                                                  org_id=claims.org_id, permissions=claims.permissions)
  └── /api/agent/* ─► nginx ──auth_request /api/auth/verify──► api (200 + X-Inkling-Access-Token: <JWT>)
                        └── proxy_pass agent with Authorization: Bearer <WorkOS access token JWT>
                            agent: workos.userManagement.verifyAccessToken(token) → claims
agent ──(Inkling session token, minted by api POST /v1/sessions, on_behalf_of=user:<id>)──► api
api   ──(Ed25519 60 s JWT, unchanged)──► versioning (Go)
worker──(Inkling session token, unchanged)──► api
MCP client ──OAuth (AuthKit = AS, aud = MCP resource URL)──► mcp (HTTP)  [later]
MCP stdio  ──user API key (WorkOS API Keys, validated by api)──► api     [now]
WorkOS ──(Events API pull by worker; or webhooks)──► api/worker → mirror tables
```

### 2.3 Per-service identity validation

| Service | Inbound credential | How to validate | Notes |
|---|---|---|---|
| **api** (Python) | Sealed cookie from the browser | `workos_client.user_management.load_sealed_session(session_data=..., cookie_password=...)` → `.authenticate()` (verifies RS256 against JWKS with PyJWT, returns `organization_id`, `role`, `roles`, `permissions`, `entitlements`, `feature_flags`, `session_id`, `user`, `impersonator`). On `authenticated=False` with an expired JWT call `.refresh()` and re-set the cookie. SDK source: `workos/session.py` (v10.6.0). | Keep the existing Bearer path for Inkling session tokens (agents/workers) and the dev header path behind `dev_trust_headers`. |
| **api** | `Authorization: Bearer <WorkOS API key>` (customer API keys / stdio MCP) | `workos_client.api_keys.create_validation(value=token)` → `result.api_key` (owner org/user, permissions) or `None`. [api-keys#validating-api-keys](https://workos.com/docs/authkit/api-keys) | Cache validation result for a short TTL keyed by a hash of the key (it's a network call per request; counts toward 6,000 req/min/API key). Distinguish WorkOS API keys from Inkling session tokens by prefix (**UNVERIFIED** what prefix WorkOS user/org API keys carry — check one in staging). |
| **agent** (Node, Hono) | `Authorization: Bearer <WorkOS access token>` injected by nginx | `new WorkOS(apiKey, { clientId, issuer })` then `await workos.userManagement.verifyAccessToken(token)` → claims or `null`. README: checks signature vs JWKS, expiry, issuer (if configured), and "that the token is a user access token rather than one WorkOS signed for another purpose, such as an agent or widget token". [workos-node README](https://github.com/workos/workos-node) | Keep `INKLING_AGENT_TOKEN` only for internal service calls (api→agent if any). SSE streams are long-lived; verify once at connect, then rely on exp of the *stream*, not the token (access tokens are short). |
| **versioning** (Go) | Inkling Ed25519 JWT minted by api (60 s) | Unchanged. | Put `actor.id = user:<workos user id>`, `org` claim into the minted JWT. Go SDK (`github.com/workos/workos-go/v10`) not needed here. If ever needed: `workos.NewSession(client, cookie, password).Authenticate()` or verify JWT with JWKS. |
| **worker** (Python) | Inkling session token | Unchanged. | Worker is a good home for the **Events API consumer** (single consumer, cursor in Postgres). |
| **mcp** (stdio, now) | User API key from env (`INKLING_MCP_API_KEY`), or tokens from CLI Auth device flow | api validates as above. | Device flow: `POST https://api.workos.com/user_management/authorize/device` then poll `/user_management/authenticate` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. [cli-auth](https://workos.com/docs/authkit/cli-auth) |
| **mcp** (HTTP, later) | Connect access token (`aud` = MCP resource URL) | `jose.jwtVerify(token, createRemoteJWKSet('https://<authkit_domain>/oauth2/jwks'), { issuer: 'https://<authkit_domain>', audience: '<MCP URL>' })`; 401 with `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource"`. [authkit/mcp](https://workos.com/docs/authkit/mcp) | Connect tokens **have no `permissions` claim**: resolve via membership + role API (cache ~60 s) or add `roles` with a JWT template. [connect/token-claims](https://workos.com/docs/authkit/connect/token-claims) |

Why not forward the sealed cookie to the agent: **sealed cookies are not interoperable across
SDK languages.** Python v10 seals with **Fernet** (`cryptography.fernet`, `workos/session.py`);
Node seals with the iron format (sealed strings start `Fe26.2*…`, see
[refresh-and-seal-session-data](https://workos.com/docs/reference/authkit/authentication/refresh-and-seal-session-data));
Go has its own `Seal/Unseal`. So exactly one service (api) owns the cookie and everything else
gets a JWT.

Alternative to `auth_request` (simpler, slightly weaker): `GET /api/auth/token` returns the
current access token JSON to the SPA, which sends it as Bearer to `/api/agent`. Exposes the
short-lived access token to JS (not the refresh token). Pick one in the plan; `auth_request`
keeps "no tokens in JS".

### 2.4 Tenancy mapping

- WorkOS Organization ⇄ Inkling `organizations` row. Set WorkOS `external_id` = Inkling org id
  (≤64 chars, unique per WorkOS env) and/or store `workos_org_id` on the Inkling row.
  [metadata](https://workos.com/docs/authkit/metadata)
- Personal orgs (`kind=personal`): create a WorkOS org per user on first sign-in when the token
  has no `org_id` (docs' "Creating organizations for new users" recipe: check `org_id` → create
  org → create membership → refresh with `organization_id`).
  [users-organizations](https://workos.com/docs/authkit/users-organizations). Organizations are
  unlimited ("There is no limit to the number of organizations you can create").
- Principal format: `user:<workos user id>` (e.g. `user:user_01H…`). Keep `principal` strings
  as the internal key so versioning/audit code doesn't change shape.
- Inkling project/dataset ACLs: local tables now (`project.visibility`), FGA later.

---

## 3. SDKs, versions, init, env vars, dashboard settings

### 3.1 Packages (latest published as of 2026-10-30)

| Where | Package | Version | Runtime req. | Notes |
|---|---|---|---|---|
| `apps/api`, `apps/worker` | `workos` (PyPI) | **10.6.0** | Python ≥3.10 | `WorkOSClient` / `AsyncWorkOSClient` (identical async surface — use async in FastAPI). Depends on `httpx2`/`httpx`, PyJWT, `cryptography`. README on `main` already talks about **v11** (pagination change) — pin `workos>=10.6,<11`. |
| `apps/agent` (+ `apps/mcp` if HTTP) | `@workos-inc/node` | **12.1.0** | Node ≥22.11 | Inkling uses Node 24 ✓. `verifyAccessToken`, `apiKeys.createValidation`, `widgets.createToken`, `webhooks.constructEvent`. |
| `apps/web` (only if pattern B or Widgets UI) | `@workos-inc/authkit-react` | 0.16.3 | react ≥17 | Not needed for pattern A. |
| `apps/web` (only if WorkOS-styled widgets) | `@workos-inc/widgets` | 1.20.2 | peers: react ≥18, `@radix-ui/themes` ^3.3, `@tanstack/react-query` ^5 | Radix Themes is a second design system next to shadcn — prefer headless (§4.15). |
| `apps/versioning` (only if needed) | `github.com/workos/workos-go/v10` | **v10.6.0** | Go ≥1.23 | Flat root package: `workos.NewClient(apiKey, workos.WithClientID(id))`. **SKILL DRIFT**: skill says `workos-go/v4` + `usermanagement.SetAPIKey`; that is 6 majors old. Docs' JWKS example still shows `v2/pkg/usermanagement` — stale. |
| tests | `@workos/emulate` (npm) / `workos-emulate` (brew) | latest | — | In-memory WorkOS API on `:4100`, API key `sk_test_default`. [authkit/testing](https://workos.com/docs/authkit/testing) |
| ops (optional) | `workos` CLI (`npx workos@latest`) | 0.24.0 | Node ≥18 | `workos seed --file=…` for staging fixtures. Verify any command with `workos --help --json` before scripting it. |

### 3.2 Init shapes (verified against published packages)

```python
# apps/api — config module only (AGENTS.md: env read in config)
from workos import AsyncWorkOSClient
workos = AsyncWorkOSClient(
    api_key=settings().workos_api_key,       # INKLING_API_WORKOS_API_KEY
    client_id=settings().workos_client_id,   # INKLING_API_WORKOS_CLIENT_ID
    jwt_issuer=settings().workos_issuer,     # optional; enforces `iss` (else not validated)
    # base_url=... for the emulator (WORKOS_BASE_URL also read from env)
)
# login
url = workos.user_management.get_authorization_url(
    provider="authkit", redirect_uri=..., state=..., organization_id=None,
    login_hint=None, screen_hint=None)   # (also code_challenge/_method for PKCE; prompt; max_age via reauth docs)
# callback
auth = await workos.user_management.authenticate_with_code(code=code, ip_address=ip, user_agent=ua)
from workos.session import seal_session_from_auth_response
sealed = seal_session_from_auth_response(
    access_token=auth.access_token, refresh_token=auth.refresh_token,
    user=auth.user.to_dict(), impersonator=(auth.impersonator.to_dict() if auth.impersonator else None),
    cookie_password=settings().workos_cookie_password)
# per request
s = workos.user_management.load_sealed_session(session_data=cookie, cookie_password=pw)
r = s.authenticate()          # .authenticated, .organization_id, .role, .roles, .permissions, .user, .session_id, ...
r2 = await s.refresh(organization_id=None)   # .authenticated, .sealed_session (new cookie)
logout_url = await s.get_logout_url(return_to=None)
```

**SKILL/DOC DRIFT (Python):** the AuthKit Python quickstart still shows
`authenticate_with_code(code=..., session={"seal_session": True, "cookie_password": ...})` and
`auth_response.sealed_session`. In the published **10.6.0** `authenticate_with_code` takes only
`code, code_verifier, invitation_token, ip_address, device_id, user_agent, signals_id` — sealing
is the separate `workos.session.seal_session_from_auth_response(...)`. Verify the `auth.user`
serialization method (`to_dict()` per README "dataclass … `from_dict()` / `to_dict()`").
Also: memberships moved to `workos_client.organization_membership.*` (not
`user_management.list_organization_memberships` as the skill's RBAC example shows), and widget
tokens are `widgets.create_token(...)` (skill says `get_token`).

```ts
// apps/agent
import { WorkOS } from '@workos-inc/node';
const workos = new WorkOS(process.env.INKLING_AGENT_WORKOS_API_KEY, {
  clientId: process.env.INKLING_AGENT_WORKOS_CLIENT_ID,
  issuer: process.env.INKLING_AGENT_WORKOS_ISSUER,   // optional
});
const claims = await workos.userManagement.verifyAccessToken(bearer); // null if invalid
```

(Agent needs only the client id to build the JWKS URL; whether `verifyAccessToken` works with a
client-id-only "public client" `new WorkOS({ clientId })` is **UNVERIFIED** — if it does, the
agent doesn't need the API key at all, which is preferable. Otherwise use `jose` with
`https://api.workos.com/sso/jwks/<client_id>` directly.)

### 3.3 Environment variables

AGENTS.md requires `INKLING_<ROLE>_<KEY>` names read only in each service's config module. The
SDK also auto-reads `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_BASE_URL`, `WORKOS_ISSUER` (Python
README) / `WORKOS_API_KEY` (Node README) — **do not set those unprefixed names in k8s**; pass values
explicitly so `pnpm check:names` stays green and nothing is picked up implicitly.

| Var | Service | Secret? | Purpose |
|---|---|---|---|
| `INKLING_API_WORKOS_API_KEY` | api, worker | yes | `sk_…` server key (prod key shown **once** at creation) |
| `INKLING_API_WORKOS_CLIENT_ID` | api, worker | no | `client_…`; also used for JWKS URL |
| `INKLING_API_WORKOS_COOKIE_PASSWORD` | api | yes | Session seal key. **Python needs a Fernet key** (32 url-safe-base64 bytes). Tested: `openssl rand -base64 32` output is accepted by `Fernet()`; an arbitrary 32-char ASCII password is **rejected** ("Fernet key must be 32 url-safe base64-encoded bytes"). Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Same value on all replicas. |
| `INKLING_API_WORKOS_REDIRECT_URI` | api | no | e.g. `https://<host>/api/auth/callback`; must match a dashboard Redirect URI exactly (trailing slash included) |
| `INKLING_API_WORKOS_ISSUER` | api | no | expected `iss` (see §5 — exact value **UNVERIFIED**) |
| `INKLING_API_WORKOS_WEBHOOK_SECRET` | api | yes | only if webhooks are used; shown once |
| `INKLING_API_WORKOS_BASE_URL` | api, worker | no | emulator override in dev/CI (`http://localhost:4100/`) |
| `INKLING_AGENT_WORKOS_CLIENT_ID` (+ `_API_KEY` if required, `_ISSUER`) | agent | — | access-token verification |
| `INKLING_MCP_WORKOS_AUTHKIT_DOMAIN`, `INKLING_MCP_RESOURCE_URL` | mcp (HTTP) | no | Connect JWKS/issuer + `aud` |
| `/config.json` additions | web | no | Nothing secret. Maybe `auth.loginPath` (`/api/auth/login`); client id only if Widgets/authkit-react are used. |

### 3.4 WorkOS Dashboard configuration (per WorkOS env: staging, production, + optional dev)

Described conceptually with the doc that names each setting:

1. **Application › Redirects tab**: Redirect URIs (`http://localhost:5173/api/auth/callback`
   in staging — staging "Allows `http://` and `localhost`", prod "Requires `https://`"),
   default **Sign-out URI** (required, else logout errors), **Initiate login URI**
   (`/api/auth/login` — required for impersonation, bookmarked hosted pages, invite/password-reset
   links). Wildcards allowed except for defaults. [authkit/vanilla/python](https://workos.com/docs/authkit/vanilla/python), [sessions#sign-out-uris](https://workos.com/docs/authkit/sessions), [environments](https://workos.com/docs/authkit/environments)
2. **Application › Sessions tab**: maximum session length, access token duration (keep short),
   inactivity timeout; CORS origins (only needed for Widgets/authkit-react). [sessions#configuring-sessions](https://workos.com/docs/authkit/sessions)
3. **Authentication › Features**: auth methods (email+password, Google/Microsoft, passkeys,
   magic auth), **Multi-factor auth → Required**, **User impersonation** (off until policy exists),
   **JWT template** (add `organization_membership_id`). [authkit/mfa](https://workos.com/docs/authkit/mfa), [jwt-templates](https://workos.com/docs/authkit/jwt-templates)
4. **Authorization**: permissions, environment roles, default role, priority order, **Multiple
   roles** toggle (env-wide, off by default), **organization API key permissions** / user API
   key permissions, widget permissions on admin roles, directory group role assignment toggle.
   [rbac/configuration](https://workos.com/docs/rbac/configuration), [api-keys](https://workos.com/docs/authkit/api-keys)
5. **JIT provisioning / domain capture** defaults (enabled by default; can be disabled).
   [jit-provisioning](https://workos.com/docs/authkit/jit-provisioning)
6. **Admin Portal**: default return/success URLs; branding. [admin-portal](https://workos.com/docs/admin-portal)
7. **Webhooks** endpoint + secret (if used) — must be public HTTPS, publicly routable IP.
   [webhooks](https://workos.com/docs/events/data-syncing/webhooks)
8. **Connect › Configuration** (later): enable CIMD (off by default) and optionally DCR; add
   **Resource Indicators** = MCP URLs; optionally set default. [authkit/mcp](https://workos.com/docs/authkit/mcp)
9. **Domains** (prod only): AuthKit domain, email domain, Admin Portal domain. [custom-domains/authkit](https://workos.com/docs/custom-domains/authkit)
10. **Branding** per WorkOS env (copyable). [environments](https://workos.com/docs/authkit/environments)
11. **Billing info** is required to unlock production even if usage is free. [environments#going-live](https://workos.com/docs/authkit/environments)

Many of these are scriptable via API (redirect URIs, CORS origins: `user_management.create_redirect_uri`, `create_cors_origin`; roles/permissions: `authorization.*`) or `workos seed` — useful
to keep staging/dev reproducible.

---

## 4. Flows (endpoint + SDK method names)

Python names are from `workos` 10.6.0, Node from `@workos-inc/node` 12.1.0. REST paths from the
reference pages.

### 4.1 Sign-in

1. SPA: unauthenticated → `window.location = '/api/auth/login?return_to=<path>'`.
2. api `GET /api/auth/login`: create random `state` (store `{state, return_to}` in a short-lived
   signed cookie — stateless replicas), optionally PKCE (`get_authorization_url_with_pkce`) →
   `user_management.get_authorization_url(provider="authkit", redirect_uri, state, organization_id?, login_hint?, screen_hint?, invitation_token?)` → 302.
   REST: `GET /user_management/authorize`. [get-authorization-url](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)
3. User completes hosted AuthKit (password/social/SSO/MFA/Radar).
4. Multi-org users: hosted AuthKit handles org selection; with the raw API you'd get an
   `organization_selection_required` error and finish with `authenticate_with_organization_selection(pending_authentication_token, organization_id)`. [organization-selection](https://workos.com/docs/reference/authkit/authentication/organization-selection)

### 4.2 Callback

`GET /api/auth/callback?code=…&state=…` (or `?error=…`):
check `error` first → verify `state` → `authenticate_with_code(code, ip_address, user_agent)`
(REST `POST /user_management/authenticate`, `grant_type=authorization_code`; code valid 10 min,
single use) → seal → `Set-Cookie: inkling_session=…; HttpOnly; Secure; SameSite=Lax; Path=/` →
upsert local user/membership mirror (best effort; events reconcile) → if no `org_id`, run
"create personal org" → 302 `return_to`.

### 4.3 Per-request auth + refresh

`load_sealed_session(...).authenticate()`; on `INVALID_JWT` (expired) → `await s.refresh()` →
re-set cookie with `.sealed_session`. Rules from [session-resilience](https://workos.com/docs/authkit/session-resilience):

- Refresh tokens **rotate** every use; persist the new one (i.e., re-set the cookie) before the
  next request.
- **30-second replay grace period** returns the same rotated tokens — concurrent replicas
  refreshing the same cookie converge.
- `400 invalid_grant` = terminal → clear cookie, 401 → SPA redirects to login.
- 408/429/5xx/network = transient → keep the session, retry; never sign out. Python SDK retries
  3× internally on 429/5xx/timeouts.
- JWKS fetch failures: Go SDK distinguishes `ErrSigningKeyUnavailable` (keep cookie). In Python,
  PyJWKClient errors surface as exceptions — treat as transient (503), don't clear the cookie.

SPA: `GET /api/auth/session` → `{ user, org_id, role(s), permissions, feature_flags, impersonator, expires_at }`
(drives the account menu: User ID, Organization ID, Log out). A 401 anywhere → redirect to login.

### 4.4 Logout

`POST /api/auth/logout` (POST + CSRF to avoid prefetch logouts, as the Python quickstart does) →
`s.get_logout_url(return_to=?)` (REST `GET /user_management/sessions/logout?session_id=…&return_to=…`)
→ delete cookie → 302 to the WorkOS logout URL → WorkOS redirects to the default (or listed)
Sign-out URI. [logout](https://workos.com/docs/reference/authkit/logout/get-logout-url)

Session revocation (admin "sign out everywhere"): `user_management.list_sessions(id=user_id)` /
`revoke_session(session_id)` (REST `/user_management/sessions/revoke`). Deactivating a membership
also "revokes all active sessions". [users-organizations](https://workos.com/docs/authkit/users-organizations)
Note: revocation takes effect at the next **refresh**; an already-issued access token stays valid
until `exp` → keep access token duration short (minutes).

### 4.5 Organization switching

`POST /api/auth/switch-org {organization_id}` → `s.refresh(organization_id=…)`. If allowed, the
new token's `org_id/role/permissions` match that membership; if the org requires SSO/MFA the
refresh returns an authentication error → redirect to
`get_authorization_url(..., organization_id=…)`. [sessions#switching-organizations](https://workos.com/docs/authkit/sessions)
Org list for the switcher: `organization_membership.list_organization_memberships(user_id=…, statuses=["active"])`
(+ `organizations.get_organization` names, or the local mirror).

### 4.6 Invitations

- Send: `user_management.send_invitation(email, organization_id, role_slug, expires_in_days (1–30, default 7), inviter_user_id, locale)` — REST `POST /user_management/invitations`. WorkOS emails the link (or send yourself via [custom-emails](https://workos.com/docs/authkit/custom-emails)).
- List / get / resend / revoke: `list_invitations(organization_id=…)`, `get_invitation`, `resend_invitation`, `revoke_invitation`; `find_invitation_by_token`; `accept_invitation`.
- Accept: link lands on hosted AuthKit; if not started from app it bounces through Initiate
  login URI with invitation preserved. For signed-in users, pass `invitation_token` to
  `get_authorization_url`.
- Email rules: consumer domains must match exactly; corporate domains accept any address on the
  same domain. Invite-only signup: disable sign-up, invitations reopen it.
  [invitations](https://workos.com/docs/authkit/invitations), [invite-only-signup](https://workos.com/docs/authkit/invite-only-signup)
- Events: `invitation.created|accepted|resent|revoked`, `organization_membership.created` (pending → active).

### 4.7 Membership listing & role assignment

- List members: `organization_membership.list_organization_memberships(organization_id, statuses, limit, after)` (+ `user_management.get_user` or `list_users(organization_id=…)` for names/emails). Pagination is cursor-based; Python v10 `auto_paging_iter()`.
- Add existing user: `create_organization_membership(user_id, organization_id, role=RoleSingle(role_slug="annotator"))` (or `RoleMultiple(role_slugs=[…])` when multiple roles is on).
- Change role: `update_organization_membership(id=<om_…>, role=RoleSingle(role_slug="reviewer"))` — **needs the membership id, not the user id.**
- Remove: `deactivate_organization_membership` (soft, revokes sessions, keeps role for reactivation) vs `delete_organization_membership` (hard). Pending memberships can only be deleted.
- Role definitions: `authorization.list_environment_roles`, `create_environment_role`, `set_environment_role_permissions`; per-org: `create_organization_role(organization_id, name, slug, …)`, `list_organization_roles`, `set_organization_role_permissions`; permissions: `create_permission` etc. [reference/roles](https://workos.com/docs/reference/roles)
- Role change reaches the JWT only on the user's next refresh/login (force with a refresh).
- IdP mapping (SSO/dsync) **overrides** API-assigned roles on every sync/login. [rbac/idp-role-assignment](https://workos.com/docs/rbac/idp-role-assignment)

### 4.8 User profile update

`user_management.update_user(id, first_name, last_name, name, metadata, external_id, locale, email?, email_verified?, password?)`.
Email changes for self-managed users: `send_email_change` → `confirm_email_change` (code to new
address); enterprise-managed (SSO/dsync) users can't change email via API.
[email-changes](https://workos.com/docs/authkit/email-changes). Or the User Profile / User Security widget endpoints (§4.15).

### 4.9 MFA enrollment

Config only for hosted AuthKit: turn on **Required** (env-wide) or per-org MFA policy. TOTP only
(SMS only via standalone MFA API, US numbers). Not applied to SSO users (their IdP does MFA).
Self-service reset: User Security widget (`/_widgets/UserProfile/create-totp-factor` etc. —
elevated token required). Custom UI: `multi_factor_auth.enroll_factor` / `challenge_factor` /
`verify_challenge`, `user_management.authenticate_with_totp`. [authkit/mfa](https://workos.com/docs/authkit/mfa)

### 4.10 SSO connection setup (Admin Portal)

Org admin clicks "Configure SSO" in Inkling → api `admin_portal.generate_link(organization=<org_…>, intent="sso", return_url, success_url, external_user_id=<inkling user>, it_contact_emails=[…])` → 302 to `link` (expires **5 minutes**, generate on click, never email it from the backend).
Intents: `sso`, `dsync`, `audit_logs`, `log_streams`, `domain_verification`,
`certificate_renewal`, `bring_your_own_key`. Revoke by `external_user_id` with
`admin_portal.revoke_link`. [portal-link/generate](https://workos.com/docs/reference/admin-portal/portal-link/generate)
Events to watch: `connection.activated|deactivated|deleted`, `connection.saml_certificate_renewal_required`.
When SSO is first set up, all non-SSO methods for that org are disabled automatically.
[organization-policies](https://workos.com/docs/authkit/organization-policies)

### 4.11 Directory Sync provisioning

Admin Portal `intent="dsync"`. With **Directory Provisioning** (enabled team-wide by WorkOS
support; existing directories unaffected) WorkOS creates AuthKit users + memberships and applies
group→role mappings; without it you only get `dsync.*` directory objects that cannot sign in.
[directory-provisioning](https://workos.com/docs/authkit/directory-provisioning)
Inkling then just consumes `user.*` / `organization_membership.*` events. Inactive users are
**deleted by default** ("secure flow"); custom management flow via support.
[handle-inactive-users](https://workos.com/docs/directory-sync/handle-inactive-users)
`dsync.deleted` is a single event for the whole directory — cascade yourself.

### 4.12 Events consumption (sync)

Recommended: **Events API**, single consumer (worker), cursor in Postgres.
`events.list_events(events=[…], after=<last event id>, limit, organization_id?, range_start?, range_end?)`
(REST `GET /events`). Ordering guaranteed; returns events up to **90 days** old, ≤30 days per
query. Process per-org sequentially; separate data handlers from side effects for safe replay;
compare `updated_at` to avoid overwriting newer state.
[events-api](https://workos.com/docs/events/data-syncing/events-api), [data-reconciliation](https://workos.com/docs/events/data-syncing/data-reconciliation)
Webhooks (alternative, not both): `workos_client.webhooks.verify_event(event_body=<raw bytes>, event_signature=<WorkOS-Signature header>, secret, tolerance=180)`; Node `workos.webhooks.constructEvent(...)`; Go `workos.NewWebhookVerifier(secret).ConstructEvent(sig, raw)`. Respond 200 fast; retries
"up to 6 times, with exponential backoff over 3 days"; **no ordering guarantee**; IP allowlist
(15 IPs, see §7). [webhooks](https://workos.com/docs/events/data-syncing/webhooks)
Event types relevant to Inkling: `user.created|updated|deleted`, `organization.created|updated|deleted`,
`organization_membership.created|updated|deleted`, `invitation.*`, `session.created|revoked`,
`organization_domain.*`, `role.*`, `organization_role.*`, `permission.*`, `api_key.created|updated|revoked`,
`connection.*`, `dsync.*`, `authentication.*` (sign-in success/failure — feed into Inkling audit).
[events](https://workos.com/docs/events)

### 4.13 Audit Logs (later)

- Define event schemas first (dashboard or `audit_logs.create_schema`). Action naming is
  `group.object.action`-style (e.g. `annotation.document.saved`, `dataset.version.merged`).
- Emit: `audit_logs.create_event(organization_id, event={action, occurred_at, actor{type,id,name?,metadata}, targets[{type,id,metadata}], context{location, user_agent}, metadata, version?}, idempotency_key=…)`. REST `POST /audit_logs/events`. **Idempotency-Key is honoured only on this endpoint** (SDK README). Rate limit 6,000/60 s/API key.
- Export: `create_export(organization_id, range_start, range_end, actions, actors, targets…)` → poll `get_export(id)` until `state="ready"` → `url` valid **10 min**. Export window: events from the past **3 months**.
- Retention: **30 days by default**, per org; settable 1–11 months or 1–10 years; can increase,
  cannot decrease (`update_organization_audit_logs_retention`). Pricing: $99/mo per 1M events retained.
- Log Streams to SIEM/S3/GCS/Snowflake/HTTP: $125/mo per SIEM connection; via Admin Portal `intent="log_streams"`.
- **Platform Audit Logs** (session created/revoked, membership created/updated/deleted) can be auto-added (off by default).
- Admin Portal `intent="audit_logs"` gives customers a viewer/export UI.
- Metadata limits in the local skill (50 keys, 40-char keys, 500-char values) — **UNVERIFIED** against today's docs; check [metadata-schema](https://workos.com/docs/audit-logs/metadata-schema).
- **PHI rule**: targets/metadata must carry ids and non-clinical labels only.
[audit-logs](https://workos.com/docs/audit-logs), [exporting-events](https://workos.com/docs/audit-logs/exporting-events), [log-streams](https://workos.com/docs/audit-logs/log-streams), [platform-audit-logs](https://workos.com/docs/audit-logs/platform-audit-logs), [retention](https://workos.com/docs/reference/audit-logs/retention)

### 4.14 API keys & M2M

- **API keys (now)** — for "Service accounts / API keys" page and stdio MCP:
  - Org-owned: `api_keys.create_organization_api_key(organization_id, name, permissions, expires_at)`, `list_organization_api_keys`, `delete_api_key`, `create_api_key_expire`.
  - User-owned: `user_management.create_user_api_key(user_id, name, organization_id, permissions, expires_at)`, `list_user_api_keys`. Revoked automatically if the membership is deleted.
  - Validate: `api_keys.create_validation(value)` → `api_key` with `owner {type: organization|user, id, organization_id}`, `permissions`.
  - Full value returned **once** at create. Available permissions are an env-level allow-list (org vs user key permissions configured separately). Widget scopes: `widgets:api-keys:manage`, `widgets:user-api-keys:manage-self|manage-all`.
  - [api-keys](https://workos.com/docs/authkit/api-keys), [reference/api-keys](https://workos.com/docs/reference/authkit/api-keys)
- **M2M applications (later)** — "M2M applications can only be configured as third-party", each tied to one customer org; `client_credentials` at `https://<authkit_domain>/oauth2/token`; JWT `sub` = app client id, `org_id` = customer org, `scope`; no JWT template, no permissions claim; verify with `https://<authkit_domain>/oauth2/jwks` (`aud` = environment client id, not configurable). Introspection API for revocation checks. Manage via `connect.create_application`, `create_application_client_secret`. [connect/m2m](https://workos.com/docs/authkit/connect/m2m), [connect/token-claims](https://workos.com/docs/authkit/connect/token-claims)
- **Internal service auth is not a WorkOS concern**: keep api→versioning Ed25519 JWTs and api-minted session tokens for agent/worker. M2M is for *customers'* machines.

### 4.15 Settings pages via Widgets (or headless)

Two documented token sources: (1) the AuthKit access token (`getAccessToken` with authkit-react/js), (2) a backend widget token:
`widgets.create_token(organization_id, user_id, scopes=[…])` (Node `widgets.createToken`), valid **1 hour**.
Scopes: User Management `widgets:users-table:manage`; API Keys `widgets:api-keys:manage`; Admin
Portal SSO `widgets:sso:manage`; Domain Verification `widgets:domain-verification:manage`; User
Profile / Security / Sessions: none. The acting user's role must hold these permissions.
Sensitive profile ops need an elevated token from `POST /_widgets/UserProfile/verify` (10 min, header `x-elevated-access-token`).
Endpoints (from the bundled widgets OpenAPI in the skill): `/_widgets/UserManagement/members|roles|invite-user|invites/{id}/resend`, `/_widgets/UserProfile/me|sessions|create-totp-factor|passkeys…`, `/_widgets/ApiKeys/organization-api-keys|permissions`, `/_widgets/admin-portal/sso-connections|organization-domains|generate-link`.
Recommendation: **headless** — api issues widget tokens (`GET /api/auth/widget-token?scope=…`),
SPA calls the `/_widgets/*` endpoints with react-query and renders with shadcn. Avoids Radix
Themes + second CSS bundle. Requires the app origin in the Sessions-tab CORS list. The widget
endpoints are a less-documented surface (GraphQL "Widgets API" also exists:
[widgets-api](https://workos.com/docs/widgets-api)) — **UNVERIFIED** stability guarantees; the
alternative is plain backend calls through api (more code, fully stable API).
[widgets/quick-start](https://workos.com/docs/widgets/quick-start), [widgets/user-management](https://workos.com/docs/widgets/user-management), [widgets/api-keys](https://workos.com/docs/widgets/api-keys), [widgets/organization-switcher](https://workos.com/docs/widgets/organization-switcher)

### 4.16 Domain verification / JIT

- Self-serve: Admin Portal `intent="domain_verification"` (DNS TXT). Manual: dashboard or `organization_domains.create_organization_domain(domain, organization_id)` + `verify_organization_domain`; consumer domains (gmail.com) disallowed.
- Effects: SSO users on verified domain skip email verification; **domain policy** governs all users with that email domain (only one org per WorkOS env can claim a domain in its policy); auto-membership by domain + SSO JIT on by default.
- Guests (unverified domains) must be invited before SSO JIT works.
[domain-verification](https://workos.com/docs/authkit/domain-verification), [jit-provisioning](https://workos.com/docs/authkit/jit-provisioning), [organization-policies](https://workos.com/docs/authkit/organization-policies)

### 4.17 MCP (later, HTTP transport)

1. Enable CIMD (+DCR for older clients) in Connect configuration; add Resource Indicator =
   `https://mcp.<host>/mcp` (wildcards allowed; set a default for clients that omit `resource`).
2. `GET /.well-known/oauth-protected-resource` → `{ resource, authorization_servers: ["https://<authkit_domain>"], bearer_methods_supported: ["header"] }`; optionally proxy `/.well-known/oauth-authorization-server`.
3. Verify Bearer with `jose` (issuer = AuthKit domain, audience = resource URL); 401 with `WWW-Authenticate … resource_metadata=…`.
4. Authorize: token has `sub`, `org_id`, `scope` but **no permissions** → `list_organization_memberships(user_id=sub, organization_id=org_id)` → role slugs → `authorization.get_organization_role(org_id, slug).permissions` (cache ~60 s), or add `roles` via JWT template.
5. Then mint an Inkling session token (`on_behalf_of=user:<sub>`) for kernel calls, as the agent does today.
Standalone Connect exists if AuthKit isn't the login. [authkit/mcp](https://workos.com/docs/authkit/mcp), [connect/token-claims](https://workos.com/docs/authkit/connect/token-claims)

---

## 5. Access-token claims and Inkling permission mapping

Documented AuthKit session access token ([session-tokens/access-token](https://workos.com/docs/reference/authkit/session-tokens/access-token), [sessions](https://workos.com/docs/authkit/sessions), [reauthentication](https://workos.com/docs/authkit/reauthentication)):

| Claim | Meaning | Inkling use |
|---|---|---|
| `iss` | Issuer. Sessions doc: `https://api.workos.com/` (or custom auth domain). Node README example: `https://api.workos.com/user_management/<client_id>`. **UNVERIFIED which** — decode a staging token before setting `issuer`/`jwt_issuer`. | Enforce once known. |
| `sub` | WorkOS user id | `principal = "user:" + sub` |
| `client_id` | app client id | sanity check |
| `sid` | session id | logout, session list/revoke |
| `jti` | token id | log correlation |
| `org_id` | org selected at sign-in/refresh | `RequestContext.org_id`; must match the org owning the project/workspace being accessed |
| `role` | single role slug of the membership | display only |
| `roles` | all role slugs (multiple-roles mode) | display only |
| `permissions` | permission slugs of the role(s) | **authorization input** |
| `entitlements` | Stripe entitlements (if add-on) | plan gating |
| `feature_flags` | enabled flag slugs (org/user targeting only) | UI gating |
| `act.sub` | impersonator email (only when impersonating) | show staff bar; block PHI export; audit |
| `auth_time` | last active authentication | step-up for sensitive actions (`max_age`) |
| `exp`, `iat` | standard (example token shows a 300 s lifetime; actual default **UNVERIFIED**, configurable) | — |
| custom (JWT template) | e.g. `organization_membership_id` | FGA checks, membership ops without lookup |

JWKS: `https://api.workos.com/sso/jwks/<client_id>` (RS256; SDK helpers `get_jwks_url()` /
`getJwksUrl(clientId)`). With a custom AuthKit domain, `iss` changes to it.

Mapping rules:

1. **Check permissions, never role slugs** — custom org roles make slugs unpredictable (custom
   role slugs must start with `org-` if supplied, else auto `name-xxxxxx`).
   [custom-roles](https://workos.com/docs/rbac/custom-roles). **SKILL DRIFT**: skill says org
   role slugs are prefixed `org:`; live docs say `org-`.
2. Proposed permission slugs (delimiters allowed `-.:_*`; keep short — JWT/cookie size):
   `org:manage`, `org:billing`, `members:read`, `members:manage`, `apikeys:manage`,
   `project:create`, `project:read`, `project:write`, `project:delete`, `dataset:read`,
   `dataset:write`, `dataset:export`, `annotation:write`, `review:approve`, `version:merge`,
   `plugin:install`, `agent:run`, plus WorkOS widget permissions on admin roles
   (`widgets:users-table:manage`, `widgets:api-keys:manage`, `widgets:sso:manage`,
   `widgets:domain-verification:manage`).
3. Environment roles mirroring today's `owner | editor | viewer` (+ `annotator`, `reviewer`,
   `billing-admin` as needed); default role = least privilege (`viewer`), owner assigned by api
   when it creates an org.
4. `RequestContext.allows(scope)` today means "session token scopes". Add a separate
   `ctx.can(permission)` sourced from JWT `permissions` (user) / API-key `permissions` / Inkling
   session scopes (agent), and make the command gateway check both: *the user may* AND *the
   agent token is scoped for it*.
5. Org boundary: every kernel query already keys on `workspace_id` (= project id); add the check
   `project.org_id == ctx.org_id` at context resolution so a token for org A can't touch org B's
   project id.
6. Freshness: permissions in the JWT are stale until refresh → short access-token duration; after
   role edits in Inkling, force a refresh for the acting user; for other users accept ≤ token TTL
   lag, or check FGA/API for high-risk actions.
7. FGA later: resource types `project` (parent org) → `dataset`; resource-scoped roles
   `project-viewer|editor|admin`; `authorization.check(organization_membership_id, permission_slug, resource_target=…)`
   using `resourceExternalId` = Inkling id. Limits: depth 5, ≤10 child types, ≤50 types/env,
   **soft limit 5,000 resources per type per org** — so annotations/items/tasks stay local (inherit from project/dataset).
   Org-wide permissions still come from the JWT; FGA roles are *not* in the JWT.
   [fga/authkit-integration](https://workos.com/docs/fga/authkit-integration), [fga/access-checks](https://workos.com/docs/fga/access-checks), [fga/high-cardinality-entities](https://workos.com/docs/fga/high-cardinality-entities), [fga/resources](https://workos.com/docs/fga/resources)

---

## 6. Data model guidance

Mirror locally (Postgres, owned by api, written only by the event consumer + callback upserts):

| Table | Key | Fields | Why local |
|---|---|---|---|
| `users` (new) | `workos_user_id` | email (normalized lowercase/trimmed like WorkOS), first/last name, profile picture url, `email_verified`, `last_sign_in_at`, `updated_at` (WorkOS), `deleted_at` | Display names on annotations, reviews, versions without per-row API calls. |
| `organizations` (existing) | Inkling id; add `workos_org_id` unique | name, kind, `updated_at` | Already referenced by projects. Set WorkOS `external_id` = Inkling id. |
| `organization_members` (existing) | (org_id, principal) | add `workos_membership_id`, `status` (pending/active/inactive), `role_slugs[]`, `updated_at` | Member list, "who can review". Role here is a cache — authority is WorkOS. |
| `workos_event_cursor` | consumer name | `last_event_id`, `updated_at` | Events API resume. |
| `workos_events_processed` | `event_id` | processed_at | Idempotency (dedupe by `event.id`, not delivery). |

Always fetch from WorkOS (don't mirror): sessions, invitations (or mirror lightly for the Invites
tab), API keys (list via API/widget), roles/permissions definitions, SSO connections, directories,
audit logs.

Sync rules:

- Upsert, never insert (`ON CONFLICT DO UPDATE ... WHERE excluded.updated_at > t.updated_at`).
- Events can arrive for objects you haven't seen (membership before user): create a stub.
- `user.deleted` → tombstone + anonymize display name, keep `principal` string on historical
  annotations/commits (provenance must survive).
- Reconcile nightly via state APIs (`list_users`, `list_organization_memberships`) to catch
  drift; Events API keeps 90 days.
- `organization_membership.deleted`/deactivated → also revoke Inkling session tokens (agent runs)
  that are `on_behalf_of` that user in that org.

---

## 7. Security & compliance

- **HIPAA / BAA**: "Can WorkOS sign a HIPAA BAA? Yes, WorkOS can sign business associate
  agreements for customers under **enterprise plans**." ([workos.com/security](https://workos.com/security)).
  So Pay-as-you-go alone gives no BAA. Action: talk to WorkOS sales before any PHI-adjacent
  deployment; even with a BAA, design so WorkOS never receives PHI.
- **Certifications**: SOC 2 Type 2, GDPR & CCPA compliant, annual pentests (security page);
  documents in [trust center](https://trust.workos.com).
- **Data residency**: US only. DPA §6 authorizes transfers from EEA/CH/UK to the US under SCCs;
  no EU hosting region found ([data-processing-addendum](https://workos.com/legal/data-processing-addendum);
  third-party summaries agree). Per-customer isolated environments exist (on-prem guidance:
  "separate environment … for each on-prem customer", [on-prem-deployment](https://workos.com/docs/on-prem-deployment))
  but they are still WorkOS-hosted. A "dedicated on-prem WorkOS" mentioned in a WorkOS blog is
  **UNVERIFIED** as a product offering.
- **What WorkOS stores**: user name/email/profile picture, IPs and user agents (sessions, Radar,
  audit context), org names/domains, metadata (10 keys, 600 chars, ASCII; "Never store sensitive
  information in metadata"), audit-log events you send, feature-flag targets.
- **Never send PHI** in: org/user metadata, JWT templates, audit log targets/metadata,
  `external_id`, invitation emails' custom content, feature-flag custom targets, Radar fields.
- **Cookie**: name e.g. `inkling_session`; `HttpOnly; Secure; SameSite=Lax; Path=/`; no
  `Domain` (host-only) unless sub-domains need it; max-age ≈ WorkOS max session length. Watch the
  4 KB cookie limit (access token + refresh token + user JSON + permissions) — keep permission
  slugs short, keep JWT template tiny (≤3072 bytes rendered), don't put feature flags in the
  token if there are many. [feature-flags/access-token-claim](https://workos.com/docs/feature-flags/access-token-claim)
- **CSRF**: SameSite=Lax blocks cross-site POSTs; still require a CSRF token or a custom header
  (`X-Requested-With`/`X-Inkling-CSRF`) on state-changing `/api/*` requests, and make logout POST.
  OAuth `state` must be verified on callback.
- **CSP**: pattern A needs no third-party `connect-src` (all calls same-origin) — only a
  top-level redirect to the AuthKit domain. Widgets/authkit-react need `connect-src https://api.workos.com https://<authkit_domain>`.
  Hosted AuthKit uses Cloudflare Turnstile (on the AuthKit domain, not Inkling).
- **Session lifetime**: set max session length (e.g. 12 h for clinical workstations), inactivity
  timeout (e.g. 30–60 min), access token duration (e.g. 5 min). Revocation applies at the next
  refresh. [sessions#configuring-sessions](https://workos.com/docs/authkit/sessions)
- **MFA**: require it env-wide (or per org policy); SSO users rely on their IdP.
- **Impersonation**: off by default; when enabled, every impersonated request carries `act`;
  block dataset export/PHI download while `act` is present, show a banner, audit. 60-min cap.
- **Webhooks** (if used): verify signature on raw body, tolerance 180 s, allowlist WorkOS IPs:
  `3.217.146.166, 23.21.184.92, 34.204.154.149, 35.82.80.13, 44.213.245.178, 44.215.236.82,
  44.253.112.118, 50.16.203.9, 52.1.251.34, 52.21.49.187, 54.68.143.104, 100.22.25.25,
  100.22.157.11, 100.22.247.20, 174.129.36.47` ([webhooks](https://workos.com/docs/events/data-syncing/webhooks)).
  The Events API avoids exposing any inbound endpoint — better for a hospital/on-prem stage.
- **Egress**: services call `api.workos.com` (Cloudflare IP ranges); add to k8s egress
  NetworkPolicy. Browser redirects to `*.authkit.app` (staging) or the custom AuthKit domain.
- **GDPR / deletion**: `user_management.delete_user(id)` — "Permanently deletes a user in the
  current environment. It cannot be undone." Org deletion `organizations.delete_organization`
  (rate-limited 50/min). Security page: "Reach out to support@workos.com to request deletion of
  data" (for anything beyond API deletion, e.g. logs/backups). Audit Log events follow per-org
  retention. Inkling must delete/anonymize its mirror and keep provenance ids.
- **Secrets**: API key is environment-wide and powerful (can mint widget tokens, delete users) —
  only api/worker get it; agent ideally only needs the client id.

---

## 8. Local dev, testing, stages, rollout

### 8.1 WorkOS environments ↔ Inkling stages

Every project has staging + production; more environments can be created from the environment
selector ([on-prem-deployment](https://workos.com/docs/on-prem-deployment)). Users, orgs, keys,
webhooks, branding do **not** carry over; feature flag *definitions* are project-wide.
[environments](https://workos.com/docs/authkit/environments), [projects](https://workos.com/docs/authkit/projects)

| Inkling stage | WorkOS env | Notes |
|---|---|---|
| local (`pnpm dev`) | **WorkOS Emulate** by default; shared "dev" staging env opt-in | Redirect URI `http://localhost:5173/api/auth/callback` (Vite proxies `/api` to api, so the callback is same-origin). |
| dev (k8s) | staging-type env "dev" (or reuse staging) | Staging is free; whether additional non-production envs are free is **UNVERIFIED** (pricing: "Staging environments: Free"). |
| staging | WorkOS **staging** | Test IdP, `[STAGING]` email subjects. |
| prod | WorkOS **production** | https-only redirects, keys shown once, billing info required, custom domains possible. |

Applications: one app per WorkOS env is enough; add a separate "Application" for a future desktop
or CLI client sharing the user base. [applications](https://workos.com/docs/authkit/applications)

### 8.2 Local dev without WorkOS

- Keep `dev_trust_headers` path (X-Dev-Principal) for existing e2e tests (`data-testid`
  contracts) — they must keep working.
- Add `INKLING_API_AUTH_MODE = dev-headers | workos`.
- **Emulator**: `npx @workos/emulate` or `brew install workos/tap/workos-emulate`; `workos-emulate --seed workos-emulate.config.yaml [--interactive] [--signing-key …] [--issuer …]`; listens on `:4100`, key `sk_test_default`, `/health` probe; seed users/orgs/memberships/roles/permissions (pin ids). `--interactive` serves login pages for browser e2e. Check [SUPPORTED.md](https://github.com/workos/emulate/blob/main/SUPPORTED.md) before relying on an endpoint. Point Python SDK at it via `base_url`/`WORKOS_BASE_URL`, Node via `{ apiHostname: 'localhost', port: 4100, https: false }`.
- e2e against real staging: don't drive hosted AuthKit (Radar challenges, rate limits); create a
  user per worker with `create_user(email, password, email_verified=True)`, authenticate with
  password, seal, inject cookie. Use `@example.com` emails (never mailed).
  [authkit/testing](https://workos.com/docs/authkit/testing)
- What to test (from the testing guide): callback `error`/state tampering; refresh rotation;
  logout revokes WorkOS session; protected routes; permission gates incl. multi-org
  `organization_selection_required`; webhook signature/idempotency/out-of-order; 5xx/timeout
  during refresh doesn't log out.
- SSO: staging **Test Identity Provider** + default Test Organization (SP-initiated, IdP-initiated
  — "Ensure AuthKit is disabled" for that test —, guest domain, error). [sso/test-sso](https://workos.com/docs/sso/test-sso)
- Seeding staging: `workos seed --file=workos-seed.yml` / `--clean` (CLI; verify flags with `workos --help --json`).

### 8.3 Rollout sketch

1. Staging WorkOS env configured (roles/permissions as code via seed file or script).
2. api: auth routes + sealed cookie + `resolve_context` WorkOS branch behind `AUTH_MODE`.
3. Mirror tables + Events API consumer in worker.
4. nginx `auth_request` for `/api/agent/*`; agent verifies JWT; keep service token for internal.
5. Web: login redirect, `/api/auth/session` in boot, account menu, org switcher, members/invites/roles/API-keys pages (headless widgets or api proxies).
6. Migrate existing `organization_members` principals (`user:local-expert`…) — seed users are dev-only; real data migration is per-org (create WorkOS org with `external_id`, invite members).
7. Production env: billing info, prod keys in k8s Secrets, https redirect URIs, custom AuthKit domain (optional), BAA decision.
8. Later: SSO/dsync per customer via Admin Portal, Audit Logs, FGA, MCP OAuth.

---

## 9. Pricing & limits

From [workos.com/pricing](https://workos.com/pricing) (fetched as `pricing.md` today):

| Item | Price |
|---|---|
| AuthKit | **Free up to 1M MAU**; $2,500/mo per additional 1M. MAU = user who signs up, signs in or updates profile in a calendar month. Includes email+password, social, passkeys, MFA, magic auth, "enterprise SSO" (UI) |
| SSO | $125/connection/mo (1–15), $100 (16–30), $80 (31–50), $65 (51–100), custom 101+ |
| Directory Sync | same tiers as SSO |
| Audit Logs | Log streaming $125/mo per SIEM connection; retention $99/mo per 1M events |
| Radar | first 1,000 checks free; $100/mo per 50K |
| Custom domain | $99/mo |
| Support | Standard free; Scale $1,000/mo; Enterprise custom (BAA lives here per security page) |
| Staging | free; only production billed. OAuth connections free. |
| Not listed on pricing page | FGA, Feature Flags, API Keys, Connect/M2M/MCP, Vault, Pipes, Widgets, Events, Admin Portal → **UNVERIFIED** (assume included or ask sales) |

Rate limits ([rate-limits](https://workos.com/docs/reference/rate-limits)): 6,000 req/60 s per
API key overall; AuthKit `/user_management/*` reads 1,000/10 s, writes 500/10 s **per WorkOS
env**; `/user_management/authenticate` 10/60 s per email or challenge; magic auth / verification /
password reset sends 3/60 s; hosted AuthKit SSO sign-ins 3/60 s per IP, email sign-ins 10/60 s per
email+IP; Delete Organization 50/60 s; Audit Logs create 6,000/60 s; Directory users 4 rps per
directory. Implication: never call `api_keys.create_validation` or `list_organization_memberships`
per request without a cache; never refresh more than needed.

Other numeric limits: org/user metadata 10 pairs × (40-char key, 600-char value, ASCII);
`external_id` ≤64 chars unique per env; JWT template ≤3072 bytes; FGA 5 levels / 10 child types /
50 types / ~5,000 resources per type per org (soft); invitations 1–30 days (default 7); auth code
10 min; portal link 5 min; widget token 1 h; elevated widget token 10 min; impersonation 60 min;
audit export URL 10 min, export window 3 months, default retention 30 days; Events API 90 days of
history, 30 days per query; webhooks retried 6× over 3 days; refresh replay grace 30 s.

---

## 10. Gotchas

1. **Sealed cookies are per-language formats** (Python = Fernet, Node = iron `Fe26.2*`, Go own). One service must own the cookie; others get JWTs.
2. **Python cookie password must be a Fernet key**, not "any 32+ chars" as Node/Go docs say.
3. **Python SDK 10.x API differs from the AuthKit Python quickstart** (no `session={"seal_session":…}` arg on `authenticate_with_code`; use `workos.session.seal_session_from_auth_response`). README already mentions v11 — pin `<11`.
4. **Skill drift**: Go SDK is `workos-go/v10` (skill: v4); memberships are under `organization_membership` in Python (skill: `user_management`); widget token method is `create_token` / `createToken` (skill: `getToken`); Node webhook verify is `webhooks.constructEvent` (skill: `verifyEvent`); custom org role slugs use `org-` prefix (skill: `org:`).
5. **`authkit-react-router` is framework-mode only**; Inkling's SPA can't use it.
6. **`authkit-react` without a custom AuthKit domain stores the refresh token in localStorage** (`devMode`); auto-on for localhost.
7. **Redirect URI must match exactly** (incl. trailing slash); default redirect/sign-out URIs can't be wildcards; prod requires https.
8. **Configure the Initiate login URI** or impersonation, bookmarked hosted pages, invitation and password-reset links break PKCE/state flows.
9. **No default Sign-out URI = logout error page.**
10. **Refresh tokens rotate** — always write back the new cookie; concurrent refresh is safe only within 30 s grace.
11. **Never sign users out on transient refresh errors** (408/429/5xx/JWKS fetch).
12. **Revocation/role changes are not instant**: they bite at the next refresh; keep access tokens short.
13. **Membership id ≠ user id** for role updates and FGA checks; put `organization_membership_id` in the JWT template.
14. **IdP role mapping overrides API role assignment** silently on next sync/login.
15. **First custom role on an org forks that org's default role & priority order** from the environment (custom-roles doc).
16. **Multiple roles is env-wide**; switching modes reassigns by priority order.
17. **Check permissions, not role slugs.**
18. **Connect/MCP tokens have no `permissions` claim** and M2M tokens can't use JWT templates.
19. **JWT template applies to every token in the env** (sessions + Connect); permissions can't be referenced in it.
20. **Cookie size**: access + refresh token + user + permissions + flags must fit ~4 KB.
21. **`iss` value is inconsistent across docs** — decode a real token before enforcing.
22. **Events API vs webhooks: pick one.** Webhooks: unordered, at-least-once, raw-body signature, public HTTPS, IP allowlist, 6 retries/3 days. Events API: ordered, 90-day history.
23. **`dsync.deleted` is one event for the whole directory**; inactive directory users are deleted by default.
24. **Directory Sync alone does not create AuthKit users** — Directory Provisioning must be enabled by WorkOS support (team-wide; existing directories unaffected).
25. **Admin Portal links expire in 5 min**; generate on click; don't email from backend; revoke by `external_user_id`.
26. **SSO setup auto-disables other auth methods for that org.**
27. **Domain policy**: only one org per WorkOS env can include a domain; consumer domains not allowed.
28. **MFA requirement doesn't apply to SSO users**; hosted MFA is TOTP only.
29. **Impersonation grants the user's full access** — PHI exposure; gate on `act`.
30. **Idempotency-Key is only honoured by Create Audit Log Event**; other POSTs can duplicate on retry (SDKs auto-retry POSTs).
31. **Audit Logs default retention is 30 days and can't be decreased** once raised; export window is 3 months.
32. **Rate limits are per API key / per WorkOS env**; cache API-key validations and membership/role lookups.
33. **Staging test IdP doesn't exist in production**; use real connections there.
34. **Production API keys are shown once.**
35. **Feature flags in the token reflect org/user targeting only**; custom targets need the Node runtime client.
36. **FGA soft limit ~5,000 resources per type per org**; don't model annotations/items.
37. **Widgets bring Radix Themes + TanStack Query peers** and need CORS; Inkling is shadcn — prefer headless or backend proxies.
38. **SDK auto-reads unprefixed `WORKOS_*` env vars** — don't set them in k8s (conflicts with `INKLING_<ROLE>_<KEY>` naming check and makes config implicit).
39. **US-only data hosting; BAA only on enterprise plans** — a procurement gate, not an engineering one; start that conversation in parallel.
40. **Terminology collision**: WorkOS "environment" vs Inkling "environment"; WorkOS "organization as workspace" vs Inkling kernel "Workspace". Name code `workos_env`, `workos_org_id`.

---

## Appendix A — docs consulted (all fetched 2026-10-30)

Core: [llms.txt](https://workos.com/docs/llms.txt) · [pricing](https://workos.com/pricing) · [sessions](https://workos.com/docs/authkit/sessions) · [session-resilience](https://workos.com/docs/authkit/session-resilience) · [authkit/react](https://workos.com/docs/authkit/react) · [sdks/authkit-react](https://workos.com/docs/sdks/authkit-react) · [authkit/vanilla/python](https://workos.com/docs/authkit/vanilla/python) · [authkit/vanilla/nodejs](https://workos.com/docs/authkit/vanilla/nodejs) · [session-tokens/access-token](https://workos.com/docs/reference/authkit/session-tokens/access-token) · [session-tokens/jwks](https://workos.com/docs/reference/authkit/session-tokens/jwks) · [authentication (code/refresh/org selection)](https://workos.com/docs/reference/authkit/authentication/code) · [logout](https://workos.com/docs/reference/authkit/logout/get-logout-url) · [users-organizations](https://workos.com/docs/authkit/users-organizations) · [invitations](https://workos.com/docs/authkit/invitations) · [domain-verification](https://workos.com/docs/authkit/domain-verification) · [jit-provisioning](https://workos.com/docs/authkit/jit-provisioning) · [organization-policies](https://workos.com/docs/authkit/organization-policies) · [roles-and-permissions](https://workos.com/docs/authkit/roles-and-permissions) · [rbac/configuration](https://workos.com/docs/rbac/configuration) · [rbac/custom-roles](https://workos.com/docs/rbac/custom-roles) · [jwt-templates](https://workos.com/docs/authkit/jwt-templates) · [impersonation](https://workos.com/docs/authkit/impersonation) · [reauthentication](https://workos.com/docs/authkit/reauthentication) · [authkit/mfa](https://workos.com/docs/authkit/mfa) · [metadata](https://workos.com/docs/authkit/metadata) · [email-changes](https://workos.com/docs/authkit/email-changes) · [environments](https://workos.com/docs/authkit/environments) · [projects](https://workos.com/docs/authkit/projects) · [applications](https://workos.com/docs/authkit/applications) · [testing](https://workos.com/docs/authkit/testing) · [groups](https://workos.com/docs/authkit/groups) · [directory-provisioning](https://workos.com/docs/authkit/directory-provisioning) · [actions](https://workos.com/docs/authkit/actions) · [hosted-ui](https://workos.com/docs/authkit/hosted-ui) · [radar](https://workos.com/docs/authkit/radar).

M2M/MCP: [api-keys](https://workos.com/docs/authkit/api-keys) · [connect](https://workos.com/docs/authkit/connect) · [connect/m2m](https://workos.com/docs/authkit/connect/m2m) · [connect/token-claims](https://workos.com/docs/authkit/connect/token-claims) · [authkit/mcp](https://workos.com/docs/authkit/mcp) · [cli-auth](https://workos.com/docs/authkit/cli-auth) · [api-gateway](https://workos.com/docs/authkit/api-gateway).

Other: [events](https://workos.com/docs/events) · [data-syncing](https://workos.com/docs/events/data-syncing) · [webhooks](https://workos.com/docs/events/data-syncing/webhooks) · [events-api](https://workos.com/docs/events/data-syncing/events-api) · [data-reconciliation](https://workos.com/docs/events/data-syncing/data-reconciliation) · [audit-logs](https://workos.com/docs/audit-logs) · [exporting-events](https://workos.com/docs/audit-logs/exporting-events) · [log-streams](https://workos.com/docs/audit-logs/log-streams) · [platform-audit-logs](https://workos.com/docs/audit-logs/platform-audit-logs) · [audit retention](https://workos.com/docs/reference/audit-logs/retention) · [admin-portal](https://workos.com/docs/admin-portal) · [portal-link/generate](https://workos.com/docs/reference/admin-portal/portal-link/generate) · [fga](https://workos.com/docs/fga) · [fga/authkit-integration](https://workos.com/docs/fga/authkit-integration) · [fga/access-checks](https://workos.com/docs/fga/access-checks) · [fga/high-cardinality-entities](https://workos.com/docs/fga/high-cardinality-entities) · [fga/resources](https://workos.com/docs/fga/resources) · [fga/resource-types](https://workos.com/docs/fga/resource-types) · [feature-flags](https://workos.com/docs/feature-flags) · [feature-flags/access-token-claim](https://workos.com/docs/feature-flags/access-token-claim) · [feature-flags/custom-targets](https://workos.com/docs/feature-flags/custom-targets) · [add-ons/stripe](https://workos.com/docs/authkit/add-ons/stripe) · [widgets/quick-start](https://workos.com/docs/widgets/quick-start) · [widgets/user-management](https://workos.com/docs/widgets/user-management) · [widgets/api-keys](https://workos.com/docs/widgets/api-keys) · [widgets/organization-switcher](https://workos.com/docs/widgets/organization-switcher) · [widgets/user-security](https://workos.com/docs/widgets/user-security) · [widgets/user-sessions](https://workos.com/docs/widgets/user-sessions) · [sso/test-sso](https://workos.com/docs/sso/test-sso) · [directory-sync/handle-inactive-users](https://workos.com/docs/directory-sync/handle-inactive-users) · [rate-limits](https://workos.com/docs/reference/rate-limits) · [custom-domains/authkit](https://workos.com/docs/custom-domains/authkit) · [vault](https://workos.com/docs/vault) · [on-prem-deployment](https://workos.com/docs/on-prem-deployment) · [security](https://workos.com/security) · [DPA](https://workos.com/legal/data-processing-addendum) · [changelog](https://workos.com/changelog).

SDK sources inspected: `workos==10.6.0` wheel (PyPI), `@workos-inc/node@12.1.0` tarball (npm),
`github.com/workos/workos-go/v10` README (v10.6.0 on proxy.golang.org), READMEs of
`authkit-react`, `authkit-react-router`, `authkit-js`, `workos-python`, `workos-node`.
Raw page copies are in `/tmp/gravity/docs/pages/` for the plan author to grep.

## Appendix B — Open questions for WorkOS (before the plan is final)

1. BAA: price/plan threshold; does it cover Audit Logs and Events data?
2. Any EU or dedicated-region hosting on enterprise plans?
3. Exact `iss` claim for session access tokens (with and without custom domain).
4. Default access-token duration and allowed min/max for session settings.
5. Can `verifyAccessToken` run with a client-id-only Node client (no API key on the agent)?
6. Prefix/format of user- and org-owned API key values (to route Bearer parsing).
7. Pricing/availability of FGA, API Keys, Connect/M2M, MCP auth, Feature Flags.
8. Stability guarantees of the `/_widgets/*` REST endpoints for headless use.
9. Whether extra non-production WorkOS envs (a "dev" env) are free.
