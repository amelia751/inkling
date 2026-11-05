# infra/workos

WorkOS configuration as files (todo/todo9.md, Phase 0 and Phase 13). Sign-in in dev, staging and
production: [the README](../../README.md#spin-up-instructions).

| File | What | Applied with |
|---|---|---|
| `seed.yml` | Permissions and environment roles (`admin`, `member`, `billing`) of D5 | `npx workos@0.24.0 seed --file=infra/workos/seed.yml --api-key=…` on WorkOS staging, then production |
| `emulate.yaml` | The same roles and permissions, plus test users, two organizations and memberships with pinned ids | `workos-emulate --seed infra/workos/emulate.yaml` (compose service `workos-emulate`, profile `deps`) |

Keep the `roles` and `permissions` of both files identical. Code checks permissions, never role
slugs.

## Applying `seed.yml`

```sh
npx workos@0.24.0 seed --help                       # flags of the pinned CLI
read -rs KEY                                        # the environment's sk_test_… / sk_live_… key
npx workos@0.24.0 seed --file=infra/workos/seed.yml --api-key="$KEY" --mode ci
```

Idempotent: existing permissions and roles are skipped, and each role's permission list is set
again. `admin` and `member` already exist in every WorkOS environment; the seed sets their
permissions. `seed --clean` removes only what the last run on this machine created (it keeps a
state file); prefer editing in the dashboard over cleaning a shared environment.

The seed CLI can't set these; do them on the dashboard after seeding (Authorization tab, and
Applications → Redirects):

- default role **`member`**; multiple roles **off**;
- organization API key permissions: `datasets:read`, `annotations:write`, `studio:tools`, `admin`;
- redirect URIs, sign-out URI and initiate login URI as listed in todo9 Phase 0 (exact match);
- the JWT template `{"organization_membership_id": "{{ organization_membership.id }}"}`;
- Sessions: access token 5 min, inactivity 60 min, maximum 12 h (D10).

## Emulate

| User | Password | Acme Imaging (`org_01JTODO9ACME000000000000AC`) | Globex Radiology (`org_01JTODO9GLOBEX0000000000GL`) |
|---|---|---|---|
| `admin@example.com` | `test-password-admin` | admin | member |
| `member@example.com` | `test-password-member` | member | |
| `billing@example.com` | `test-password-billing` | billing | |

The emulator listens on `:4100` with the environment key `sk_test_default` and accepts any client
id (`client_emulated`). Tokens carry `permissions`, `role` and the template's
`organization_membership_id`; `iss` is `<base url>/user_management/<client id>`. Because
`admin@example.com` belongs to two organizations, a password sign-in without `organization_id`
answers `organization_selection_required` (the multi-org path).

```sh
npx @workos/emulate@0.18.0 --seed infra/workos/emulate.yaml --validate-config
```

Notes (checked with 0.18.0): seeding `apiKeys` replaces `sk_test_default`, so this file seeds
none and tests create organization API keys at run time; the signing key changes on every
restart unless `--signing-key` is given, so restart api too (or let it refetch the JWKS).

## Tests against Emulate

- `apps/api/tests/emulate/`: the api's sign-in, refresh, logout, multi-org, org boundary and
  personal-org tests (pytest; skipped unless an emulator answers at
  `<envPrefix>TEST_WORKOS_EMULATE_URL`, default `http://localhost:4100`). In the `ci` workflow.
- `tests/e2e/auth/`: the e2e harness (Emulate + api + agent + Vite in `workos` mode) and the
  `sign_in(email, password)` helper for browser and cross-service tests. In the manual `e2e` workflow.
- `.github/workflows/auth-nightly.yml`: one password sign-in against WorkOS staging, off until its
  repository secrets exist.
