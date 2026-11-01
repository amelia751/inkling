"""Name screening (todo13 D3, D13): the name an agent sees for each file and folder.

A file dropped into chat is customer data, and so is its name: `Smith_John_1962-04-03.dcm`
must never reach the model or the agent's transcript (which live in another Google Cloud
project). Every node gets a screened name, stored on the node:

- `agent_name` is None until the node's current name was screened. Agents then see
  `file-<n><ext>` (fail closed). Renaming a node resets it (an ORM listener below).
- A clean name is its own `agent_name`; a flagged one becomes `<kind>-<nnnn><ext>`
  (`dicom-0001.dcm`, `image-0003.png`, `folder-0002`), numbered per project and kind.

Modes (`API_NAME_SCREEN_MODE`): `regex` (development and tests) uses the in-process path screen
(`privacy_names.path_findings`: dates, record numbers, emails, phone numbers, two capitalised
words); `dlp` (production) asks Sensitive Data Protection in the api's own project, batched
(`API_NAME_SCREEN_BATCH` names per call, `API_NAME_SCREEN_QPS` calls per second per pod), and
ORs the regex screen in. If the API errors, the whole batch is flagged (fail closed). `off`
(tests only) passes names through.

Screening runs on import completion (`imports.complete`), after namespace edits
(`routes/files.py`), and lazily before an agent response in `regex` mode. The backfill
(`backfill()`: `python -m studio_api.kernel.name_screen backfill [--project P]`, and the
worker's scheduled `files.screen_names`) screens whatever is still unscreened, in batches, so it
resumes wherever it stopped.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time

from sqlalchemy import event, func, or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import SourceNode
from . import tree
from .privacy_names import path_findings

log = logging.getLogger(__name__)

# Built-in Sensitive Data Protection info types (checked against the current list, 2026-11).
DLP_INFO_TYPES = ("PERSON_NAME", "FIRST_NAME", "LAST_NAME", "DATE_OF_BIRTH", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_SOCIAL_SECURITY_NUMBER")
MRN_PATTERN = r"(?<!\d)\d{7,10}(?!\d)"

KIND_BY_EXT = {
    "dicom": (".dcm", ".dicom", ".ima"),
    "image": (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".heic", ".svs", ".ndpi"),
    "volume": (".nii", ".nii.gz", ".nrrd", ".mha", ".mhd"),
    "video": (".mp4", ".mov", ".avi", ".mkv", ".webm"),
    "audio": (".mp3", ".wav", ".m4a", ".flac", ".ogg"),
    "table": (".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".json"),
    "document": (".pdf", ".docx", ".doc", ".txt", ".md", ".rtf"),
    "archive": (".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z"),
    "waveform": (".edf", ".hea", ".dat", ".xml"),
}
_EXT_KIND = {ext: kind for kind, exts in KIND_BY_EXT.items() for ext in exts}
SAFE_EXT = re.compile(r"^(\.[a-z0-9]{1,8}){1,2}$")


def safe_ext(name: str) -> str:
    ext = tree.extension(name)
    return ext if SAFE_EXT.fullmatch(ext or "") else ""


def kind_of(name: str, is_dir: bool, detected: str | None = None) -> str:
    if is_dir:
        return "folder"
    if detected and detected not in ("unknown", "folder"):
        return detected
    return _EXT_KIND.get(tree.extension(name), "file")


def unscreened_name(node_id: str, name: str, is_dir: bool) -> str:
    """What agents see before a name is screened: stable per node, says nothing about the name."""
    n = int(hashlib.sha256(node_id.encode()).hexdigest()[:8], 16) % 1_000_000
    return f"folder-{n}" if is_dir else f"file-{n}{safe_ext(name)}"


# ---- Screening -------------------------------------------------------------------------------


class _Pace:
    """Calls per second per process (the pod), shared by live screening and the backfill."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self, qps: float) -> None:
        if qps <= 0:
            return
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + 1.0 / qps
        if at > now:
            time.sleep(at - now)


_pace = _Pace()


def regex_flags(names: list[str]) -> list[bool]:
    return [bool(path_findings(n.replace("/", "_"))) for n in names]


def _dlp_flags(names: list[str]) -> list[bool]:
    """One Sensitive Data Protection `content.inspect` call for a batch of names, as a one-column
    table, so each finding's row index points at its name. Names only, never file contents."""
    import google.auth
    import google.auth.transport.requests
    import httpx

    s = settings()
    creds, cred_project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    project = s.name_screen_project or s.gcs_project or cred_project
    if not project:
        raise RuntimeError("no Google Cloud project for name screening")
    # `_` and `^` join name parts in file names (`Smith_John`, `DOE^JANE`): spaces let the
    # detectors see words. The row order is the names' order.
    rows = [{"values": [{"stringValue": re.sub(r"[_^]+", " ", n)}]} for n in names]
    body = {
        "item": {"table": {"headers": [{"name": "name"}], "rows": rows}},
        "inspectConfig": {
            "infoTypes": [{"name": t} for t in DLP_INFO_TYPES],
            "customInfoTypes": [{"infoType": {"name": "MRN_LIKE"}, "regex": {"pattern": MRN_PATTERN}, "likelihood": "LIKELY"}],
            "minLikelihood": "POSSIBLE",
            "includeQuote": False,
            "limits": {"maxFindingsPerRequest": 0},
        },
    }
    url = f"https://dlp.googleapis.com/v2/projects/{project}/locations/{s.name_screen_location}/content:inspect"
    r = httpx.post(url, json=body, headers={"Authorization": f"Bearer {creds.token}", "x-goog-user-project": project}, timeout=30.0)
    r.raise_for_status()
    flagged = [False] * len(names)
    for f in (r.json().get("result") or {}).get("findings") or []:
        for loc in (f.get("location") or {}).get("contentLocations") or []:
            row = ((loc.get("recordLocation") or {}).get("tableLocation") or {}).get("rowIndex")
            if row is not None and 0 <= int(row) < len(names):
                flagged[int(row)] = True
    return flagged


def screen(names: list[str]) -> list[bool]:
    """Whether each name may identify a person. Never raises: an error flags the batch."""
    mode = settings().screen_mode
    if mode == "off" or not names:
        return [False] * len(names)
    rx = regex_flags(names)
    if mode == "regex":
        return rx
    out: list[bool] = []
    batch = max(1, settings().name_screen_batch)
    for i in range(0, len(names), batch):
        part = names[i : i + batch]
        _pace.wait(settings().name_screen_qps)
        try:
            dlp = _dlp_flags(part)
        except Exception as e:  # noqa: BLE001 — fail closed: every name in the batch is flagged
            # The screening-errors metric (§7.3) counts these against `name_screen.batch` lines.
            log.warning("name_screen.error", extra={"event": "name_screen.error", "error": type(e).__name__, "names": len(part)})
            dlp = [True] * len(part)
        else:
            log.info("name_screen.batch", extra={"event": "name_screen.batch", "names": len(part), "flagged": sum(dlp)})
        out += [a or b for a, b in zip(dlp, rx[i : i + batch], strict=True)]
    return out


def _counters(db: Session, project_id: str) -> dict[str, int]:
    """Next number per kind for this project's flagged names (`dicom-0001.dcm` …)."""
    out: dict[str, int] = {}
    for (agent,) in db.execute(select(SourceNode.agent_name).where(SourceNode.project_id == project_id, SourceNode.name_flagged.is_(True))):
        m = re.match(r"^([a-z]+)-(\d+)", agent or "")
        if m:
            out[m.group(1)] = max(out.get(m.group(1), 0), int(m.group(2)))
    return out


def apply(db: Session, nodes: list[SourceNode]) -> int:
    """Screen these nodes' current names and store the result. Returns how many were flagged."""
    nodes = [n for n in nodes if n.parent_id is not None]  # the drive root is never shown by name
    if not nodes:
        return 0
    flags = screen([n.name for n in nodes])
    counters: dict[str, dict[str, int]] = {}
    flagged = 0
    for n, bad in zip(nodes, flags, strict=True):
        if bad:
            c = counters.setdefault(n.project_id, _counters(db, n.project_id))
            kind = kind_of(n.name, n.is_dir, n.detected_kind)
            c[kind] = c.get(kind, 0) + 1
            n.agent_name = f"{kind}-{c[kind]:04d}" + ("" if n.is_dir else safe_ext(n.name))
            flagged += 1
        else:
            n.agent_name = n.name
        n.name_flagged = bool(bad)
    db.flush()
    return flagged


def _pending(db: Session, project_id: str | None, limit: int) -> list[SourceNode]:
    q = select(SourceNode).where(SourceNode.agent_name.is_(None), SourceNode.parent_id.is_not(None))
    if project_id is not None:
        q = q.where(SourceNode.project_id == project_id)
    return list(db.scalars(q.order_by(SourceNode.id).limit(limit)))


def screen_pending(db: Session, project_id: str, *, max_calls: int | None = None) -> int:
    """Screen a project's unscreened nodes now: everything in `regex` mode (cheap, in process),
    at most `max_calls` calls (default one) in `dlp` mode; the backfill does the rest."""
    s = settings()
    regex = s.screen_mode != "dlp"
    calls = 0
    done = 0
    while True:
        rows = _pending(db, project_id, 5000 if regex else max(1, s.name_screen_batch))
        if not rows:
            return done
        apply(db, rows)
        done += len(rows)
        calls += 1
        if not regex and calls >= (max_calls or 1):
            return done


def backfill(db: Session, *, project_id: str | None = None, max_batches: int | None = None, budget_s: float | None = None) -> dict:
    """Screen unscreened nodes in batches (resumable: it always picks what is still unscreened),
    paced by `API_NAME_SCREEN_QPS`. Returns counts; commits after each batch."""
    s = settings()
    started = time.monotonic()
    batches = screened = flagged = 0
    while (max_batches is None or batches < max_batches) and (budget_s is None or time.monotonic() - started < budget_s):
        rows = _pending(db, project_id, max(1, s.name_screen_batch))
        if not rows:
            break
        flagged += apply(db, rows)
        screened += len(rows)
        batches += 1
        db.commit()
    remaining = db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.agent_name.is_(None), SourceNode.parent_id.is_not(None), *([SourceNode.project_id == project_id] if project_id else [])))
    out = {"batches": batches, "screened": screened, "flagged": flagged, "remaining": int(remaining or 0), "mode": s.screen_mode}
    log.info("name screening backfill", extra=out)
    return out


def agent_name(n: SourceNode) -> str:
    return n.agent_name if n.agent_name is not None else unscreened_name(n.id, n.name, n.is_dir)


def names_for_agent(db: Session, project_id: str) -> dict[str, str]:
    """Every name an agent must not see in this project → what it sees instead: flagged and
    unscreened nodes (and the stems of flagged file names)."""
    out: dict[str, str] = {}
    rows = db.execute(
        select(SourceNode.id, SourceNode.name, SourceNode.agent_name, SourceNode.is_dir).where(
            SourceNode.project_id == project_id, SourceNode.parent_id.is_not(None), or_(SourceNode.name_flagged.is_(True), SourceNode.agent_name.is_(None))
        )
    )
    for nid, name, agent, is_dir in rows:
        shown = agent if agent is not None else unscreened_name(nid, name, is_dir)
        if name and name != shown:
            out.setdefault(name, shown)
            if not is_dir and agent is not None:
                stem, ext = tree.split_ext(name)
                astem = shown[: len(shown) - len(safe_ext(name))] if safe_ext(name) and shown.endswith(safe_ext(name)) else shown
                if len(stem) >= 4 and stem != astem:
                    out.setdefault(stem, astem)
    return out


def _forget_on_rename(target: SourceNode, value, oldvalue, initiator) -> None:
    from sqlalchemy.orm.base import NO_VALUE

    if oldvalue is not NO_VALUE and oldvalue is not None and value != oldvalue:
        target.agent_name = None
        target.name_flagged = None


event.listen(SourceNode.name, "set", _forget_on_rename)


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    from ..db import session_scope

    ap = argparse.ArgumentParser(prog="python -m studio_api.kernel.name_screen", description="Screen file and folder names for agents (todo13 D13).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backfill", help="screen every unscreened node, resumably")
    b.add_argument("--project", default=None)
    b.add_argument("--max-batches", type=int, default=None)
    args = ap.parse_args(argv)
    with session_scope() as db:
        print(json.dumps(backfill(db, project_id=args.project, max_batches=args.max_batches)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
