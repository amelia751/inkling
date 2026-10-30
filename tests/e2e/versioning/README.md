# Dataset versioning e2e (`versioning.md` §16, todo4 Phase 6)

End-to-end flows over the public HTTP APIs: `apps/api` (the kernel) in front of
`apps/versioning` (Go) against real Postgres and an S3-compatible object store, with
`apps/worker` running the de-identification check. No browser.

| Flow | File | What it proves |
|---|---|---|
| A | `flow_a_test.py` | Initial upload: bytes to object storage, commit on the uploader's work branch, review into protected `main` (checks + the worker's de-identification check), a steward approves and merges, `v1` is released; its annotations load and its bytes verify by sha256 through signed URLs. |
| B | `flow_b_test.py` | Two users edit the same annotation on their own work branches; a save from a stale head is a 409 `stale_head`; the first review merges, the second is `CONFLICTED`; the conflict is resolved with a custom annotation, approved by the other user, merged, released `v2`. |
| C | `flow_c_test.py` | An agent session (minted by a user) creates `work/agent-*`, commits and opens a review through the kernel commands (`<ns>.versioning.*` via `POST /api/v1/commands`); its approve, merge, release and off-branch writes are refused, and the user it acts for can't approve either; another human approves and merges. |
| chaos | `chaos_test.py` | **Skipped.** Pod-kill during commits needs the dev k8s overlay, which doesn't exist until todo3 / todo4 Phase 5. |

## Run

Needs Docker, Go (see `apps/versioning/go.mod`) and `uv`.

```bash
# from the repo root: starts everything, runs A, B, C (+ chaos: skipped), tears down
uv run --project apps/api python tests/e2e/versioning/run.py

uv run --project apps/api python tests/e2e/versioning/run.py b c       # some flows
uv run --project apps/api python tests/e2e/versioning/run.py --keep    # leave the containers up
uv run --project apps/api python tests/e2e/versioning/run.py --serve   # just the stack, until Ctrl-C
uv run --project apps/api python tests/e2e/versioning/flow_b_test.py --api http://127.0.0.1:58800   # one flow, running stack
```

`stack.py` does, in order:

1. `docker compose -f tests/e2e/versioning/compose.yaml up -d --wait`: Postgres 17 on
   `127.0.0.1:56432` and RustFS (MinIO-compatible) on `127.0.0.1:59900`.
2. Builds `apps/versioning` (`cmd/server`, `cmd/migrate`), runs `migrate bootstrap` (roles and
   the `versioning` schema) and `migrate up`, and creates the `<resourcePrefix>-objects` and
   `<resourcePrefix>-manifests` buckets.
3. Generates the API's dev Ed25519 key pair in a temp data dir (`versioning-jwt.key`, private;
   `versioning-jwks.json`, public) and starts `apps/versioning` on `:58890` with
   `<envPrefix>VERSIONING_JWT_PUBLIC_KEY_FILE` pointing at the JWKS.
4. Starts `apps/api` on `:58800` with `<envPrefix>API_VERSIONING_URL=http://127.0.0.1:58890`
   (a fresh SQLite kernel DB) and `apps/worker` against it.

Env-var names use `envPrefix` from `schemas/naming.json`. Logs of the three processes land in
the temp dir the runner prints, and are dumped on failure.

## The same stack for the Studio

To try the versioned save flow in the browser, `run.py --serve` keeps the stack up until
Ctrl-C; then run the web app with the kernel proxy pointed at the API:
`<envPrefix>KERNEL=1 <envPrefix>KERNEL_URL=http://127.0.0.1:58800 pnpm dev` in `apps/web`. The
Studio switches to work branches when `GET /api/v1/versioning/status` reports `ready`.
Without Go, `<envPrefix>API_VERSIONING_URL=memory:` gives the kernel an in-process stand-in
(`kernel/versioning/fake.py`; state is lost on restart).
