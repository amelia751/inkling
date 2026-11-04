"""todo23 §5.2 W4: table profiles and planted-truth fixtures on a synthetic ledger with canary
values. No canary may appear in the profile, the fingerprint or the fixtures response; a rare
category shows as `<category:N>`; the planted truth stays out of the fixtures response."""

from __future__ import annotations

import csv
import io
import json

from studio_worker.boundary import BoundaryRunner, fixtures, generators
from studio_worker.boundary.fingerprint import fingerprint

CANARY = "CANARYzQ8Lp3Vx"
CANARY_AMOUNT = "918273.6455"


def ledger_csv() -> bytes:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["txn_id", "posted_date", "customer_name", "category", "amount", "memo"])
    for i in range(300):
        cat = ["groceries", "rent", "travel", "payroll"][i % 4]
        if i in (5, 77, 140):  # a rare category (3 < k = 10), itself a canary
            cat = f"{CANARY}_rare"
        amount = CANARY_AMOUNT if i == 42 else f"{(i * 37) % 500 + 3.25:.2f}"
        w.writerow([f"{CANARY}-{i}", f"2023-{1 + i % 12:02d}-{1 + i % 28:02d}", f"{CANARY} Person{i}", cat, amount, f"note {CANARY} {i}"])
    return out.getvalue().encode()


def test_profile_has_no_canary_and_hides_rare_categories():
    fp = fingerprint("s1", ledger_csv())
    dump = json.dumps(fp)
    assert CANARY not in dump and CANARY_AMOUNT not in dump and "918273" not in dump
    prof = fp["table"]["profile"]
    cols = {c["name"]: c for c in prof["columns"]}
    assert cols["txn_id"]["identifier"] and "categories" not in cols["txn_id"]
    assert cols["customer_name"]["identifier"] and cols["memo"]["identifier"]
    assert {c["value"] for c in cols["category"]["categories"]} == {"groceries", "rent", "travel", "payroll", "<category:3>"}
    assert len(cols["amount"]["quantiles"]) == 5 and cols["posted_date"]["dates"]["from"] == "2023-01"
    assert prof["k"] == 10 and prof["rows"] == 300


class FakeRunner(BoundaryRunner):
    def __init__(self):  # no kernel: capture what would be uploaded
        self.puts: dict[str, bytes] = {}

    def _put(self, job_id, path, data, media_type):
        import hashlib

        self.puts[path] = data
        return {"sha256": f"sha256:{hashlib.sha256(data).hexdigest()}", "bytes": len(data)}


def test_fixtures_have_planted_truth_kept_out_of_the_response():
    generators.discover()
    assert {"finance-ledger", "finance-prices"} <= set(generators.REGISTRY)
    fp = fingerprint("s1", ledger_csv())
    r = FakeRunner()
    resp = r.fixtures("j1", {"fingerprint": fp, "fixtureSetId": "abcdef0123456789abcdef01", "sampleId": "s1", "fingerprintDigest": "sha256:" + "0" * 64, "count": 2}, 60)
    assert resp["generator"] == "finance-ledger"
    assert [f["variant"] for f in resp["fixtures"]] == ["planted", "planted"]
    truth = json.loads(r.puts["truth"])
    assert truth["secret"] and all(truth["fixtures"].values())
    dump = json.dumps(resp)
    assert CANARY not in dump and "918273" not in dump
    assert set(resp["truth"]) == {"truthId", "sha256", "plants"} and "secret" not in dump and "miscategorised" not in dump
    for name, data in r.puts.items():
        assert CANARY.encode() not in data and b"918273" not in data, name
    # The reported seed alone doesn't reproduce the plants: the secret is in the truth only.
    _, again, _ = fixtures.synthesize_table(fp, 2, resp["seed"], secret=truth["secret"] + 1)
    assert again[0]["data"] != r.puts[f"fixtures/{resp['fixtures'][0]['name']}"]


def test_generic_generator_for_an_unknown_table():
    prof = {"rows": 50, "k": 10, "noise": False, "columns": [{"name": "x", "logicalType": "number", "identifier": False, "nullRate": 0, "cardinality": "11-100", "quantiles": [1, 2, 3, 4, 5]}]}
    gid, made, truth = fixtures.synthesize_table({"format": {"kind": "csv"}, "table": {"profile": prof}}, 1, 3, "profile-v1")
    assert gid == "profile-v1" and {t["kind"] for t in truth["fixtures"][made[0]["name"]]} == {"outlier", "duplicate"}
