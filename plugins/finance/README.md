# finance

Worker side of the financial analysis Studio (todo23 W8). For now: seeded fixture generators the
worker loads from `src/studio_plugin_finance/fixture_generators.py` (registered per data kind,
`apps/worker/src/studio_worker/boundary/generators.py`):

- `finance-ledger`: a transaction ledger with planted duplicates, outliers and miscategorised rows;
- `finance-prices`: daily OHLCV from a GBM with planted regime shifts, gaps and a split.

numpy only. The planted truth is returned to the worker, which stores it for the verifier only.

    uv run --project plugins/finance pytest plugins/finance/tests
