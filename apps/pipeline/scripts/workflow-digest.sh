#!/bin/sh
# Prints the workflow package digest: the application version DBOS records on every
# workflow (todo12 E3, docs/pipeline.md §5.2). It covers the code whose step sequence a
# recovering workflow replays (workflow bodies, dispatch, the engine adapter's helpers) and
# the engine library's version; changes elsewhere (API, config, steps' insides) keep it.
# Run from apps/pipeline.
set -eu
{
  find internal/workflows internal/dispatch internal/engine -maxdepth 1 -name '*.go' ! -name '*_test.go' 2>/dev/null | LC_ALL=C sort | xargs cat
  grep 'dbos-inc/dbos-transact-golang ' go.mod
} | sha256sum 2>/dev/null | cut -c1-16 | sed 's/^/wf-/' || true
