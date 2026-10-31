"""Child-process harness for `verify_plugin` (todo10 §6.1 step 4). Run as a script, never imported.

    python -I verify_harness.py < {"source": dir, "sample": path, "entrypoint": "mod:fn", "out": path}

Loads the agent's converter from `source`, calls `fn(sample_path)` on the real sample (a
read-only file), and writes one JSON line describing the outputs: kinds, dtypes, shapes, value
ranges. Never the values, never an exception message. An audit hook (installed after the
scientific stack is imported) refuses sockets, subprocesses, ctypes loads and file writes; a
refused attempt fails the run even if the plugin swallowed the exception. In production the
worker pod adds gVisor, a deny-all NetworkPolicy and a read-only input mount on top.
"""

import json
import os
import sys
import time
import traceback

ALLOWED_CLASSES = {
    "ImportError", "ModuleNotFoundError", "SyntaxError", "IndentationError", "NameError", "AttributeError", "TypeError", "ValueError",
    "KeyError", "IndexError", "LookupError", "AssertionError", "ZeroDivisionError", "OverflowError", "ArithmeticError", "MemoryError",
    "RecursionError", "NotImplementedError", "RuntimeError", "OSError", "FileNotFoundError", "PermissionError", "EOFError", "UnicodeError",
    "UnicodeDecodeError", "BufferError", "StopIteration", "TimeoutError",
}


class Blocked(RuntimeError):
    def __init__(self, cls):
        super().__init__("blocked")
        self.cls = cls


def main():
    args = json.loads(sys.stdin.read())
    out_path, source = args["out"], os.path.realpath(args["source"])
    started = time.monotonic()
    result = {"stage": "load", "errorClass": None, "errorFile": None, "errorLine": None, "outputs": [], "pass": False}
    try:
        import numpy as np  # noqa: F401 — imported before the hook so its extensions load
    except ImportError:
        np = None  # noqa: F841
    for mod in ("struct", "zlib", "gzip", "io", "math", "json", "csv", "re", "pydicom", "nibabel", "PIL.Image"):
        try:
            __import__(mod)
        except ImportError:
            pass
    out_fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # opened before the hook
    violations = []
    NET = {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.sendto", "socket.__new__"}
    PROC = {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "pty.spawn", "os.startfile"}

    def hook(event, a):
        if event in NET:
            violations.append("NetworkBlocked")
            raise Blocked("NetworkBlocked")
        if event in PROC or event == "ctypes.dlopen":
            violations.append("ProcessBlocked")
            raise Blocked("ProcessBlocked")
        if event == "open" and len(a) >= 2:
            mode, flags = a[1], a[2] if len(a) > 2 else 0
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
            if writing:
                violations.append("WriteBlocked")
                raise Blocked("WriteBlocked")
        if event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "shutil.rmtree", "os.truncate"):
            violations.append("WriteBlocked")
            raise Blocked("WriteBlocked")

    sys.path.insert(0, source)
    sys.path.insert(0, os.path.join(source, "src"))
    sys.dont_write_bytecode = True
    devnull = open(os.devnull, "w")  # noqa: SIM115 — plugin prints go nowhere (before the hook: it's a write)
    sys.addaudithook(hook)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr = devnull
    try:
        mod_name, fn_name = args["entrypoint"].split(":", 1)
        try:
            import importlib

            mod = importlib.import_module(mod_name)
            fn = getattr(mod, fn_name)
        except AttributeError:
            raise LookupError("EntrypointMissing") from None
        result["stage"] = "convert"
        value = fn(args["sample"])
        result["stage"] = "check"
        result["outputs"] = describe(value)
        result["stage"] = "done"
        result["pass"] = bool(result["outputs"]) and not violations
        if not result["outputs"]:
            result["errorClass"] = "NoOutput"
    except BaseException as e:  # noqa: BLE001 — every failure becomes a class and a line
        result["errorClass"] = classify(e, args["entrypoint"])
        result["errorFile"], result["errorLine"] = where(e, source)
    if violations:
        result["pass"] = False
        result["errorClass"] = result["errorClass"] if result["errorClass"] in ("NetworkBlocked", "ProcessBlocked", "WriteBlocked") else violations[0]
    result["durationMs"] = int((time.monotonic() - started) * 1000)
    sys.stdout = real_stdout
    os.write(out_fd, json.dumps(result).encode())
    os.close(out_fd)


def classify(e, entrypoint):
    if isinstance(e, Blocked):
        return e.cls
    if isinstance(e, LookupError) and e.args == ("EntrypointMissing",):
        return "EntrypointMissing"
    if isinstance(e, MemoryError):
        return "MemoryError"
    name = type(e).__name__
    if name == "error" and type(e).__module__ == "struct":
        return "StructError"
    if name in ALLOWED_CLASSES:
        return name
    for base in type(e).__mro__[1:]:
        if base.__name__ in ALLOWED_CLASSES:
            return base.__name__
    return "Other"


def where(e, source):
    """The deepest frame in the agent's own source: (file relative to the source, line)."""
    found = (None, None)
    tb = e.__traceback__
    for frame, line in traceback.walk_tb(tb):
        f = os.path.realpath(frame.f_code.co_filename)
        if f.startswith(source + os.sep):
            found = (os.path.relpath(f, source).replace(os.sep, "/"), int(line))
    if isinstance(e, SyntaxError) and e.filename and os.path.realpath(e.filename).startswith(source + os.sep):
        found = (os.path.relpath(os.path.realpath(e.filename), source).replace(os.sep, "/"), int(e.lineno or 0))
    return found


DTYPES = {"bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float16", "float32", "float64", "complex64", "complex128"}


def _one(name, v):
    d = {"name": name, "kind": "unknown", "dtype": "unknown", "shape": [], "min": None, "max": None, "mean": None, "nanCount": 0}
    try:
        import numpy as np
    except ImportError:
        np = None
    if v is None:
        d["kind"] = "none"
    elif isinstance(v, bytes | bytearray | memoryview):
        d.update(kind="bytes", dtype="bytes", shape=[len(v)])
    elif isinstance(v, bool | int | float) and not isinstance(v, str):
        d.update(kind="scalar", dtype="bool" if isinstance(v, bool) else "int64" if isinstance(v, int) else "float64")
        f = float(v)
        if f == f and abs(f) != float("inf"):
            d.update(min=f, max=f, mean=f)
    elif isinstance(v, str):
        d.update(kind="scalar", dtype="string", shape=[len(v)])  # the length, never the text
    elif np is not None and (isinstance(v, np.ndarray) or hasattr(v, "__array__")):
        a = np.asarray(v)
        dt = str(a.dtype) if str(a.dtype) in DTYPES else ("string" if a.dtype.kind in "US" else "object" if a.dtype.kind == "O" else "unknown")
        d.update(kind="array", dtype=dt, shape=[int(s) for s in a.shape][:8])
        if a.size and a.dtype.kind in "biuf":
            af = a.astype("float64", copy=False)
            finite = np.isfinite(af)
            d["nanCount"] = int(np.isnan(af).sum())
            if finite.any():
                vals = af[finite]
                d.update(min=float(vals.min()), max=float(vals.max()), mean=float(vals.mean()))
    elif isinstance(v, dict):
        d.update(kind="mapping", shape=[len(v)])
    elif isinstance(v, list | tuple):
        d.update(kind="list", shape=[len(v)])
    return d


def describe(value):
    """Up to 32 outputs: a mapping's entries by key, a list's by index, or the value itself."""
    if isinstance(value, dict):
        return [_one(str(k)[:64] or "_", v) for k, v in list(value.items())[:32]]
    if isinstance(value, list | tuple) and value and not all(isinstance(x, int | float) for x in value):
        return [_one(f"item_{i}", v) for i, v in enumerate(value[:32])]
    return [_one("output", value)] if value is not None else []


if __name__ == "__main__":
    main()
