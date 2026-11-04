"""Inspection: the built-in subscriber for `source.uploaded` (todo6 Phase 5.1).

For every file an import committed, the worker reads its bytes through the kernel (worker
token, `GET /api/v1/worker/inspect/nodes/:id/content`, ranged), detects the kind from content,
extracts facts, makes a thumbnail where it makes sense, and sets flags (privacy holds,
quality problems, "can't read this file yet"). DICOM files are grouped into candidate series
with gap and orientation checks; tables get a column profile.

todo28 W1: the file is the unit. Files are checked several at a time, small and quick ones
first, and each is posted (`POST …/imports/:id/nodes`) as soon as it's done, so it can reach a
Studio while a 160 MB slide is still being read; a group (a DICOM series, a WFDB record, a folder
with its `Info.cfg`) is posted together once its members are. A file that can't be read over HTTP
is retried on its own and never holds the others. The closing call (`POST …/imports/:id/report`)
sends the groups, the files not posted yet and those still retrying; the kernel builds the
proposals and moves the session to `needs_review` or `ready`.

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
import threading
import time
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

import httpx

from .. import derive
from . import detect, dicom, media, privacy, sidecars, tables

SUBSCRIBER = "inspect"
RECHECK = "source.node.recheck"
TYPES = ["source.uploaded", RECHECK]
INSPECTOR = "dev-inspect-v1"
HEAD = 64 * 1024
DICOM_HEAD = 2 * 1024 * 1024
# How much of a file we read in full, per kind (bigger files keep extension-level facts).
FULL_LIMIT = {"image": 64 << 20, "dicom": 512 << 20, "volume": 512 << 20, "mask": 512 << 20, "video": 2 << 30, "table": 64 << 20, "document": 64 << 20, "archive": 64 << 20, "annotations": 32 << 20}

POST_BATCH = 20  # nodes per `…/nodes` call
FLUSH_S = 0.5  # a finished file waits at most this long for others to share its post

# todo28 W1 order: what becomes an item fastest first; slides and videos last.
FIRST_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".pdf", ".txt", ".md", ".csv", ".tsv", ".xlsx", ".json", ".docx"}
LAST_EXT = {".svs", ".ndpi", ".mrxs", ".scn", ".vms", ".vmu", ".bif", ".tif", ".tiff", ".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v", ".mpg", ".mpeg"}
GROUP_EXT = {".dcm", ".dicom", ".hea", ".dat", ".mat"}

log = logging.getLogger("studio_worker.inspect")


class InspectSubscriber:
    # Waits between the 5 tries of one file's check (todo28 W1): about 3 minutes in all.
    BACKOFF_S: tuple[float, ...] = (2.0, 10.0, 40.0, 120.0)

    def __init__(self, http: httpx.Client, scratch: Path | None = None, *, concurrency: int = 4, backoff_s: tuple[float, ...] | None = None):
        self.http = http
        self.scratch = scratch or Path(tempfile.gettempdir())
        self.concurrency = max(1, int(concurrency))
        self.backoff_s = self.BACKOFF_S if backoff_s is None else tuple(backoff_s)
        # Reads run `concurrency` at a time; writes to the kernel (derived files, posts) one at a
        # time, so a SQLite kernel (dev, tests) never sees two of this worker's writes at once.
        self._writes = threading.Lock()

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
        payload = ev.get("payload") or {}
        import_id = payload["importId"]
        recheck = ev.get("type") == RECHECK
        r = self.http.get(f"/api/v1/worker/inspect/imports/{import_id}")
        if r.status_code == 404:
            return "gone"
        r.raise_for_status()
        imp = r.json()
        files = imp.get("files") or []
        if recheck:
            # todo28 W1: files whose check kept failing over HTTP, asked again by the kernel's
            # sweeper after their import closed. Posted one by one; there's no report to send.
            wanted = {str(i) for i in payload.get("nodeIds") or []}
            files = [f for f in files if f["nodeId"] in wanted]
            if not files:
                return "nothing"
            self.inspect_files(files, known=[str(n) for n in imp.get("knownNames") or []], post=self._poster(import_id))
            return "rechecked"
        if imp.get("state") != "inspecting":
            return "not-inspecting"
        # Names of the files already in the drop's dataset (kernel, todo13 §3.3): a labels table
        # dropped later is keyed by them, not by names in its own import.
        posted: set[str] = set()
        report = self.inspect_files(files, known=[str(n) for n in imp.get("knownNames") or []], post=self._poster(import_id, posted))
        # The closing report: groups, proposals, the session's state. Nodes already posted aren't
        # sent again (the kernel would keep their first result anyway).
        report["nodes"] = [n for n in report["nodes"] if n["nodeId"] not in posted]
        r = self.http.post(f"/api/v1/worker/inspect/imports/{import_id}/report", json={"inspector": INSPECTOR, **report})
        if r.status_code == 409:
            return "stale"
        r.raise_for_status()
        return str(r.json().get("state"))

    def _poster(self, import_id: str, posted: set[str] | None = None) -> Callable[[list[dict]], None]:
        """Posts finished files (`POST …/imports/:id/nodes`). A post that keeps failing leaves its
        nodes to the closing report, which applies them the same way."""

        def post(nodes: list[dict]) -> None:
            for attempt in range(3):
                try:
                    with self._writes:
                        r = self.http.post(f"/api/v1/worker/inspect/imports/{import_id}/nodes", json={"inspector": INSPECTOR, "nodes": nodes})
                    if r.status_code in (404, 409):
                        return
                    r.raise_for_status()
                    if posted is not None:
                        posted.update(n["nodeId"] for n in nodes)
                    return
                except httpx.HTTPError as e:
                    log.warning("posting checked files failed", extra={"node_ids": [n["nodeId"] for n in nodes][:20], "attempt": attempt + 1, "error": type(e).__name__})
                    time.sleep(self.backoff_s[min(attempt, len(self.backoff_s) - 1)] if self.backoff_s else 0)

        return post

    def inspect_files(self, files: list[dict], known: list[str] | None = None, post: Callable[[list[dict]], None] | None = None) -> dict:
        """todo28 W1: every file on its own. Small, quick files first (`order`), `concurrency` at a
        time; each file's result goes to `post` within about a second of finishing, at most 20 per
        call. Files that only make sense with their group (DICOM slices, a WFDB record, a folder with
        an `Info.cfg`, label tables) wait for the rest and are posted together, one call per group.
        A file whose bytes can't be read over HTTP is retried on its own (`backoff_s`) and, if it
        still fails, comes back in `retrying` instead of `nodes`: the import closes without it and
        the kernel asks again later."""
        paths = [f["relPath"] for f in files]
        names = paths + (known or [])
        stems = {posixpath.splitext(p)[0] for p in paths if p.lower().endswith(".hea")}
        cfg_dirs = {posixpath.dirname(p) for p in paths if posixpath.basename(p).lower() == "info.cfg"}
        _pairs, lone = sidecars.pair_files(paths)
        results: dict[str, tuple[dict, dicom.Instance | None]] = {}
        retrying: list[str] = []
        held: list[str] = []  # node ids waiting for their group
        buf: list[dict] = []
        buf_at = 0.0

        def flush() -> None:
            nonlocal buf
            while buf:
                chunk, buf = buf[:POST_BATCH], buf[POST_BATCH:]
                if post is not None:
                    post(chunk)

        order = sorted(files, key=lambda f: order_key(f, stems, cfg_dirs))
        with ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="inspect") as pool:
            pending = {pool.submit(self._inspect_retrying, f, names, stems): f for f in order}
            while pending:
                done, _ = wait(pending, timeout=0.25, return_when=FIRST_COMPLETED)
                for fut in done:
                    f = pending.pop(fut)
                    got = fut.result()
                    if got is None:
                        retrying.append(f["nodeId"])
                        continue
                    out, inst = got
                    self._finish_one(f, out, lone)
                    results[f["nodeId"]] = (out, inst)
                    if inst is not None or grouped(f["relPath"], out, stems, cfg_dirs):
                        held.append(f["nodeId"])
                    else:
                        if not buf:
                            buf_at = time.monotonic()
                        buf.append(out)
                if buf and (len(buf) >= POST_BATCH or not pending or time.monotonic() - buf_at >= FLUSH_S):
                    flush()
        # Groups: ACDC Info.cfg (ED/ES, height, weight) → meta of the volumes in its folder (0-based
        # frames); the cfg itself becomes a hidden `info` slot of that group (todo19 §2 A), not a
        # loose document the plan keeps as a reference.
        by_file = {f["nodeId"]: f for f in files}
        sizes = {f["nodeId"]: int(f.get("size") or 0) for f in files}
        for f in files:
            if f["nodeId"] not in results:
                continue
            fn = results[f["nodeId"]][0]
            if posixpath.basename(f["relPath"]).lower() == "info.cfg" and 0 < sizes[f["nodeId"]] <= 64 * 1024:
                try:
                    raw = self._retry(lambda f=f: self._all(f["nodeId"], sizes[f["nodeId"]]), f["nodeId"])
                except httpx.HTTPError:
                    continue
                info = sidecars.parse_acdc_info(raw.decode("utf-8", "replace"))
                folder = posixpath.dirname(f["relPath"])
                used: list[str] = []
                for nid, (n, _inst) in results.items():
                    g = by_file[nid]
                    if g is not f and posixpath.dirname(g["relPath"]) == folder and n.get("detectedKind") in ("volume", "mask"):
                        n["facts"]["acdc"] = sidecars.item_meta(info)
                        used.append(nid)
                if used:
                    fn["facts"]["sidecar"] = sidecar_slot(f["relPath"], used)
        instances = [inst for (_n, inst) in results.values() if inst is not None]
        groups = dicom.group_series(instances)
        nodes = [results[f["nodeId"]][0] for f in files if f["nodeId"] in results]
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
                try:
                    data = self._retry(lambda first=first: self._all(first, sizes[first]), first)
                    self._retry(lambda first=first, data=data: self._thumb_from(by_id[first]["facts"], first, data), first)
                except httpx.HTTPError:
                    pass  # no thumbnail: the series is still checked
        # Post the held files group by group: a series, a folder, a record.
        waiting = set(held)
        for g in groups:
            ids = [i for i in g["nodeIds"] if i in waiting]
            if ids and post is not None:
                post([by_id[i] for i in ids])
            waiting -= set(ids)
        by_group: dict[str, list[dict]] = {}
        for nid in held:
            if nid in waiting:
                by_group.setdefault(group_key(by_file[nid]["relPath"], stems, cfg_dirs), []).append(by_id[nid])
        for members in by_group.values():
            for i in range(0, len(members), 500):
                if post is not None:
                    post(members[i : i + 500])
        out: dict = {"nodes": nodes, "groups": groups}
        if retrying:
            out["retrying"] = retrying
        return out

    def _finish_one(self, f: dict, out: dict, lone: dict) -> None:
        """The per-file parts that only need the file list: path privacy, a lone sidecar, a
        segmentation role, the derivative the browser needs (todo18 D4, D5)."""
        reasons = privacy.path_findings(f["relPath"])
        if reasons and "privacy" not in out["flags"]:
            out["flags"]["privacy"] = privacy.flag(reasons, "path")
        if f["relPath"] in lone:
            out["flags"]["pair"] = lone[f["relPath"]]["message"]
        seg = sidecars.segmentation_role(f["relPath"])
        if seg:
            out["facts"].update(seg)
        need = derive.derivative_kind(f["relPath"], out.get("detectedKind"))
        if need:
            out["facts"]["derivative"] = {"kind": need, "state": "processing", "progress": 0}

    def _retry(self, fn: Callable[[], Any], nid: str) -> Any:
        """`fn`, retried on an HTTP error with backoff (`backoff_s`, 5 tries in all). Logs the node
        id only, never a name."""
        for attempt in range(len(self.backoff_s) + 1):
            try:
                return fn()
            except httpx.HTTPError as e:
                if not transient(e) or attempt >= len(self.backoff_s):
                    log.warning("checking a file failed after retries", extra={"node_id": nid, "attempts": attempt + 1, "error": type(e).__name__})
                    raise
                log.info("retrying a file's check", extra={"node_id": nid, "attempt": attempt + 1, "error": type(e).__name__})
                time.sleep(self.backoff_s[attempt])
        raise AssertionError("unreachable")

    def _inspect_retrying(self, f: dict, names: list[str], stems: set[str]) -> tuple[dict, dicom.Instance | None] | None:
        try:
            return self._retry(lambda: self._inspect_safe(f, names, stems), f["nodeId"])
        except httpx.HTTPError as e:
            if transient(e):
                return None
            # The kernel refused this file (gone, not ours): nothing to retry.
            return {"nodeId": f["nodeId"], "detectedKind": "unknown", "facts": {}, "flags": {"unsupported": "We couldn't check this file"}}, None

    def _inspect_safe(self, f: dict, names: list[str], stems: set[str]) -> tuple[dict, dicom.Instance | None]:
        try:
            return self.inspect_one(f, names, stems)
        except httpx.HTTPError:
            raise
        except Exception as e:  # noqa: BLE001 — one odd file never stops the import
            log.warning("couldn't inspect a file", extra={"node_id": f.get("nodeId"), "error": type(e).__name__})
            return {"nodeId": f["nodeId"], "detectedKind": "unknown", "facts": {}, "flags": {"unsupported": "We couldn't read this file"}}, None

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
        if kind in ("unknown", "document", "table") and wfdb_signal(f["relPath"], hea_stems):
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
        with self._writes:
            r = self.http.put(f"/api/v1/worker/inspect/nodes/{nid}/derived/{role}", content=data, headers={"Content-Type": media_type})
        r.raise_for_status()
        return r.json()["path"]


def transient(e: httpx.HTTPError) -> bool:
    """Worth another try: the network, a timeout, the kernel busy or restarting (5xx, 408, 429).
    Any other 4xx answers the same next time."""
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        return code >= 500 or code in (408, 429)
    return True


def order_key(f: dict, stems: set[str], cfg_dirs: set[str]) -> tuple[int, int]:
    """Images, documents and tables that stand alone first, then the rest by size; files that wait
    for a group after those; slides and videos last."""
    rel = f["relPath"]
    ext = posixpath.splitext(rel)[1].lower()
    size = int(f.get("size") or 0)
    if ext in LAST_EXT:
        return 3, size
    if ext in GROUP_EXT or posixpath.dirname(rel) in cfg_dirs:
        return 2, size
    return (0 if ext in FIRST_EXT else 1), size


def grouped(rel_path: str, out: dict, stems: set[str], cfg_dirs: set[str]) -> bool:
    """A file posted with its group rather than on its own: a WFDB header or signal, anything in a
    folder with an `Info.cfg` (and the cfg), a label table (keyed by the other files' names)."""
    stem, ext = posixpath.splitext(rel_path)
    if ext.lower() == ".hea" or (ext.lower() in (".dat", ".mat") and stem in stems):
        return True
    if posixpath.dirname(rel_path) in cfg_dirs:
        return True
    table = (out.get("facts") or {}).get("table")
    return isinstance(table, dict) and bool(table.get("nameColumns"))


def group_key(rel_path: str, stems: set[str], cfg_dirs: set[str]) -> str:
    stem, ext = posixpath.splitext(rel_path)
    if ext.lower() in (".hea", ".dat", ".mat") and stem in stems:
        return "wfdb:" + stem
    if posixpath.dirname(rel_path) in cfg_dirs:
        return "dir:" + posixpath.dirname(rel_path)
    return "tables"


def wfdb_signal(rel_path: str, hea_stems: set[str]) -> bool:
    """A `.dat` or `.mat` next to a `.hea` of the same stem is that record's signal (todo19 §2 A:
    PTB-XL and PhysioNet 2020 use `.mat`)."""
    stem, ext = posixpath.splitext(rel_path)
    return ext.lower() in (".dat", ".mat") and stem in hea_stems


def sidecar_slot(rel_path: str, consumed_by: list[str]) -> dict:
    """`facts.sidecar` for a file read into its group's item metadata (ACDC `Info.cfg`): a hidden
    slot of the group in its folder, so the drop plan doesn't list it as a loose document."""
    return {"role": "info", "slot": "info", "group": posixpath.dirname(rel_path), "hidden": True, "consumedBy": list(consumed_by)}
