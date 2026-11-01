"""Runs one Python converter in its own process: `python -I -m studio_worker.convert.child
<entrypoint> <package> <input> <out>`. Prints one JSON line for the parent: {"ok": true} or
{"ok": false, "error": <class>, "line": <line in the converter's source>}; never the exception text.

The audit hook is defence in depth (the pod's NetworkPolicy and gVisor are the boundary): no
sockets, no subprocesses, no writes outside the output folder and the temp folder."""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path


class Denied(PermissionError):
    pass


def _guard(out: Path, package: Path) -> None:
    allowed = (str(out.resolve()), str(Path(tempfile.gettempdir()).resolve()), "/dev/null")
    denied = ("socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "pty.", "ctypes.dlopen", "webbrowser.")

    def hook(event: str, args: tuple) -> None:
        if event.startswith(denied) and event not in ("socket.getaddrinfo",):
            raise Denied(event)
        if event == "socket.getaddrinfo":
            raise Denied(event)
        if event == "open" and len(args) >= 2:
            path, mode = args[0], args[1]
            flags = args[2] if len(args) > 2 else 0
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
            if writing and isinstance(path, (str, bytes, os.PathLike)):
                p = os.path.realpath(os.fsdecode(path))
                if not p.startswith(allowed):
                    raise Denied("open-write")
        if event in ("os.remove", "os.rename", "os.rmdir", "os.chmod", "os.symlink", "os.link") and args:
            p = os.path.realpath(os.fsdecode(args[0]))
            if not p.startswith(allowed[:2]):
                raise Denied(event)

    sys.addaudithook(hook)


def _line(tb, package: Path) -> int | None:
    root = str(package.resolve())
    line = None
    for frame in traceback.extract_tb(tb):
        if os.path.realpath(frame.filename).startswith(root):
            line = frame.lineno
    return line


def main() -> int:
    entrypoint, package, src, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    sys.path.insert(0, str(package.resolve()))
    module, func = entrypoint.split(":")
    try:
        fn = getattr(importlib.import_module(module), func)
    except Exception as e:  # noqa: BLE001 — reported as a class only
        print(json.dumps({"ok": False, "error": "converter-invalid", "line": _line(e.__traceback__, package)}), flush=True)
        return 3
    _guard(out, package)
    try:
        result = fn(src, out, {})
        if isinstance(result, dict):
            with open(out / "output.json", "w") as f:
                json.dump(result, f)
    except Denied as e:
        print(json.dumps({"ok": False, "error": "denied", "line": _line(e.__traceback__, package)}), flush=True)
        return 4
    except MemoryError as e:
        print(json.dumps({"ok": False, "error": "memory", "line": _line(e.__traceback__, package)}), flush=True)
        return 5
    except (ValueError, KeyError, IndexError, UnicodeDecodeError, EOFError) as e:
        print(json.dumps({"ok": False, "error": "unsupported-input", "line": _line(e.__traceback__, package)}), flush=True)
        return 6
    except BaseException as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "crash", "line": _line(e.__traceback__, package)}), flush=True)
        return 7
    print(json.dumps({"ok": True}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
