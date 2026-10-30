"""De-identification check for dataset reviews (todo4 Phase 6, versioning.md §9 and §14).

Subscribes to the kernel's `versioning.review.opened` and `versioning.review.checks_requested`
events. For each, it reads the review's current (source, target) oids, the samples the review
introduces (semantic diff from the merge base), checks out those samples and scans their
metadata: the sample entries themselves and every small JSON object attached to them (sample
metadata, the Studio's asset pointers, annotation revisions). Then it reports the
`deidentification` check back through the kernel, which forwards it to apps/versioning.

This is a deterministic development check, not a certified de-identification: it flags
keys that look like direct identifiers (patient name, birth date, MRN, SSN, address, phone,
e-mail…) and values shaped like SSNs, e-mail addresses or phone numbers. Pixel PHI (burned-in
text) and DICOM header parsing belong to a real checker that replaces `scan`.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

import httpx

SUBSCRIBER = "versioning-deidentification"
TYPES = ["versioning.review.opened", "versioning.review.checks_requested"]
CHECK = "deidentification"
CHECKER = "dev-metadata-v1"
MAX_OBJECT_BYTES = 256 * 1024

PHI_KEY = re.compile(
    r"(patient.?(name|id|birth|address|sex|age)|birth.?date|date.?of.?birth|\bdob\b|\bssn\b|social.?security|\bmrn\b|medical.?record|"
    r"street|address|zip.?code|postal|phone|telephone|\bfax\b|e-?mail|first.?name|last.?name|surname|given.?name|family.?name|"
    r"referring.?physician|institution.?name|accession)",
    re.I,
)
PHI_VALUE = [
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")),
    ("phone", re.compile(r"\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b")),
]
# Keys whose values are opaque hashes / ids by contract, never PHI.
OPAQUE_KEYS = {"sha256", "ref", "study_uid_hash", "series_uid_hash", "studio_hash", "manifest_root"}


def _walk(v: Any, path: str, out: list[dict], where: str) -> None:
    if isinstance(v, dict):
        for k, x in v.items():
            p = f"{path}.{k}" if path else str(k)
            if PHI_KEY.search(str(k).replace("_", " ")) or PHI_KEY.search(str(k)):
                out.append({"where": where, "path": p, "reason": "identifier-like key"})
            if str(k) not in OPAQUE_KEYS:
                _walk(x, p, out, where)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _walk(x, f"{path}[{i}]", out, where)
    elif isinstance(v, str):
        for name, rx in PHI_VALUE:
            if rx.search(v):
                out.append({"where": where, "path": path, "reason": f"{name}-shaped value"})


def scan(samples: list[dict], annotations: list[dict], objects: dict[str, Any]) -> list[dict]:
    """Findings for samples, their annotations, and their parsed JSON objects (by sha256)."""
    out: list[dict] = []
    for s in samples:
        where = f"sample:{s.get('sample_id')}"
        _walk({k: v for k, v in s.items() if k != "objects"}, "", out, where)
        for o in s.get("objects") or []:
            if o.get("sha256") in objects:
                _walk(objects[o["sha256"]], "", out, f"{where}/{o.get('role')}")
    for a in annotations:
        ref = str(a.get("ref", "")).split(":", 1)[-1]
        if ref in objects:
            _walk(objects[ref], "", out, f"annotation:{a.get('annotation_id')}")
    return out


class DeidSubscriber:
    """One pass over unacknowledged review events (called from the worker loop)."""

    def __init__(self, http: httpx.Client, log=print):
        self.http = http
        self.fetch = httpx.Client(timeout=30)
        self.log = log

    def run(self, ws: str, dataset: str, op: str, body: dict) -> tuple[int, dict]:
        r = self.http.post("/api/v1/worker/versioning/run", json={"workspaceId": ws, "datasetId": dataset, "op": op, "subscriber": SUBSCRIBER, "body": body})
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {"detail": r.text}

    def tick(self) -> int:
        r = self.http.post("/api/v1/worker/subscriptions/claim", json={"subscriber": SUBSCRIBER, "types": TYPES, "limit": 20})
        r.raise_for_status()
        done = []
        for ev in r.json().get("events") or []:
            try:
                self.handle(ev)
            except (httpx.HTTPError, KeyError, ValueError) as e:  # leave it unacked; retried next tick
                self.log(f"[worker] de-identification check for {ev.get('eventId')} failed: {e}", file=sys.stderr)
                continue
            done.append(ev["eventId"])
        if done:
            self.http.post("/api/v1/worker/subscriptions/ack", json={"subscriber": SUBSCRIBER, "eventIds": done})
        return len(done)

    def handle(self, ev: dict) -> str:
        """Returns the outcome reported, or why nothing was."""
        ws, p = ev["workspaceId"], ev["payload"]
        ds, rid = p["datasetId"], p["reviewId"]
        st, rv = self.run(ws, ds, "review.get", {"review_id": rid})
        if st == 404:
            return "gone"
        if st >= 400:
            raise ValueError(f"review.get {st}: {rv.get('detail')}")
        source, target = rv["source_oid"], rv.get("checked_target_oid")
        check = next((c for c in rv.get("checks") or [] if c.get("name") == CHECK), None)
        if rv.get("status") != "CHECKING" or not check or check.get("outcome") != "pending" or not target:
            return "not-pending"
        # What the review introduces: merge base (or target) → source.
        changed: set[str] = set()
        cursor = None
        while True:
            st, d = self.run(ws, ds, "diff", {"base": rv.get("base_oid") or target, "head": source, "limit": 1000, **({"cursor": cursor} if cursor else {})})
            if st >= 400:
                raise ValueError(f"diff {st}: {d.get('detail')}")
            changed |= {c["sample_id"] for c in d.get("changes") or [] if c.get("sample_id") and not c["type"].endswith(".removed")}
            cursor = d.get("next_cursor")
            if not cursor:
                break
        findings: list[dict] = []
        scanned = 0
        ids = sorted(changed)
        for i in range(0, len(ids), 1000):
            cursor = None
            while True:
                st, co = self.run(ws, ds, "checkout", {"ref": source, "filter": {"sample_ids": ids[i : i + 1000]}, "include_urls": True, "limit": 1000, **({"cursor": cursor} if cursor else {})})
                if st >= 400:
                    raise ValueError(f"checkout {st}: {co.get('detail')}")
                objects = {}
                for o in co.get("objects") or []:
                    if o.get("url") and 0 < int(o.get("size_bytes") or 0) <= MAX_OBJECT_BYTES:
                        objects[o["sha256"]] = self._json(o["url"])
                findings += scan(co.get("samples") or [], co.get("annotations") or [], {k: v for k, v in objects.items() if v is not None})
                scanned += len(co.get("samples") or [])
                cursor = co.get("next_cursor")
                if not cursor:
                    break
        outcome = "failed" if findings else "passed"
        st, out = self.run(ws, ds, "review.check", {"review_id": rid, "name": CHECK, "source_oid": source, "target_oid": target, "outcome": outcome, "details": {"checker": CHECKER, "samples_scanned": scanned, "findings": findings[:50], "finding_count": len(findings)}})
        if st == 409:  # the review moved on; the newer event re-runs the check
            return "stale"
        if st >= 400:
            raise ValueError(f"report {st}: {out.get('detail')}")
        return outcome

    def _json(self, url: str) -> Any:
        try:
            if url.startswith("memory://"):  # the kernel's in-process stand-in (tests, dev)
                return None
            r = self.fetch.get(url)
            return json.loads(r.content) if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
