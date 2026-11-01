"""What an agent principal reads of file and folder names (todo13 D13): one serializer.

Every JSON response to an agent session (`agent:*` principal, only the routes in
`agent_scope.AGENT_ROUTES` reach it) goes through `scrub` (the app's `agent_names` middleware):

1. every name of this project's nodes that is flagged or not yet screened is replaced, wherever
   it appears in a string (a `name`, a `pathText`, `a.png–z.png` sequence rows, "Same file as
   …" reasons, proposal summaries), by the node's screened name (`kernel/name_screen.py`); the
   stem of a flagged file name too (`Smith_John` → `dicom-0001`);
2. on the file routes, a regex safety net: any path segment of a name-like field that the path
   screen still flags (an old name kept in a flag, a title typed by a person) becomes
   `redacted-<hash>`.

Person responses are never touched. In `regex` mode (development, tests) unscreened nodes are
screened on the spot, so agents see real (clean) names there at once.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from . import name_screen
from .privacy_names import path_findings

# Keys whose string values are file or folder names or paths on the file routes.
NAME_KEYS = frozenset({"name", "pathText", "displayPath", "folderPath", "relPath", "originalPath", "sourceTitle", "parentName", "title", "landingName", "agentName"})

P = "/api/v1"
# Agent routes that return names from the project's drive (the regex net runs on these).
FILE_ROUTES = frozenset(
    {
        f"{P}/assets",
        f"{P}/projects/{{project_id}}/overview",
        f"{P}/projects/{{project_id}}/sources",
        f"{P}/projects/{{project_id}}/proposals",
        f"{P}/projects/{{project_id}}/review",
        f"{P}/projects/{{project_id}}/search",
        f"{P}/projects/{{project_id}}/fs",
        f"{P}/projects/{{project_id}}/fs/children",
        f"{P}/projects/{{project_id}}/imports",
        f"{P}/sources/{{source_id}}/children",
        f"{P}/source-nodes/{{node_id}}",
        f"{P}/source-nodes/{{node_id}}/activity",
        f"{P}/proposals/{{proposal_id}}",
        f"{P}/drops/{{drop_id}}",
    }
)

_EDGE_L = r"(?<![A-Za-z0-9_\-.])"
_EDGE_R = r"(?![A-Za-z0-9_\-])"


class Scrubber:
    def __init__(self, names: dict[str, str], *, net: bool):
        self.names = names
        self.net = net
        self.rx = re.compile(_EDGE_L + "(" + "|".join(re.escape(k) for k in sorted(names, key=len, reverse=True)) + ")" + _EDGE_R) if names else None

    def text(self, s: str, key: str | None = None) -> str:
        if self.rx is not None:
            s = self.rx.sub(lambda m: self.names[m.group(1)], s)
        if self.net and key in NAME_KEYS and s:
            s = "/".join(_net(part) for part in s.split("/"))
        return s

    def walk(self, v: Any, key: str | None = None) -> Any:
        if isinstance(v, str):
            return self.text(v, key)
        if isinstance(v, list):
            return [self.walk(x, key) for x in v]
        if isinstance(v, dict):
            return {(self.text(k) if isinstance(k, str) else k): self.walk(x, k) for k, x in v.items()}
        return v


def _net(segment: str) -> str:
    seg = segment.strip()
    if not seg or not path_findings(seg):
        return segment
    return "redacted-" + hashlib.sha256(seg.encode()).hexdigest()[:8] + name_screen.safe_ext(seg)


def scrubber(db: Session, project_id: str, *, file_route: bool) -> Scrubber:
    if settings().screen_mode != "dlp":
        if name_screen.screen_pending(db, project_id):
            db.commit()
    return Scrubber(name_screen.names_for_agent(db, project_id), net=file_route)


def scrub(db: Session, project_id: str, payload: Any, *, file_route: bool) -> Any:
    return scrubber(db, project_id, file_route=file_route).walk(payload)


def scrub_json_bytes(db: Session, project_id: str, body: bytes, *, route_path: str | None) -> bytes:
    payload = json.loads(body)
    return json.dumps(scrub(db, project_id, payload, file_route=route_path in FILE_ROUTES), separators=(",", ":")).encode()
