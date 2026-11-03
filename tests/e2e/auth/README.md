# tests/e2e/auth

The WorkOS sign-in e2e harness (todo/todo9.md, Phase 13): [WorkOS Emulate](../../../infra/workos/README.md#emulate)
seeded with `infra/workos/emulate.yaml`, the api in `workos` mode pointing at it, Vite with
`<envPrefix>WEB_AUTH_MODE=workos` and, optionally, the agent in `workos` mode with the scripted
model. Hosted AuthKit is never driven (Radar and rate limits): people sign in by password.

| File | What |
|---|---|
| `stack.py` | `AuthStack` (start and stop everything), `sign_in(email, password) -> cookie`, `playwright_cookie`, the seeded `USERS` and org ids |
| `smoke_test.py` | The stack without a browser: sign-in per person, multi-org selection and switch, verify, org boundary, logout, wrong password |
| `../persistence_test.py` | todo22 acceptance: what A makes (project, drop, two chats, rename, prefs, layout, annotation) survives a fresh browser and an api + agent restart; B in Globex sees none of it. `AuthStack(agent=True, worker=True)`, `st.restart("api", "agent")` |

The api's own Emulate tests (no browser, no Vite) are pytest in `apps/api/tests/emulate/`
and run in the `ci` workflow.

## Running

```sh
python3 tests/e2e/auth/smoke_test.py              # starts and stops its own stack
python3 tests/e2e/auth/stack.py up --agent        # leave one up; prints the env below; Ctrl-C stops it
python3 tests/e2e/agent_auth_test.py --port 58702 # with that env exported
```

Emulate runs in Docker (`ghcr.io/workos/emulate:0.18.0`), else through `npx @workos/emulate@0.18.0`;
`<envPrefix>E2E_WORKOS_EMULATE_URL` reuses one already running instead (started with `--issuer`
equal to its URL). Ports: `<envPrefix>E2E_AUTH_PORT_BASE` (default 58700) is Emulate, +1 the api
(SQLite in a temp dir), +2 Vite, +3 the agent. Process logs go to a temp dir printed at start.

`stack.py up` prints `<envPrefix>E2E_AUTH_BASE`, `<envPrefix>E2E_WORKOS_EMULATE_URL` and two
signed-in cookies, `<envPrefix>E2E_COOKIE_A` (member@example.com, Acme) and
`<envPrefix>E2E_COOKIE_B` (admin@example.com, Globex). `agent_auth_test.py` signs both people in
itself when only the emulator URL is set.

## Signing in from a test

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tests" / "e2e" / "auth"))  # from apps/web/e2e
from stack import ACME, GLOBEX, USERS, AuthStack, playwright_cookie, sign_in

with AuthStack() as st:                                   # or reuse a running one, below
    cookie = st.sign_in(*USERS["member"])                # "<ns>_session=<sealed>"
    admin = st.sign_in(*USERS["admin"], organization=GLOBEX)  # in two orgs: pick one
    context.add_cookies([playwright_cookie(cookie, st.origin)])
    page.goto(st.origin + "/")                            # signed in, no hosted page

# Against a stack someone else started (e.g. `stack.py up`, or a test runner's):
cookie = sign_in(email, password, base="http://localhost:58702", emulate_url="http://localhost:58700")
```

`sign_in` checks the password with a WorkOS password grant, then runs the api's real
`/api/auth/login` → Emulate's authorize (it answers with a code, no page) → `/api/auth/callback`,
so the cookie is minted by the api exactly as for a browser (user and membership mirrored,
personal org bootstrapped for a person without one, audit event written). It raises `SignInError`
on a wrong password or when the api isn't in `workos` mode. A person in several organizations
lands in `organization` (a WorkOS org id), else the first one WorkOS offers.

Seeded people (passwords in `infra/workos/README.md`): `admin@example.com` (Acme admin, Globex
member), `member@example.com` (Acme member, `project:create`), `billing@example.com` (Acme,
`billing:manage` only). For a person without any organization, create one through the emulator
(`POST /user_management/users` with the key `sk_test_default`); signing in bootstraps their
personal organization.

## CI

- `ci` workflow, job `workos-emulate`: the api's Emulate tests (`apps/api/tests/emulate`) against an
  emulator container, on every PR.
- `e2e` workflow (manual, `workflow_dispatch`), job `auth`: `smoke_test.py`, `agent_auth_test.py` and
  `apps/web/e2e/auth_test.py` (when present) against `stack.py up --agent`.
- `auth-nightly` workflow: one password sign-in against WorkOS staging; skipped unless its
  repository secrets are set (see the workflow file).
