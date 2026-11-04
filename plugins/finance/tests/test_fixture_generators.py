import numpy as np

from studio_plugin_finance.fixture_generators import FIXTURE_GENERATORS, ledger, prices, prices_match, ledger_match


def test_ledger_plants_are_where_the_truth_says():
    cols, rows, truth = ledger(None, np.random.default_rng(1), 200)
    assert cols == ["date", "merchant", "category", "amount", "currency"]
    kinds = {t["kind"] for t in truth}
    assert kinds == {"outlier", "miscategorised", "duplicate"}
    for t in truth:
        if t["kind"] == "duplicate":
            assert rows[t["row"]] == rows[t["of"]]
        if t["kind"] == "miscategorised":
            assert rows[t["row"]][2] != t["expected"]
    amounts = sorted(r[3] for r in rows)
    assert all(rows[t["row"]][3] >= amounts[-6] for t in truth if t["kind"] == "outlier")


def test_prices_regimes_gaps_split_and_determinism():
    a = prices(None, np.random.default_rng(7), 300)
    b = prices(None, np.random.default_rng(7), 300)
    assert a == b
    cols, rows, truth = a
    assert cols[-2:] == ["close", "volume"]
    kinds = [t["kind"] for t in truth]
    assert kinds.count("regime-shift") == 2 and kinds.count("split") == 1 and kinds.count("gap") >= 1
    assert len(rows) < 300  # the gaps removed days
    s = next(t for t in truth if t["kind"] == "split")
    assert rows[s["row"]][4] < rows[s["row"] - 1][4] / (s["ratio"] * 0.8)


def test_match_scores():
    led = {"columns": [{"name": "posted_date"}, {"name": "category"}, {"name": "amount"}]}
    px = {"columns": [{"name": "date"}, {"name": "close"}, {"name": "volume"}]}
    assert ledger_match(led) > prices_match(led) and prices_match(px) > ledger_match(px)
    assert {g["id"] for g in FIXTURE_GENERATORS} == {"finance-ledger", "finance-prices"}
