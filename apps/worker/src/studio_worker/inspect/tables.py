"""Table profiling (todo6 Phase 5.1): encoding and delimiter sniffing, header detection, a type
and fill profile per column, candidate keys, and columns whose values look like the import's
folder or file names. The kernel builds relationship and label proposals from this profile
(apps/api kernel/explore.py), reading the CSV itself, so XLSX sheets are converted to CSV here
and stored next to the original as a derived file.
"""

from __future__ import annotations

import csv
import io
import posixpath
import re

from . import privacy

MAX_ROWS = 200_000
EXT = re.compile(r"\.[A-Za-z0-9]{1,5}(\.gz)?$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}/\d{1,2}/\d{2,4}$")


def decode(data: bytes) -> tuple[str, str]:
    for enc in ("utf-8-sig", "utf-16") if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc), "UTF-8" if enc == "utf-8-sig" else enc.upper()
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace"), "LATIN-1"


def sniff(text: str, name: str) -> csv.Dialect | type[csv.Dialect]:
    sample = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        return csv.excel_tab if name.lower().endswith(".tsv") else csv.excel


def _is_num(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def column_type(values: list[str]) -> str:
    """number, integer, date, category, id or text (`empty` without values)."""
    if not values:
        return "empty"
    if all(_is_num(v) for v in values):
        return "integer" if all(re.fullmatch(r"-?\d+", v) for v in values) else "number"
    if all(DATE.match(v) for v in values):
        return "date"
    distinct = len(set(values))
    if distinct <= max(2, len(values) // 5) and distinct <= 50:
        return "category"
    if distinct == len(values) and all(len(v) <= 64 and " " not in v.strip() for v in values):
        return "id"
    return "text"


def has_header(rows: list[list[str]]) -> bool:
    """The first row names the columns: no numbers where the rest has numbers, all distinct."""
    if len(rows) < 2:
        return bool(rows) and not any(_is_num(c) for c in rows[0])
    first, rest = rows[0], rows[1:50]
    if len(set(first)) != len(first) or any(not c.strip() for c in first):
        return False
    for i, c in enumerate(first):
        col = [r[i] for r in rest if i < len(r) and r[i].strip()]
        if col and all(_is_num(v) for v in col) and not _is_num(c):
            return True
    try:
        return csv.Sniffer().has_header("\n".join(",".join(r) for r in rows[:30]))
    except csv.Error:
        return not any(_is_num(c) for c in first)


def _norm_name(v: str) -> str:
    v = v.strip().replace("\\", "/").rsplit("/", 1)[-1]
    return EXT.sub("", v).lower()


def profile(text: str, name: str, paths: list[str]) -> tuple[dict, list[str]]:
    """(the `facts.table` profile, privacy findings)."""
    dialect = sniff(text, name)
    rows = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)][: MAX_ROWS + 1]
    if not rows:
        return {"rowCount": 0, "columns": [], "header": False, "candidateKeys": []}, []
    header = has_header(rows)
    width = max(len(r) for r in rows[:1000])
    names = [c.strip() or f"Column {i + 1}" for i, c in enumerate(rows[0])] if header else [f"Column {i + 1}" for i in range(width)]
    names += [f"Column {i + 1}" for i in range(len(names), width)]
    body = rows[1:] if header else rows
    # Every folder and file name in the import (normalized), to spot name-like columns.
    known = set()
    for p in paths:
        for part in p.split("/"):
            known.add(_norm_name(part))
    columns = []
    keys = []
    for i, col in enumerate(names):
        vals = [r[i].strip() for r in body if i < len(r)]
        filled = [v for v in vals if v]
        t = column_type(filled)
        distinct = len(set(filled))
        name_like = sum(_norm_name(v) in known for v in filled[:5000])
        c = {
            "name": col,
            "type": t,
            "filled": len(filled),
            "total": len(vals),
            "distinct": distinct,
            "examples": list(dict.fromkeys(filled))[:3],
            "matchesNames": name_like,
        }
        if t == "category":
            counts: dict[str, int] = {}
            for v in filled:
                counts[v] = counts.get(v, 0) + 1
            c["values"] = [{"value": k, "count": n} for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
        columns.append(c)
        if filled and distinct == len(filled) and len(filled) >= 0.95 * max(1, len(vals)):
            keys.append(col)
    out = {
        "delimiter": {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}.get(getattr(dialect, "delimiter", ","), "comma"),
        "header": header,
        "rowCount": len(body),
        "columnCount": width,
        "columns": columns,
        "candidateKeys": keys,
        "nameColumns": [c["name"] for c in columns if c["matchesNames"] and c["matchesNames"] >= max(1, c["filled"] // 5)],
        "truncated": len(rows) > MAX_ROWS,
    }
    return out, privacy.table_findings(names, body[:500])


def xlsx_to_csv(data: bytes) -> tuple[str, dict]:
    """The first sheet as CSV text, plus facts about the workbook (sheet names, which sheet)."""
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheets = wb.sheetnames
        ws = wb[sheets[0]]
        buf = io.StringIO()
        w = csv.writer(buf)
        for n, row in enumerate(ws.iter_rows(values_only=True)):
            if n > MAX_ROWS:
                break
            w.writerow(["" if v is None else str(v) for v in row])
        return buf.getvalue(), {"sheets": sheets[:20], "sheet": sheets[0]}
    finally:
        wb.close()


def stem(name: str) -> str:
    return posixpath.splitext(name)[0]
