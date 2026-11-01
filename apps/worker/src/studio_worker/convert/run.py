"""convert(): validate, isolate, run, check, measure. See __init__.py."""

from __future__ import annotations


import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .contract import ConverterInvalid, accepts, load_manifest, validate_output

MEDIA = {".nii.gz": "application/x-nifti", ".nii": "application/x-nifti", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json", ".csv": "text/csv", ".arrow": "application/vnd.apache.arrow.file", ".zarr": "application/x-zarr", ".hea": "application/x-wfdb", ".dat": "application/x-wfdb"}


def _media(path: str) -> str:
    low = path.lower()
    return next((t for e, t in MEDIA.items() if low.endswith(e)), "application/octet-stream")


def _ext(name: str, m: dict) -> str:
    low = name.lower()
    return next((e for e in sorted(m["accepts"]["ext"], key=len, reverse=True) if low.endswith(e)), "")


def _limits(memory_mb: int, timeout_s: int):
    def apply() -> None:
        import resource

        os.setsid()
        for lim, value in ((resource.RLIMIT_CPU, timeout_s + 5), (resource.RLIMIT_AS, memory_mb * 1024 * 1024), (resource.RLIMIT_NPROC, 64)):
            try:
                resource.setrlimit(lim, (value, value))
            except (ValueError, OSError):  # macOS has no RLIMIT_AS; the pod's limits still apply
                pass

    return apply


def _run_python(m: dict, package: Path, src: Path, out: Path) -> tuple[str | None, int | None]:
    t = m["limits"]["timeoutS"]
    env = {"PATH": "/usr/bin:/bin", "HOME": str(out), "TMPDIR": str(out.parent / "tmp"), "PYTHONDONTWRITEBYTECODE": "1", "NO_PROXY": "*", "http_proxy": "http://0.0.0.0:9", "https_proxy": "http://0.0.0.0:9"}
    (out.parent / "tmp").mkdir(exist_ok=True)
    try:
        p = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "studio_worker.convert.child", m["runtime"]["entrypoint"], str(package), str(src), str(out)],
            env=env, cwd=out, capture_output=True, text=True, timeout=t, preexec_fn=_limits(m["limits"]["memoryMb"], t),
        )
    except subprocess.TimeoutExpired:
        return "timeout", None
    last = (p.stdout.strip().splitlines() or [""])[-1]
    try:
        r = json.loads(last)
    except json.JSONDecodeError:
        return ("memory" if p.returncode in (-9, 137) else "crash"), None
    if r.get("ok") and p.returncode == 0:
        return None, None
    err = r.get("error") if r.get("error") in ("unsupported-input", "timeout", "memory", "crash", "denied", "converter-invalid") else "crash"
    line = r.get("line") if isinstance(r.get("line"), int) and r["line"] > 0 else None
    return err, line


def _run_wasm(m: dict, package: Path, in_dir: Path, input_name: str, out: Path) -> tuple[str | None, int | None]:
    from . import wasm

    r = m["runtime"]
    if r["abi"] != "wasi-p1":
        return "converter-invalid", None
    module = (package / r["module"]).resolve()
    if not module.is_file() or not str(module).startswith(str(package.resolve())):
        return "converter-invalid", None
    try:
        code = wasm.run(module, in_dir, input_name, out, r["args"], timeout_s=m["limits"]["timeoutS"], memory_mb=m["limits"]["memoryMb"], fuel_millions=r["fuelMillions"])
    except wasm.WasmError as e:
        return e.kind, None
    # Exit codes by convention: 0 ok, 2 unsupported input, anything else a crash.
    return (None if code == 0 else "unsupported-input" if code == 2 else "crash"), None


def _inside(out: Path, rel: str) -> Path | None:
    p = out / rel
    if p.is_symlink():
        return None
    real = p.resolve()
    return real if str(real).startswith(str(out.resolve()) + os.sep) and real.exists() else None


def _measure(path: Path, rel: str) -> dict:
    data_files = [path] if path.is_file() else [f for f in path.rglob("*") if f.is_file()]
    h = hashlib.sha256()
    size = 0
    for f in sorted(data_files):
        b = f.read_bytes()
        h.update(b)
        size += len(b)
    out: dict = {"path": rel, "mediaType": _media(rel), "bytes": size, "sha256": h.hexdigest()}
    try:
        if rel.lower().endswith((".nii", ".nii.gz")):
            import nibabel as nib
            import numpy as np

            img = nib.load(str(path))
            arr = np.asanyarray(img.dataobj)
            out["dims"] = [int(x) for x in img.shape]
            out["dtype"] = str(arr.dtype) if str(arr.dtype) in ("uint8", "int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64") else None
            out["range"] = [float(arr.min()), float(arr.max())] if arr.size else None
        elif rel.lower().endswith(".png"):
            from PIL import Image

            with Image.open(path) as im:
                out["dims"] = [im.height, im.width] + ([len(im.getbands())] if len(im.getbands()) > 1 else [])
    except Exception:  # noqa: BLE001 — a file we can't read back is reported without dims
        pass
    return {k: v for k, v in out.items() if v is not None}


def _check_files(m: dict, out: Path) -> tuple[str | None, list[dict], str | None]:
    try:
        doc = json.loads((out / "output.json").read_text())
        v = validate_output(doc, m["produces"])
    except (OSError, ValueError, json.JSONDecodeError):
        return "invalid-output", [], None
    files, total = [], 0
    for rel in v["paths"]:
        p = _inside(out, rel)
        if p is None:
            return "invalid-output", [], None
        if m["produces"] == "zarr" and not (p / "zarr.json").is_file():
            return "invalid-output", [], None
        if m["produces"] == "arrow" and not p.read_bytes()[:6] == b"ARROW1":
            return "invalid-output", [], None
        f = _measure(p, rel)
        total += f["bytes"]
        files.append(f)
    if total > m["limits"]["maxOutputMb"] * 1024 * 1024:
        return "output-too-large", [], None
    data_kind = doc.get("dataKind") if isinstance(doc.get("dataKind"), str) else m["output"].get("dataKind")
    return None, files, data_kind


def convert(package: Path, src: Path, out: Path) -> dict:
    """Run the converter in `package` on `src`, writing into `out` (created, must be empty). Returns a ConversionSummary dict."""
    t0 = time.monotonic()
    package = Path(package).resolve()
    try:
        m = load_manifest(package)
    except ConverterInvalid:
        return {"ok": False, "converter": {"id": "unknown.converter", "version": "0.0.0", "runtime": "python"}, "error": "converter-invalid", "files": [], "durationMs": 0}
    who = {"id": m["id"], "version": m["version"], "runtime": m["runtime"]["kind"]}

    def done(error: str | None, files: list | None = None, line: int | None = None, data_kind: str | None = None) -> dict:
        s = {"ok": error is None, "converter": who, "files": files or [], "durationMs": int((time.monotonic() - t0) * 1000)}
        if error is None:
            s["shape"] = m["produces"]
            if data_kind:
                s["dataKind"] = data_kind
        else:
            s["error"] = error
            if line:
                s["line"] = line
        return s

    src = Path(src)
    with open(src, "rb") as f:
        head = f.read(65536 + 64)
    if not accepts(m, src.name, head):
        return done("unsupported-input")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError("output folder must be empty")
    work = Path(tempfile.mkdtemp(prefix="convert-"))
    try:
        in_dir = work / "in"
        in_dir.mkdir()
        name = f"input{_ext(src.name, m)}"
        # Mixed .mhd + .raw style inputs come later; one file in, renamed so its name can't leak.
        shutil.copyfile(src, in_dir / name)
        os.chmod(in_dir / name, stat.S_IRUSR | stat.S_IRGRP)
        os.chmod(in_dir, stat.S_IRUSR | stat.S_IXUSR)
        if m["runtime"]["kind"] == "python":
            err, line = _run_python(m, package, in_dir / name, out)
        else:
            err, line = _run_wasm(m, package, in_dir, name, out)
        if err:
            return done(err, line=line)
        err, files, data_kind = _check_files(m, out)
        return done(err, files, data_kind=data_kind)
    finally:
        os.chmod(work / "in", stat.S_IRWXU) if (work / "in").exists() else None
        shutil.rmtree(work, ignore_errors=True)


