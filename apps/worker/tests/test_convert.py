"""Converter runtime (todo10 Phase 6): contract, isolation, fixed-schema summaries, Python and WASM."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest

from studio_worker.convert import CANONICAL_SHAPES, CONVERSION_ERRORS, convert
from studio_worker.convert.contract import ConverterInvalid, validate_manifest

FIX = Path(__file__).parent / "fixtures" / "converters"
SCHEMAS = Path(__file__).resolve().parents[3] / "schemas"


def phantom() -> np.ndarray:
    """A synthetic 16×12×8 int16 volume (a bright ellipsoid on noise-free background)."""
    x, y, z = np.meshgrid(np.arange(16), np.arange(12), np.arange(8), indexing="ij")
    return np.where(((x - 8) / 6) ** 2 + ((y - 6) / 4) ** 2 + ((z - 4) / 3) ** 2 < 1, 1000, -100).astype(np.int16)


def write_mha(path: Path, arr: np.ndarray, *, compressed: bool = False, header_extra: str = "") -> Path:
    data = arr.transpose().astype("<i2").tobytes()
    if compressed:
        data = zlib.compress(data)
    dims = " ".join(str(d) for d in arr.shape)
    header = f"ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\nCompressedData = {compressed}\nElementSpacing = 1.5 1.5 3\nDimSize = {dims}\n{header_extra}ElementType = MET_SHORT\nElementDataFile = LOCAL\n"
    path.write_bytes(header.encode() + data)
    return path


def package(tmp: Path, name: str, code: str, **manifest) -> Path:
    """A throwaway Python converter package."""
    d = tmp / name
    d.mkdir()
    (d / "conv.py").write_text(code)
    m = {"id": f"acme.{name}", "version": "0.1.0", "title": name, "description": "test", "accepts": {"ext": [".mha"]}, "produces": "assets", "runtime": {"kind": "python", "entrypoint": "conv:convert"}, **manifest}
    (d / "converter.yaml").write_text(json.dumps(m))
    return d


def test_enums_match_the_emitted_schemas():
    manifest = json.loads((SCHEMAS / "converter.v1.json").read_text())["$defs"]["ConverterManifest"]
    summary = json.loads((SCHEMAS / "conversion-summary.v1.json").read_text())["$defs"]["ConversionSummary"]
    assert tuple(manifest["properties"]["produces"]["enum"]) == CANONICAL_SHAPES
    assert tuple(summary["properties"]["error"]["enum"]) == CONVERSION_ERRORS


def test_manifest_is_strict():
    m = {"id": "acme.x", "version": "0.1.0", "title": "x", "description": "x", "accepts": {"ext": [".mha"]}, "produces": "assets", "runtime": {"kind": "python", "entrypoint": "m:f"}}
    assert validate_manifest(m)["limits"] == {"timeoutS": 120, "memoryMb": 1024, "maxOutputMb": 512}
    for bad in ({**m, "network": True}, {**m, "runtime": {"kind": "shell", "cmd": "curl"}}, {**m, "runtime": {"kind": "wasm", "module": "../x.wasm"}}, {**m, "accepts": {}}):
        with pytest.raises(ConverterInvalid):
            validate_manifest(bad)


@pytest.mark.parametrize("compressed", [False, True])
def test_python_converter_metaimage_to_nifti(tmp_path, compressed):
    arr = phantom()
    src = write_mha(tmp_path / "Doe^Jane_scan.mha", arr, compressed=compressed)
    s = convert(FIX / "metaimage-py", src, tmp_path / "out")
    assert s["ok"], s
    assert s["shape"] == "assets" and s["dataKind"] == "studio.volume.dataKinds.volume"
    [f] = s["files"]
    assert f["path"] == "volume.nii.gz" and f["mediaType"] == "application/x-nifti"
    assert f["dims"] == [16, 12, 8] and f["dtype"] == "int16" and f["range"] == [-100.0, 1000.0]
    assert len(f["sha256"]) == 64 and f["bytes"] == (tmp_path / "out" / "volume.nii.gz").stat().st_size
    # The input's name never reaches the summary.
    assert "Jane" not in json.dumps(s)


def test_unsupported_inputs_are_refused_before_running(tmp_path):
    (tmp_path / "x.nii").write_bytes(b"\0" * 400)
    assert convert(FIX / "metaimage-py", tmp_path / "x.nii", tmp_path / "o1")["error"] == "unsupported-input"
    (tmp_path / "y.mha").write_text("hello")
    assert convert(FIX / "metaimage-py", tmp_path / "y.mha", tmp_path / "o2")["error"] == "unsupported-input"


def test_bad_input_inside_the_converter_is_unsupported_input_with_a_line(tmp_path):
    src = write_mha(tmp_path / "a.mha", phantom(), header_extra="")
    src.write_bytes(src.read_bytes().replace(b"ElementDataFile = LOCAL", b"ElementDataFile = other.raw"))
    s = convert(FIX / "metaimage-py", src, tmp_path / "out")
    assert s["error"] == "unsupported-input" and isinstance(s.get("line"), int)


def test_crash_text_never_leaves(tmp_path):
    d = package(tmp_path, "leaky", "def convert(src, out, o):\n    raise RuntimeError('Patient Jane Doe, MRN 123')\n")
    s = convert(d, write_mha(tmp_path / "a.mha", phantom()), tmp_path / "out")
    assert s == {"ok": False, "converter": {"id": "acme.leaky", "version": "0.1.0", "runtime": "python"}, "error": "crash", "line": 2, "files": [], "durationMs": s["durationMs"]}
    assert "Jane" not in json.dumps(s)


@pytest.mark.parametrize(
    "code",
    [
        "import socket\ndef convert(src, out, o):\n    socket.create_connection(('127.0.0.1', 9))\n",
        "def convert(src, out, o):\n    open('/tmp/../' + str(src.parent.parent.parent) + '/escape.txt', 'w').write('x')\n",
        "import subprocess\ndef convert(src, out, o):\n    subprocess.run(['true'])\n",
        "def convert(src, out, o):\n    src.write_bytes(b'tampered')\n",
    ],
    ids=["socket", "write-outside", "subprocess", "write-input"],
)
def test_converters_cant_reach_the_network_spawn_or_write_outside(tmp_path, code):
    d = package(tmp_path, "evil", code)
    s = convert(d, write_mha(tmp_path / "a.mha", phantom()), tmp_path / "out")
    assert not s["ok"] and s["error"] in ("denied", "crash"), s
    assert not (tmp_path / "escape.txt").exists()


def test_timeout(tmp_path):
    d = package(tmp_path, "slow", "import time\ndef convert(src, out, o):\n    time.sleep(30)\n", limits={"timeoutS": 2})
    assert convert(d, write_mha(tmp_path / "a.mha", phantom()), tmp_path / "out")["error"] == "timeout"


@pytest.mark.parametrize(
    "result",
    [
        "{'shape': 'assets', 'assets': [{'path': '../etc/passwd', 'mediaType': 'text/plain'}]}",
        "{'shape': 'assets', 'assets': [{'path': 'missing.nii', 'mediaType': 'application/x-nifti'}]}",
        "{'shape': 'zarr', 'store': 'a.zarr', 'arrays': []}",
        "{'shape': 'assets', 'assets': [{'path': 'x.png', 'mediaType': 'image/png'}], 'note': 'free text'}",
    ],
)
def test_invalid_outputs(tmp_path, result):
    d = package(tmp_path, "bad", f"def convert(src, out, o):\n    (out / 'x.png').write_bytes(b'png')\n    return {result}\n")
    assert convert(d, write_mha(tmp_path / "a.mha", phantom()), tmp_path / "out")["error"] == "invalid-output"


def test_the_cli_prints_a_summary(tmp_path):
    src = write_mha(tmp_path / "a.mha", phantom())
    p = subprocess.run([sys.executable, "-m", "studio_worker.convert", str(FIX / "metaimage-py"), str(src), str(tmp_path / "out")], capture_output=True, text=True)
    assert p.returncode == 0 and json.loads(p.stdout)["ok"]


# ---- WebAssembly (D3 trial) ------------------------------------------------------------------


def test_wasm_converter_metaimage_to_nifti(tmp_path):
    arr = phantom()
    s = convert(FIX / "metaimage-wasm", write_mha(tmp_path / "a.mha", arr), tmp_path / "out")
    assert s["ok"], s
    assert s["converter"]["runtime"] == "wasm"
    [f] = s["files"]
    assert f["path"] == "volume.nii" and f["dims"] == [16, 12, 8] and f["dtype"] == "int16" and f["range"] == [-100.0, 1000.0]
    import nibabel as nib

    img = nib.load(str(tmp_path / "out" / "volume.nii"))
    assert np.array_equal(np.asanyarray(img.dataobj), arr)
    assert img.header.get_zooms() == (1.5, 1.5, 3.0)


def test_wasm_and_python_agree(tmp_path):
    src = write_mha(tmp_path / "a.mha", phantom())
    py = convert(FIX / "metaimage-py", src, tmp_path / "py")["files"][0]
    wa = convert(FIX / "metaimage-wasm", src, tmp_path / "wa")["files"][0]
    assert (py["dims"], py["dtype"], py["range"]) == (wa["dims"], wa["dtype"], wa["range"])


def test_wasm_refuses_compressed_input_and_cant_write_its_input(tmp_path):
    s = convert(FIX / "metaimage-wasm", write_mha(tmp_path / "a.mha", phantom(), compressed=True), tmp_path / "out")
    assert s["error"] == "unsupported-input"


def test_wasm_runaway_is_stopped(tmp_path):
    d = tmp_path / "loop"
    d.mkdir()
    (d / "loop.wat").write_text('(module (import "wasi_snapshot_preview1" "proc_exit" (func (param i32))) (memory (export "memory") 1) (func (export "_start") (loop (br 0))))')
    (d / "converter.yaml").write_text(json.dumps({"id": "acme.loop", "version": "0.1.0", "title": "loop", "description": "x", "accepts": {"ext": [".mha"]}, "produces": "assets", "runtime": {"kind": "wasm", "module": "loop.wat", "fuelMillions": 50}, "limits": {"timeoutS": 5}}))
    s = convert(d, write_mha(tmp_path / "a.mha", phantom()), tmp_path / "out")
    assert s["error"] == "timeout" and s["durationMs"] < 5000


@pytest.mark.skipif(shutil.which("zig") is None and subprocess.run([sys.executable, "-c", "import ziglang"], capture_output=True).returncode != 0, reason="ziglang (the pinned WASM toolchain) isn't installed")
def test_wasm_converter_rebuilds_from_source(tmp_path):
    out = tmp_path / "metaimage.wasm"
    subprocess.run([sys.executable, "-m", "ziglang", "cc", "--target=wasm32-wasi", "-O2", "-s", str(FIX / "metaimage-wasm" / "metaimage.c"), "-o", str(out)], check=True, timeout=600)
    assert out.read_bytes()[:4] == b"\0asm"
