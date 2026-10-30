"""JSON logs on stdout: one object per line with `service`, `version`, `request_id`, `trace_id`."""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

from . import context

_STANDARD = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str, version: str):
        super().__init__()
        self.service, self.version = service, version

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "service": self.service,
            "version": self.version,
        }
        rid, tid, sid = context.request_id(), context.trace_id(), context.span_id()
        if rid:
            out["request_id"] = rid
        if tid:
            out["trace_id"], out["span_id"] = tid, sid
        for k, v in record.__dict__.items():
            if k not in _STANDARD and not k.startswith("_") and k not in out:
                out[k] = v if isinstance(v, (str, int, float, bool, type(None), list, dict)) else str(v)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def setup_logging(service: str, version: str, level: str | int = "INFO", *, json_logs: bool = True) -> None:
    """Route the root logger (and uvicorn's) to stdout as JSON. Uvicorn's own access log is
    switched off: services log requests themselves, with ids and without probe noise."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service, version) if json_logs else logging.Formatter("%(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level if isinstance(level, int) else level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers[:] = []
    access.propagate = False
    access.disabled = True
