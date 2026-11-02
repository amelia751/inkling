"""todo18 D4/D5: derivatives (ffmpeg, OpenSlide faked) and sidecar pairing."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from studio_worker import derive
from studio_worker.config import DeriveLimits, load_settings
from studio_worker.inspect import sidecars


def _which(name):
    return f"/bin/{name}"


def _fake_run(codec="mjpeg", ok=True, duration=10.0):
    def run(cmd, **_kw):
        if "ffprobe" in cmd[0]:
            return SimpleNamespace(returncode=0, stdout=json.dumps({"streams": [{"codec_type": "video", "codec_name": codec, "duration": str(duration)}]}), stderr="")
        out = Path(cmd[-1])
        if ok:
            out.write_bytes(b"mp4")
            return SimpleNamespace(returncode=0, stdout="out_time_us=5000000\nprogress=continue\n", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="Decoder (codec cinepak) not found\n")
    return run


def test_derivative_kind():
    assert derive.derivative_kind("a/b.AVI") == "video-mp4"
    assert derive.derivative_kind("clip.mov") == "video-mp4"
    assert derive.derivative_kind("clip.mp4") is None
    assert derive.derivative_kind("s.svs") == "slide-dzi"
    assert derive.derivative_kind("photo.tif") is None
    assert derive.derivative_kind("pyr.tif", tiled=True) == "slide-dzi"


def test_transcode_writes_h264_mp4_keyed_by_hash(tmp_path):
    src = tmp_path / "in.avi"
    src.write_bytes(b"x" * 10)
    seen: list[int] = []
    d = derive.transcode_video(src, tmp_path / "out", "abc", progress=seen.append, run=_fake_run(), which=_which)
    assert d.key == "derived/abc.mp4" and d.files[d.key].read_bytes() == b"mp4"
    assert d.meta["sourceCodec"] == "mjpeg" and d.meta["codec"] == "h264"
    assert seen[0] == 0 and 50 in seen and seen[-1] == 100


def test_transcode_failure_names_the_codec(tmp_path):
    src = tmp_path / "in.avi"
    src.write_bytes(b"x")
    with pytest.raises(derive.DeriveError, match="can't decode cinepak video"):
        derive.transcode_video(src, tmp_path, "abc", run=_fake_run(codec="cinepak", ok=False), which=_which)


def test_transcode_without_ffmpeg_and_over_the_limit(tmp_path):
    src = tmp_path / "in.avi"
    src.write_bytes(b"x" * 100)
    with pytest.raises(derive.DeriveError, match="ffmpeg isn't installed"):
        derive.transcode_video(src, tmp_path, "abc", which=lambda _n: None)
    with pytest.raises(derive.DeriveError, match="too large"):
        derive.transcode_video(src, tmp_path, "abc", limits=DeriveLimits(transcode_max_bytes=10), run=_fake_run(), which=_which)


def test_retry_until_max_attempts():
    err = derive.DeriveError("timed out", retry=True)
    assert derive.should_retry(2, DeriveLimits(max_attempts=3), err)
    assert not derive.should_retry(3, DeriveLimits(max_attempts=3), err)
    assert not derive.should_retry(1, DeriveLimits(), derive.DeriveError("bad codec"))


def test_settings_read_derive_keys(monkeypatch):
    s = load_settings(require_token=False)
    assert s.derive.max_attempts == 3 and s.derive.transcode_max_bytes == 10 * 1024**3


def test_tile_slide_without_openslide_fails_clearly(tmp_path, monkeypatch):
    monkeypatch.setattr(derive, "_load_openslide", lambda: (_ for _ in ()).throw(derive.DeriveError("Slide tiling isn't available: OpenSlide isn't installed on the worker")))
    with pytest.raises(derive.DeriveError, match="OpenSlide isn't installed"):
        derive.tile_slide(tmp_path / "s.svs", tmp_path, "abc")


def test_tile_slide_with_fake_openslide(tmp_path):
    from PIL import Image

    class Slide:
        dimensions = (500, 300)
        properties = {"openslide.mpp-x": "0.25", "openslide.mpp-y": "0.26"}

        def get_thumbnail(self, size):
            return Image.new("RGB", (64, 32))

        def close(self):
            pass

    class DZ:
        level_count = 2
        level_tiles = ((1, 1), (2, 2))

        def __init__(self, *_a, **_kw):
            pass

        def get_tile(self, level, addr):
            return Image.new("RGB", (8, 8))

        def get_dzi(self, fmt):
            return f'<Image Format="{fmt}"/>'

    fake = SimpleNamespace(OpenSlide=lambda _p: Slide(), DeepZoomGenerator=DZ)
    seen: list[int] = []
    d = derive.tile_slide(tmp_path / "s.svs", tmp_path / "out", "abc", progress=seen.append, openslide=fake)
    assert d.key == "derived/abc.dzi" and "derived/abc_files/1/1_1.jpeg" in d.files and "derived/abc_thumb.png" in d.files
    assert d.meta["mpp"] == 0.25 and d.meta["mppY"] == 0.26
    assert seen[-1] == 100


def test_pairs_and_lone_halves():
    pairs, flags = sidecars.pair_files(["r/100.hea", "r/100.dat", "a/x.hdr", "a/x.img", "b/y.hdr", "c/z.dat", "d/w.mat", "d/w.hea"])
    assert {p["primary"] for p in pairs} == {"r/100.hea", "a/x.hdr", "d/w.hea"}
    assert flags["b/y.hdr"]["message"] == "Needs its pair: y.img"
    assert flags["c/z.dat"]["message"] == "Needs its pair: z.hea"
    assert set(flags) == {"b/y.hdr", "c/z.dat"}


def test_acdc_info_and_seg_roles():
    assert sidecars.parse_acdc_info("ED: 1\nES: 12\nGroup: DCM\nHeight: 184.0\nNbFrame: 30\nWeight: 95.0\n") == {"ed": 1, "es": 12, "group": "DCM", "height": 184.0, "frames": 30, "weight": 95.0}
    assert sidecars.segmentation_role("BraTS_001_seg.nii.gz") == {"role": "reference", "sequence": "seg"}
    assert sidecars.segmentation_role("patient001_frame01_gt.nii.gz") == {"role": "reference"}
    assert sidecars.segmentation_role("BraTS_001_t1.nii.gz") is None


def test_real_ffmpeg_transcode_when_installed(tmp_path):
    import shutil

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    src = tmp_path / "in.avi"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5", "-c:v", "mjpeg", str(src)], check=True)
    d = derive.transcode_video(src, tmp_path / "out", "sha1")
    assert d.files[d.key].stat().st_size > 0 and d.meta["sourceCodec"] == "mjpeg"


class _Resp:
    def __init__(self, body=None, chunks=()):
        self._body, self._chunks = body or {}, chunks

    def raise_for_status(self):
        pass

    def json(self):
        return self._body

    def iter_bytes(self):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


class _FakeKernel:
    def __init__(self):
        self.calls: list[tuple[str, object]] = []

    def post(self, url, json=None):
        self.calls.append((url, json))
        if url.endswith("/claim"):
            return _Resp({"derivatives": [{"id": "drv-1", "nodeId": "nod-1", "kind": "video-mp4"}]})
        return _Resp({})

    def put(self, url, content=b"", headers=None):
        self.calls.append((url, headers))
        return _Resp({"key": "uploads/p/" + url.split("/files/")[1]})

    def stream(self, _m, _url):
        return _Resp(chunks=[b"avi-bytes"])


def test_worker_loop_uploads_and_completes(tmp_path):
    k = _FakeKernel()

    def convert(kind, src, out, sha, progress):
        out.mkdir(parents=True)
        (out / "x.mp4").write_bytes(b"m")
        progress(50)
        return derive.Derived(kind, f"derived/{sha}.mp4", {f"derived/{sha}.mp4": out / "x.mp4"}, {"codec": "h264"})

    assert derive.DeriveWorker(k, tmp_path, convert=convert).tick() == 1
    urls = [u for u, _ in k.calls]
    assert any(u.endswith("/progress") for u in urls) and urls[-1].endswith("/complete")
    done = k.calls[-1][1]
    assert done["key"].startswith("uploads/p/derived/") and done["key"].endswith(".mp4")


def test_worker_loop_reports_the_codec_failure(tmp_path):
    k = _FakeKernel()

    def convert(*_a):
        raise derive.DeriveError("ffmpeg can't decode cinepak video")

    derive.DeriveWorker(k, tmp_path, convert=convert).tick()
    assert k.calls[-1] == ("/api/v1/worker/derivatives/drv-1/fail", {"reason": "ffmpeg can't decode cinepak video", "retry": False, "maxAttempts": 3})
