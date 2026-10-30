# Generated service clients

`versioning/` is generated from `schemas/versioning/openapi.yaml` by
`openapi-python-client` (config: `apps/versioning/openapi-python-client.yaml`).
Regenerate with `make -C apps/versioning generate`; CI fails on drift. Do not
edit by hand.

The rest of `apps/api` is created by `todo2.md` Phase 4 (the kernel and
command gateway). The gateway routes that call this client (`routes/versioning.py`,
todo4 Phase 6) land after that.
