"""Typed probes on a real sample (todo10 §6.1 step 5): small questions with typed answers.

Numbers, booleans and offsets come back as they are. `read_text` returns the raw characters
only if they're short printable ASCII; the kernel then runs its free-text check and replaces
anything that isn't structural with a placeholder. `field_names` and `section_sizes` come from
the fingerprint. The kernel enforces the budget and audits every request.
"""

from __future__ import annotations

import math
import re
import struct

from .fingerprint import fingerprint


def _answer(op: str, **kw) -> dict:
    return {"op": op, "ok": kw.pop("ok", True), "error": kw.pop("error", None), "value": kw.pop("value", None), "offsets": kw.pop("offsets", None), "names": kw.pop("names", None), "sections": kw.pop("sections", None)}


def run(sample_id: str, data: bytes, probes: list[dict]) -> list[dict]:
    fp: dict | None = None
    out = []
    n = len(data)
    for p in probes[:32]:
        op = p.get("op")
        try:
            if op == "magic":
                m = bytes.fromhex(p["hex"])
                off = int(p["offset"])
                out.append(_answer(op, value=data[off : off + len(m)] == m) if off + len(m) <= n else _answer(op, ok=False, error="out_of_range"))
            elif op in ("read_int", "read_float"):
                off, w = int(p["offset"]), int(p["width"])
                if off + w > n:
                    out.append(_answer(op, ok=False, error="out_of_range"))
                    continue
                e = "<" if p.get("endian") == "little" else ">"
                if op == "read_int":
                    code = {1: "b", 2: "h", 4: "i", 8: "q"}[w]
                    v = struct.unpack(e + (code if p.get("signed") else code.upper()), data[off : off + w])[0]
                    out.append(_answer(op, value=v if abs(v) < 2**53 else str(v)))
                else:
                    v = struct.unpack(e + {4: "f", 8: "d"}[w], data[off : off + w])[0]
                    out.append(_answer(op, value=v if math.isfinite(v) else None))
            elif op == "find":
                m = bytes.fromhex(p["hex"])
                start, limit, hits = int(p.get("start") or 0), int(p.get("limit") or 4), []
                while len(hits) < limit:
                    i = data.find(m, start)
                    if i < 0:
                        break
                    hits.append(i)
                    start = i + 1
                out.append(_answer(op, offsets=hits))
            elif op == "read_text":
                off, ln = int(p["offset"]), int(p["length"])
                if off + ln > n:
                    out.append(_answer(op, ok=False, error="out_of_range"))
                    continue
                raw = data[off : off + ln].split(b"\x00", 1)[0]
                text = raw.decode("ascii", errors="replace")
                # Not printable ASCII: report its length only (the kernel checks the rest).
                out.append(_answer(op, value=text if re.fullmatch(r"[A-Za-z0-9 _.:/-]{0,32}", text) else f"<redacted:{len(raw)}>"))
            elif op in ("field_names", "section_sizes"):
                fp = fp or fingerprint(sample_id, data)
                if op == "field_names":
                    names = [f["name"] for f in fp["fields"]] + [c["name"] for c in (fp.get("table") or {}).get("columns", [])] + [a["name"] for a in fp["arrays"]]
                    out.append(_answer(op, names=names[:512]))
                else:
                    out.append(_answer(op, sections=fp["sections"][:64]))
            elif op == "size":
                out.append(_answer(op, value=n))
            else:
                out.append(_answer("size", ok=False, error="unsupported"))
        except (KeyError, ValueError, TypeError, struct.error):
            out.append(_answer(op if op in ("magic", "read_int", "read_float", "find", "read_text", "field_names", "section_sizes", "size") else "size", ok=False, error="unsupported"))
    return out
