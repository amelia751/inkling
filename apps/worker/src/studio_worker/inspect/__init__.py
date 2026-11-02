"""Inspection: the built-in subscriber for `source.uploaded` (todo6 Phase 5.1).

For every file an import committed, the worker reads its bytes through the kernel (worker
token, `GET /api/v1/worker/inspect/nodes/:id/content`, ranged), detects the kind from content,
extracts facts, makes a thumbnail where it makes sense, and sets flags (privacy holds,
quality problems, "can't read this file yet"). DICOM files are grouped into candidate series
with gap and orientation checks; tables get a column profile. It reports everything in one
call (`POST …/imports/:id/report`); the kernel stores it, builds the proposals (group,
relationship, label mapping, dataset) and moves the session to `needs_review` or `ready`.

Like `deid.py`, events are acknowledged (`EventConsumption`) only once the report landed, so a
crash or an unreachable kernel means the next tick inspects again; the kernel ignores a
report for a session that already finished. Scratch files go under the worker's data dir
and are deleted after each file.
"""

from __future__ import annotations

from typing import Any

import logging
import os
import posixpath
import tempfile
from pathlib import Path

import httpx

from .. import derive
from . import detect, dicom, media, privacy, sidecars, tables

SUBSCRIBER = "inspect"
TYPES = ["source.uploaded"]
INSPECTOR = "dev-inspect-v1"
HEAD = 64 * 1024
DICOM_HEAD = 2 * 1024 * 1024
# How much of a file we read in full, per kind (bigger files keep extension-level facts).
FULL_LIMIT = {"image": 64 << 20, "dicom": 512 << 20, "volume": 512 << 20, "mask": 512 << 20, "video": 2 << 30, "table": 64 << 20, "document": 64 << 20, "archive": 64 << 20, "annotations": 32 << 20}

log = logging.getLogger("studio_worker.inspect")


class InspectSubscriber:
    def __init__(self, http: httpx.Client, scratch: Path | None = None):
        self.http = http
        self.scratch = scratch or Path(tempfile.gettempdir())

    def tick(self) -> int:
        r = self.http.post("/api/v1/worker/subscriptions/claim", json={"subscriber": SUBSCRIBER, "types": TYPES, "limit": 5})
        r.raise_for_status()
        done = []
        for ev in r.json().get("events") or []:
            try:
                self.handle(ev)
            except (httpx.HTTPError, KeyError, ValueError) as e:  # unacked: inspected again next tick
                log.warning("inspection failed", extra={"event_id": ev.get("eventId"), "error": str(e)[:300]})
                continue
            done.append(ev["eventId"])
        if done:
            self.http.post("/api/v1/worker/subscriptions/ack", json={"subscriber": SUBSCRIBER, "eventIds": done})
        return len(done)

    # ---- One import ----------------------------------------------------------------------

    def handle(self, ev: dict) -> str:
        import_id = ev["payload"]["importId"]
        r = self.http.get(f"/api/v1/worker/inspect/imports/{import_id}")
        if r.status_code == 404:
            return "gone"
        r.raise_for_status()
        imp = r.json()
        if imp.get("state") != "inspecting":
            return "not-inspecting"
        files = imp.get("files") or []
        # Names of the files already in the drop's dataset (kernel, todo13 §3.3): a labels table
        # dropped later is keyed by them, not by names in its own import.
        report = self.inspect_files(files, known=[str(n) for n in imp.get("knownNames") or []])
        r = self.http.post(f"/api/v1/worker/inspect/imports/{import_id}/report", json={"inspector": INSPECTOR, **report})
        if r.status_code == 409:
            return "stale"
        r.raise_for_status()
        return str(r.json().get("state"))

    def inspect_files(self, files: list[dict], known: list[str] | None = None) -> dict:
        paths = [f["relPath"] for f in files]
        names = paths + (known or [])
        stems = {posixpath.splitext(p)[0] for p in paths if p.lower().endswith(".hea")}
        nodes: list[dict] = []
        instances: list[dicom.Instance] = []
        sizes = {f["nodeId"]: int(f.get("size") or 0) for f in files}
        for f in files:
            try:
                out, inst = self.inspect_one(f, names, stems)
            except httpx.HTTPError:
                raise
            except Exception as e:  # noqa: BLE001 — one odd file never stops the import
                log.warning("couldn't inspect a file", extra={"node_id": f.get("nodeId"), "error": type(e).__name__})
                out, inst = {"nodeId": f["nodeId"], "detectedKind": "unknown", "facts": {}, "flags": {"unsupported": "We couldn't read this file"}}, None
            # Path names: on every file, whatever its kind.
            reasons = privacy.path_findings(f["relPath"])
            if reasons and "privacy" not in out["flags"]:
                out["flags"]["privacy"] = privacy.flag(reasons, "path")
            nodes.append(out)
            if inst is not None:
                instances.append(inst)
        # Sidecars and pairs (todo18 D5); derivatives the browser needs (D4).
        _pairs, lone = sidecars.pair_files(paths)
        for f, n in zip(files, nodes):
            if f["relPath"] in lone:
                n["flags"]["pair"] = lone[f["relPath"]]["message"]
            seg = sidecars.segmentation_role(f["relPath"])
            if seg:
                n["facts"].update(seg)
            need = derive.derivative_kind(f["relPath"], n.get("detectedKind"))
            if need:
                n["facts"]["derivative"] = {"kind": need, "state": "processing", "progress": 0}
        # ACDC Info.cfg (ED/ES, height, weight) → meta of the volumes in its folder (0-based frames).
        for f in files:
            if posixpath.basename(f["relPath"]).lower() == "info.cfg" and 0 < int(f.get("size") or 0) <= 64 * 1024:
                info = sidecars.parse_acdc_info(self._all(f["nodeId"], int(f["size"])).decode("utf-8", "replace"))
                folder = posixpath.dirname(f["relPath"])
                for g, n in zip(files, nodes):
                    if g is not f and posixpath.dirname(g["relPath"]) == folder and n.get("detectedKind") in ("volume", "mask"):
                        n["facts"]["acdc"] = sidecars.item_meta(info)
        groups = dicom.group_series(instances)
        by_id = {n["nodeId"]: n for n in nodes}
        for g in groups:
            for nid in g["nodeIds"]:
                n = by_id[nid]
                n["facts"]["series"] = {"seriesUidHash": g["seriesUidHash"], "sliceCount": g["sliceCount"]}
                if g["quality"]:
                    n["flags"]["quality"] = g["quality"]
            # The series' thumbnail: its first slice with a default window.
            first = g["nodeIds"][0]
            if 0 < sizes[first] <= FULL_LIMIT["image"] and "privacy" not in by_id[first]["flags"]:
                self._thumb_from(by_id[first]["facts"], first, self._all(first, sizes[first]))
        return {"nodes": nodes, "groups": groups}

    def inspect_one(self, f: dict, paths: list[str], hea_stems: set[str]) -> tuple[dict, dicom.Instance | None]:
        nid, name, size = f["nodeId"], f["name"], int(f.get("size") or 0)
        head = self._range(nid, 0, HEAD - 1) if size else b""
        facts: dict[str, Any]
        kind, facts = detect.detect(name, head)
        flags: dict = {}
        full: bytes | None = None
        if kind in ("archive", "table", "document", "annotations") and head.startswith(b"PK") and size <= FULL_LIMIT["archive"]:
            full = self._all(nid, size)
            kind, facts = detect.detect(name, head, full)
        if kind == "unknown" and name.lower().endswith(".dat") and posixpath.splitext(f["relPath"])[0] in hea_stems:
            kind, facts = "waveform", {"format": "WFDB signal"}
        inst = None
        if kind == "image" and size <= FULL_LIMIT["image"]:
            more, thumb = media.image_facts(full or self._all(nid, size, head))
            facts |= more
            if thumb:
                facts["thumbnail"] = self._derived(nid, "thumbnail", thumb, "image/png")
        elif kind == "dicom":
            data = head if size <= HEAD else self._range(nid, 0, min(size, DICOM_HEAD) - 1)
            ds = dicom.read_header(data)
            if ds is None and size > DICOM_HEAD and size <= FULL_LIMIT["dicom"]:
                data = self._all(nid, size)
                ds = dicom.read_header(data)
            if ds is None:
                flags["unsupported"] = "This DICOM file's header couldn't be read"
            else:
                more, held, inst = dicom.header_facts(ds, nid, name)
                facts |= more
                if held:
                    flags["privacy"] = held
                if not inst.series and not held and size <= FULL_LIMIT["image"]:
                    self._thumb_from(facts, nid, data if len(data) >= size else self._all(nid, size))
        elif kind in ("volume", "mask") and size <= FULL_LIMIT["volume"]:
            if facts.get("format") == "NIfTI":
                kind, more = media.volume_facts(self._all(nid, size, head), name, kind)
                facts |= more
        elif kind == "video" and size <= FULL_LIMIT["video"]:
            path = self._to_file(nid, size)
            try:
                facts |= media.video_facts(path)
            finally:
                os.unlink(path)
        elif kind == "table" and size <= FULL_LIMIT["table"]:
            data = full or self._all(nid, size, head)
            if facts.get("format") == "XLSX":
                text, book = tables.xlsx_to_csv(data)
                facts["workbook"] = book
                csv_path = self._derived(nid, "table-csv", text.encode(), "text/csv")
                encoding = "UTF-8"
            else:
                text, encoding = tables.decode(data)
                csv_path = None
            profile, findings = tables.profile(text, name, paths)
            profile["encoding"] = encoding
            if csv_path:
                profile["csvPath"] = csv_path
            facts["table"] = profile
            if findings:
                flags["privacy"] = privacy.flag(findings, "table")
        elif kind == "document" and size <= FULL_LIMIT["document"]:
            data = full or (head if size <= HEAD else self._all(nid, size, head) if facts.get("format") == "PDF" else head)
            facts |= media.document_facts(data, str(facts.get("format") or ""))
        elif kind == "unknown":
            flags["unsupported"] = "We can't read this file yet"
        return {"nodeId": nid, "detectedKind": kind, "facts": facts, "flags": flags}, inst

    # ---- Thumbnails ------------------------------------------------------------------------

    def _thumb_from(self, facts: dict, nid: str, data: bytes) -> None:
        png = dicom.thumbnail(data)
        if png:
            facts["thumbnail"] = self._derived(nid, "thumbnail", png, "image/png")

    # ---- Kernel I/O ------------------------------------------------------------------------

    def _range(self, nid: str, start: int, end: int) -> bytes:
        r = self.http.get(f"/api/v1/worker/inspect/nodes/{nid}/content", headers={"Range": f"bytes={start}-{end}"})
        if r.status_code == 416:
            return b""
        r.raise_for_status()
        return r.content

    def _all(self, nid: str, size: int, head: bytes | None = None) -> bytes:
        if head is not None and len(head) >= size:
            return head
        r = self.http.get(f"/api/v1/worker/inspect/nodes/{nid}/content", timeout=300)
        r.raise_for_status()
        return r.content

    def _to_file(self, nid: str, size: int) -> str:
        self.scratch.mkdir(parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=self.scratch, prefix="inspect-")
        with os.fdopen(fd, "wb") as fh, self.http.stream("GET", f"/api/v1/worker/inspect/nodes/{nid}/content", timeout=600) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes(1 << 20):
                fh.write(chunk)
        return path

    def _derived(self, nid: str, role: str, data: bytes, media_type: str) -> str:
        r = self.http.put(f"/api/v1/worker/inspect/nodes/{nid}/derived/{role}", content=data, headers={"Content-Type": media_type})
        r.raise_for_status()
        return r.json()["path"]
