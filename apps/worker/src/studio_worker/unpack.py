"""Archive unpack (todo13 §4 Milestone 2 item 7): the built-in subscriber for
`archive.unpack.requested`.

For each archive a drop plan says to unpack, the worker

1. copies the archive's bytes from the kernel (worker content route, streamed) into scratch under
   its data dir, refusing anything over `WORKER_UNPACK_TMP_BYTES`;
2. **checks** it without extracting: every entry's path (no absolute paths, no `..`), type (links
   and devices skipped), encryption (refused), the entry count, the total size, the
   uncompressed/compressed ratio per entry and in total (zip bombs), and the nesting depth the
   event carries; while hashing each entry it counts the bytes it really gets, so an entry that
   inflates past what its header declares is refused too;
3. sends the entry list to the kernel (`POST /api/v1/worker/unpack/{node}/start`), which opens an
   import session next to the archive, then streams each entry the kernel still wants straight
   from the archive into it (8 MiB chunks, `offset` resumes), and completes the session.

Nothing is ever extracted to disk and no entry is held in memory whole: peak memory is a chunk.
A refusal is reported (`…/refused`, the archive keeps a "Not unpacked: …" flag and the card a
chip) and the event is acknowledged. Like `inspect`, an event is acknowledged only once the
kernel has the outcome, so a crash means the next tick tries again.
"""

from __future__ import annotations

import hashlib
import logging
import os
import posixpath
import stat
import tarfile
import tempfile
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import UnpackLimits

SUBSCRIBER = "unpack"
TYPES = ["archive.unpack.requested"]
CHUNK = 1 << 20  # hashing / download reads
UPLOAD_CHUNK = 8 << 20  # one PUT (the kernel takes up to 64 MB)
RATIO_FLOOR = 1 << 20  # entries smaller than this are exempt from the per-entry ratio check

log = logging.getLogger("studio_worker.unpack")


class Refused(Exception):
    """The archive isn't unpacked; `reason` is one of the kernel's refusal codes."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


@dataclass
class Entry:
    rel_path: str
    size: int
    sha256: str
    member: object  # ZipInfo | TarInfo | None (a single .gz)


@dataclass
class Scan:
    kind: str  # zip | tar | gz
    entries: list[Entry]
    skipped: int  # links, devices, directories' own entries are not counted


def safe_path(name: str) -> str | None:
    """A relative POSIX path inside the archive, or None for an entry to refuse (absolute, `..`,
    a drive letter). Backslashes count as separators (archives made on Windows)."""
    raw = name.replace("\\", "/")
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        return None
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or not parts:
        return None
    return "/".join(parts)


def detect(path: Path) -> str:
    if zipfile.is_zipfile(path):
        return "zip"
    try:
        if tarfile.is_tarfile(path):
            return "tar"
    except (OSError, tarfile.TarError):
        pass
    with open(path, "rb") as f:
        if f.read(2) == b"\x1f\x8b":
            return "gz"
    raise Refused("unreadable", "not a ZIP, TAR or gzip archive")


def _hash_stream(chunks: Iterator[bytes], declared: int | None, compressed: int, limits: UnpackLimits, total_so_far: int) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    for c in chunks:
        n += len(c)
        if declared is not None and n > declared:
            raise Refused("ratio", "an entry inflates past its declared size")
        if total_so_far + n > limits.max_bytes:
            raise Refused("too_large")
        if n > RATIO_FLOOR and compressed and n / compressed > limits.max_ratio:
            raise Refused("ratio")
        h.update(c)
    return h.hexdigest(), n


def _chunks(f, size: int = CHUNK) -> Iterator[bytes]:
    while True:
        b = f.read(size)
        if not b:
            return
        yield b


def scan(path: Path, limits: UnpackLimits, name: str = "archive") -> Scan:
    """Check the archive and hash its entries, without extracting anything."""
    kind = detect(path)
    archive_size = max(path.stat().st_size, 1)
    entries: list[Entry] = []
    skipped = 0
    total = 0
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            if len(infos) > limits.max_files:
                raise Refused("too_many_files")
            declared = sum(i.file_size for i in infos)
            if declared > limits.max_bytes:
                raise Refused("too_large")
            if declared > RATIO_FLOOR and declared / archive_size > limits.max_ratio:
                raise Refused("ratio")
            for i in infos:
                if i.flag_bits & 0x1:
                    raise Refused("encrypted")
                rel = safe_path(i.filename)
                if rel is None:
                    raise Refused("traversal", "an entry's path leaves the archive")
                mode = (i.external_attr >> 16) & 0o170000
                if i.is_dir() or mode == stat.S_IFLNK:
                    skipped += not i.is_dir()
                    continue
                if i.file_size > RATIO_FLOOR and i.file_size / max(i.compress_size, 1) > limits.max_ratio:
                    raise Refused("ratio")
                with z.open(i) as f:
                    sha, n = _hash_stream(_chunks(f), i.file_size, i.compress_size, limits, total)
                total += n
                entries.append(Entry(rel, n, sha, i))
    elif kind == "tar":
        with tarfile.open(path, "r:*") as t:
            count = 0
            for m in t:
                count += 1
                if count > limits.max_files:
                    raise Refused("too_many_files")
                rel = safe_path(m.name)
                if rel is None:
                    raise Refused("traversal", "an entry's path leaves the archive")
                if m.isdir():
                    continue
                if not m.isfile():  # symlinks, hard links, devices, FIFOs: never followed
                    skipped += 1
                    continue
                if total + m.size > limits.max_bytes:
                    raise Refused("too_large")
                f = t.extractfile(m)
                if f is None:
                    skipped += 1
                    continue
                with f:
                    sha, n = _hash_stream(_chunks(f), m.size, 0, limits, total)
                total += n
                if total > RATIO_FLOOR and total / archive_size > limits.max_ratio:
                    raise Refused("ratio")
                entries.append(Entry(rel, n, sha, m))
    else:
        import gzip

        with gzip.open(path, "rb") as f:
            sha, n = _hash_stream(_chunks(f), None, archive_size, limits, 0)
        stem = name[:-3] if name.lower().endswith(".gz") else f"{name}.out"
        entries.append(Entry(safe_path(stem) or "file", n, sha, None))
    return Scan(kind, entries, skipped)


def open_entry(path: Path, s: Scan, e: Entry):
    """A file object over one entry's bytes (the caller closes it, and the returned archive)."""
    if s.kind == "zip":
        z = zipfile.ZipFile(path)
        return z, z.open(e.member)  # type: ignore[arg-type]
    if s.kind == "tar":
        t = tarfile.open(path, "r:*")
        return t, t.extractfile(e.member)  # type: ignore[arg-type]
    import gzip

    g = gzip.open(path, "rb")
    return g, g


class UnpackSubscriber:
    def __init__(self, http: httpx.Client, scratch: Path, limits: UnpackLimits | None = None):
        self.http = http
        self.scratch = scratch
        self.limits = limits or UnpackLimits()

    def tick(self) -> int:
        r = self.http.post("/api/v1/worker/subscriptions/claim", json={"subscriber": SUBSCRIBER, "types": TYPES, "limit": 1})
        r.raise_for_status()
        done = []
        for ev in r.json().get("events") or []:
            try:
                self.handle(ev["payload"])
            except (httpx.HTTPError, KeyError, ValueError, OSError) as e:  # unacked: tried again next tick
                log.warning("unpack failed", extra={"event_id": ev.get("eventId"), "error": type(e).__name__})
                continue
            done.append(ev["eventId"])
        if done:
            self.http.post("/api/v1/worker/subscriptions/ack", json={"subscriber": SUBSCRIBER, "eventIds": done})
        return len(done)

    def refuse(self, payload: dict, reason: str) -> str:
        log.info("unpack refused", extra={"dropId": payload.get("dropId"), "reason": reason})
        r = self.http.post(f"/api/v1/worker/unpack/{payload['nodeId']}/refused", json={"dropId": payload.get("dropId"), "reason": reason})
        if r.status_code != 404:
            r.raise_for_status()
        return f"refused:{reason}"

    def handle(self, payload: dict) -> str:
        if int(payload.get("depth") or 1) > self.limits.max_depth:
            return self.refuse(payload, "depth")
        self.scratch.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.scratch, suffix=".archive")
        path = Path(tmp)
        try:
            with os.fdopen(fd, "wb") as out:
                try:
                    self._download(payload["nodeId"], out)
                except Refused as e:
                    return self.refuse(payload, e.reason)
            try:
                s = scan(path, self.limits, posixpath.basename(str(payload.get("name") or "archive")))
            except Refused as e:
                return self.refuse(payload, e.reason)
            except (zipfile.BadZipFile, tarfile.TarError, EOFError, OSError, RuntimeError):
                return self.refuse(payload, "unreadable")
            if not s.entries:
                return self.refuse(payload, "unreadable")
            return self._send(payload, path, s)
        finally:
            path.unlink(missing_ok=True)

    def _download(self, node_id: str, out) -> None:
        n = 0
        with self.http.stream("GET", f"/api/v1/worker/inspect/nodes/{node_id}/content") as r:
            if r.status_code == 404:
                raise Refused("unreadable", "the archive is gone")
            r.raise_for_status()
            declared = int(r.headers.get("content-length") or 0)
            if declared > self.limits.tmp_bytes:
                raise Refused("tmp_budget")
            for c in r.iter_bytes(CHUNK):
                n += len(c)
                if n > self.limits.tmp_bytes:
                    raise Refused("tmp_budget")
                out.write(c)

    def _send(self, payload: dict, path: Path, s: Scan) -> str:
        entries = [{"clientFileId": f"e{i}", "relPath": e.rel_path, "size": e.size, "sha256": e.sha256} for i, e in enumerate(s.entries)]
        r = self.http.post(f"/api/v1/worker/unpack/{payload['nodeId']}/start", json={"dropId": payload.get("dropId"), "childDropId": payload.get("childDropId"), "depth": payload.get("depth"), "entries": entries})
        if r.status_code == 404:
            return "gone"
        r.raise_for_status()
        session = r.json()
        by_id = {f"e{i}": e for i, e in enumerate(s.entries)}
        for f in session.get("files") or []:
            if f.get("state") != "pending":
                continue  # duplicates already in Files, or rejected by the kernel's limits
            e = by_id.get(f["clientFileId"])
            if e is None:
                continue
            self._upload(session["id"], f["clientFileId"], path, s, e, int(f.get("received") or 0))
        r = self.http.post(f"/api/v1/worker/unpack/sessions/{session['id']}/complete")
        r.raise_for_status()
        log.info("unpacked", extra={"dropId": payload.get("dropId"), "entries": len(s.entries), "skipped": s.skipped, "kind": s.kind})
        return "unpacked"

    def _upload(self, sid: str, fid: str, path: Path, s: Scan, e: Entry, offset: int) -> None:
        holder, f = open_entry(path, s, e)
        try:
            skipped = 0
            while skipped < offset:  # resume: skip what the kernel already has
                b = f.read(min(CHUNK, offset - skipped))
                if not b:
                    break
                skipped += len(b)
            while True:
                chunk = f.read(UPLOAD_CHUNK)
                if not chunk and offset > 0:
                    break
                r = self.http.put(f"/api/v1/worker/unpack/sessions/{sid}/files/{fid}", params={"offset": offset}, content=chunk)
                r.raise_for_status()
                offset += len(chunk)
                if not chunk or offset >= e.size or r.json().get("state") != "pending":
                    break
        finally:
            f.close()
            if holder is not f:
                holder.close()
