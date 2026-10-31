"""A ZIP written as it streams (todo7 Phase 6): stored entries (no compression: medical
images are already compressed, and it keeps the CPU flat), data descriptors after each entry
and ZIP64 when needed, so a 2 GB folder streams in constant memory. Bytes come from the
BlobStore in chunks; nothing is buffered beyond about one chunk.
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterable, Iterator
from datetime import datetime

from .. import blobstore
from . import assets

FLUSH_BYTES = 1 << 20
HELD_NOTE = "_held_files.txt"


class _Sink:
    """A write-only, non-seekable file object: `zipfile` then writes data descriptors."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.pos = 0

    def write(self, data: bytes) -> int:
        self.buf += data
        self.pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


def stream(entries: Iterable[tuple[str, str, int | None]], note: bytes | None = None, stamp: datetime | None = None) -> Iterator[bytes]:
    """`entries`: (name in the ZIP, asset path, size). `note` becomes `_held_files.txt`."""
    sink = _Sink()
    when = (stamp or datetime(1980, 1, 1)).timetuple()[:6]
    zf = zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True)  # type: ignore[arg-type]
    try:
        for name, path, size in entries:
            info = zipfile.ZipInfo(name, date_time=when)
            info.compress_type = zipfile.ZIP_STORED
            chunks = assets.store_of(path).iter_range(path)
            try:
                first = next(chunks, b"")
            except blobstore.BlobNotFound:
                continue  # bytes missing: leave the entry out rather than break the archive
            with zf.open(info, "w", force_zip64=size is None or size >= (1 << 31)) as w:
                w.write(first)
                for chunk in chunks:
                    w.write(chunk)
                    if len(sink.buf) >= FLUSH_BYTES:
                        yield sink.take()
            if sink.buf:
                yield sink.take()
        if note:
            info = zipfile.ZipInfo(HELD_NOTE, date_time=when)
            zf.writestr(info, note)
    finally:
        zf.close()
    yield sink.take()
