# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "openslide-python", "openslide-bin", "pillow", "boto3"]
# ///
"""Fetch a small, license-tracked sample of each development seed dataset.

Downloads only the handful of files each seed needs (never the full archives),
records source + license + sha256 for every file, and writes
``seed-data/manifest.json`` for the web app to read.

Hyper-Kvasir, ACDC and TCGA restrict commercial use or redistribution. They are
fetched for local development only and flagged ``restricted`` in the manifest so
they are never bundled into a public build.

Format conversions (originals are kept next to the converted files):
  * Hyper-Kvasir .avi  → H.264 .mp4 (browsers cannot play AVI)          needs ffmpeg
  * ACDC 4D .nii       → .nii.gz                                        stdlib gzip
  * TCGA .svs          → Deep Zoom (.dzi + JPEG tile pyramid)           openslide

Usage:  uv run tools/fetch-seeds.py [project-id ...]   # requires the kaggle CLI, logged in
        python3 tools/fetch-seeds.py --check            # stdlib only: is seed-data/ current?

``--check`` exits 1 when ``seed-data/manifest.json`` is missing or older than
``MANIFEST_VERSION``; the e2e harness runs it before any test.

Object storage (todo/done/todo3.md E.3): ``--upload`` then puts ``seed-data/`` into the
``assets`` bucket that ``apps/api`` serves from (``BLOB_STORE=s3``), with keys equal to the
paths in ``manifest.json`` (plus ``manifest.json`` itself, each project's
``workspace.json`` and every Deep Zoom tile next to a ``.dzi``). ``--upload-only`` skips
the download. Objects already present with the same size and sha256 are skipped. Config
(env, prefixed with the naming config's ``envPrefix``): ``S3_ENDPOINT`` (e.g. MinIO's
``http://127.0.0.1:9000``), ``S3_BUCKET`` (default ``assets``), ``S3_REGION``, ``S3_PREFIX``;
credentials from ``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY``.

        uv run tools/fetch-seeds.py --upload-only [--include-raw] [--create-bucket] [project-id ...]
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "seed-data"
# Bump when the manifest format changes; `--check` (run by the e2e harness) rejects older ones.
MANIFEST_VERSION = 2

XRAY_DATASET = "paultimothymooney/chest-xray-pneumonia"
BRATS_DATASET = "dschettler8845/brats-2021-task1"
PTBXL_DATASET = "physionet/ptbxl-electrocardiography-database"
KVASIR_DATASET = "kelkalot/the-hyper-kvasir-dataset"
ACDC_DATASET = "samdazel/automated-cardiac-diagnosis-challenge-miccai17"
TCGA_DATASET = "mahmoodyousaf2018/tcga-wsi-svs"

XRAY_PER_CLASS = 10
BRATS_SUBJECTS = ["BraTS2021_00495", "BraTS2021_00621"]
PTBXL_RECORDS = 10
KVASIR_VIDEOS = [
    ("labeled-videos/lower-gi-tract/pathological-findings/polyps/16e7e461-a9a7-4b04-8d2c-155de3eb1c90.avi", "polyp"),
    ("labeled-videos/lower-gi-tract/anatomical-landmarks/cecum/44c8c58b-e226-4f10-adf4-b8f91b71c476.avi", "cecum"),
]
ACDC_PATIENT = ("testing", "patient102")
# Smallest native slide in the mirror (~170 MB): still a full 40x pyramid.
TCGA_SLIDE = "103810e8-c721-4242-b729-270097a23469/TCGA-A6-5665-01Z-00-DX1.3ad2c249-d138-4037-a59b-4747ce2b789a.svs"
DZI_TILE = 254
DZI_OVERLAP = 1
ECG_LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def kaggle(*args: str, attempts: int = 4) -> str:
    # The Kaggle API intermittently fails mid-pagination; retry with backoff.
    for attempt in range(attempts):
        out = subprocess.run(["kaggle", *args], capture_output=True, text=True)
        if out.returncode == 0:
            return out.stdout
        time.sleep(2**attempt)
    raise RuntimeError(f"kaggle {' '.join(args[:3])} failed: {out.stderr.strip() or out.stdout.strip()}")


def list_files(dataset: str, want, limit: int) -> list[str]:
    """Page through a dataset's file listing until ``want`` has accepted ``limit`` names."""
    names: list[str] = []
    token = None
    while len(names) < limit:
        args = ["datasets", "files", dataset, "--csv", "--page-size", "200"]
        if token:
            args += ["--page-token", token]
        text = kaggle(*args)
        lines = [ln for ln in text.splitlines() if not ln.startswith("Warning")]
        token = None
        if lines and lines[0].startswith("Next Page Token"):
            token = lines.pop(0).split("=", 1)[1].strip()
        for row in csv.DictReader(io.StringIO("\n".join(lines))):
            if want(row["name"]) and len(names) < limit:
                names.append(row["name"])
        if not token:
            break
    return names


def download(dataset: str, name: str, dest_dir: Path) -> Path:
    """Download one file from a Kaggle dataset into a fresh temp dir, then move it to dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / Path(name).name
    if target.exists():
        return target
    with tempfile.TemporaryDirectory() as tmp:
        kaggle("datasets", "download", dataset, "-f", name, "-p", tmp, "--quiet")
        got = next(Path(tmp).iterdir())
        # Kaggle zips files above a size threshold.
        if got.suffix == ".zip" and Path(name).suffix != ".zip":
            with zipfile.ZipFile(got) as z:
                z.extract(Path(name).name, tmp)
            got = Path(tmp) / Path(name).name
        shutil.move(str(got), target)
    return target


def asset(path: Path, **extra) -> dict:
    return {"path": str(path.relative_to(SEED)), "sha256": sha256(path), "bytes": path.stat().st_size, **extra}


def fetch_xray() -> dict:
    out = SEED / "2d-xray"
    assets = []
    for label in ("NORMAL", "PNEUMONIA"):
        have = sorted((out / label.lower()).glob("*.jpeg"))
        if len(have) >= XRAY_PER_CLASS:
            assets += [asset(p, label=label.lower()) for p in have[:XRAY_PER_CLASS]]
            continue
        names = list_files(
            XRAY_DATASET,
            lambda n, label=label: n.startswith(f"chest_xray/test/{label}/") and n.endswith(".jpeg"),
            XRAY_PER_CLASS,
        )
        for name in names:
            print(f"  xray {name}")
            assets.append(asset(download(XRAY_DATASET, name, out / label.lower()), label=label.lower()))
    return {
        "id": "2d-xray",
        "title": "Chest X-ray · Pneumonia",
        "viewer": "image-2d",
        "task": "classification",
        "labels": ["normal", "pneumonia"],
        "source": f"https://www.kaggle.com/datasets/{XRAY_DATASET}",
        "license": "CC BY 4.0 per original description (Kaggle metadata: Other) — verify before redistribution",
        "assets": assets,
    }


def fetch_brats() -> dict:
    out = SEED / "3d-brain-mri"
    assets = []
    for subject in BRATS_SUBJECTS:
        print(f"  brats {subject}")
        subj_dir = out / subject
        if not subj_dir.exists():
            with tempfile.TemporaryDirectory() as tmp:
                tar_path = download(BRATS_DATASET, f"{subject}.tar", Path(tmp))
                with tarfile.open(tar_path) as tar:
                    tar.extractall(subj_dir, filter="data")
        for nii in sorted(subj_dir.rglob("*.nii.gz")):
            seq = nii.name.removesuffix(".nii.gz").rsplit("_", 1)[-1]
            assets.append(asset(nii, subject=subject, sequence=seq))
    return {
        "id": "3d-brain-mri",
        "title": "Brain MRI · BraTS 2021",
        "viewer": "volume-3d",
        "task": "segmentation",
        "labels": ["necrotic core", "edema", "enhancing tumor"],
        "source": f"https://www.kaggle.com/datasets/{BRATS_DATASET}",
        "license": "BraTS 2021 challenge terms — research use; verify with original publishers",
        "assets": assets,
    }


def fetch_ptbxl() -> dict:
    from scipy.io import loadmat

    out = SEED / "ecg-waveform"
    raw = out / "raw"
    assets = []
    for i in range(1, PTBXL_RECORDS + 1):
        rec = f"HR{i:05d}"
        print(f"  ptbxl {rec}")
        hea = download(PTBXL_DATASET, f"WFDB/{rec}.hea", raw)
        mat = download(PTBXL_DATASET, f"WFDB/{rec}.mat", raw)
        header = hea.read_text().splitlines()
        _, _, fs, n_samples = header[0].split()[:4]
        gains = [float(line.split()[2].split("/")[0]) for line in header[1:13]]
        dx = next((ln.split(":", 1)[1].strip() for ln in header if ln.startswith("#Dx")), "")
        signal = loadmat(mat)["val"]
        # Convert ADC units to millivolts, rounded to keep the JSON small.
        leads = {lead: [round(v / g, 3) for v in row] for lead, g, row in zip(ECG_LEADS, gains, signal)}
        json_path = out / f"{rec}.json"
        json_path.write_text(json.dumps({"record": rec, "fs": int(fs), "samples": int(n_samples), "dx": dx, "leads": leads}))
        assets.append(asset(json_path, record=rec, dx=dx, raw=[str(hea.relative_to(SEED)), str(mat.relative_to(SEED))]))
    return {
        "id": "ecg-waveform",
        "title": "12-lead ECG · PTB-XL",
        "viewer": "signal",
        "task": "event-marking",
        "labels": ["P wave", "QRS complex", "T wave", "artifact"],
        "source": f"https://www.kaggle.com/datasets/{PTBXL_DATASET} (original: physionet.org/content/ptb-xl)",
        "license": "CC BY 4.0 (PhysioNet) — attribution required",
        "assets": assets,
    }


def fetch_kvasir() -> dict:
    out = SEED / "video-endoscopy"
    assets = []
    for name, finding in KVASIR_VIDEOS:
        print(f"  kvasir {Path(name).name}")
        avi = download(KVASIR_DATASET, name, out / "raw")
        mp4 = out / f"{avi.stem}.mp4"
        if not mp4.exists():
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(avi), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                 "-crf", "23", "-movflags", "+faststart", "-an", str(mp4)],
                check=True,
            )
        probe = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
             "stream=width,height,r_frame_rate,nb_read_packets:format=duration", "-of", "json", str(mp4)],
            check=True, capture_output=True, text=True,
        ).stdout)
        stream = probe["streams"][0]
        num, den = (int(x) for x in stream["r_frame_rate"].split("/"))
        assets.append(asset(
            mp4, label=finding, raw=[str(avi.relative_to(SEED))],
            width=stream["width"], height=stream["height"], fps=round(num / den, 3),
            frames=int(stream["nb_read_packets"]), duration=round(float(probe["format"]["duration"]), 3),
        ))
    return {
        "id": "video-endoscopy",
        "title": "Endoscopy video · Hyper-Kvasir",
        "viewer": "temporal",
        "task": "detection",
        "labels": ["polyp", "landmark", "bleeding", "instrument"],
        "source": f"https://www.kaggle.com/datasets/{KVASIR_DATASET}",
        "license": "Research/education use; commercial use requires prior written permission. Local development only",
        "restricted": True,
        "assets": assets,
    }


def fetch_acdc() -> dict:
    split, patient = ACDC_PATIENT
    out = SEED / "4d-cardiac" / patient
    base = f"database/{split}/{patient}"
    print(f"  acdc {patient}")
    cfg = download(ACDC_DATASET, f"{base}/Info.cfg", out)
    download(ACDC_DATASET, f"{base}/MANDATORY_CITATION.md", out)
    info = dict(line.split(": ", 1) for line in cfg.read_text().splitlines() if ": " in line)
    ed, es = int(info["ED"]), int(info["ES"])

    def gz(name: str) -> Path:
        nii = download(ACDC_DATASET, f"{base}/{name}", out / "raw")
        target = out / f"{nii.name}.gz"
        if not target.exists():
            with nii.open("rb") as src, gzip.open(target, "wb", compresslevel=6) as dst:
                shutil.copyfileobj(src, dst)
        return target

    assets = [asset(gz(f"{patient}_4d.nii"), role="cine")]
    for phase, frame in (("ED", ed), ("ES", es)):
        assets.append(asset(gz(f"{patient}_frame{frame:02d}_gt.nii"), role="reference", phase=phase, frame=frame - 1))
    return {
        "id": "4d-cardiac",
        "title": "Cardiac cine MRI · ACDC",
        "viewer": "cine-4d",
        "task": "segmentation",
        "labels": ["right ventricle", "myocardium", "left ventricle"],
        "source": f"https://www.kaggle.com/datasets/{ACDC_DATASET} (original: creatis.insa-lyon.fr/Challenge/acdc)",
        "license": "ACDC terms restrict commercial use and redistribution (Kaggle lists Apache-2.0). Citation required. Local development only",
        "restricted": True,
        "meta": {"group": info.get("Group"), "frames": int(info["NbFrame"]), "ed": ed - 1, "es": es - 1},
        "assets": assets,
    }


def fetch_tcga() -> dict:
    import openslide
    from openslide.deepzoom import DeepZoomGenerator

    out = SEED / "pathology-wsi"
    print(f"  tcga {Path(TCGA_SLIDE).name}")
    svs = download(TCGA_DATASET, TCGA_SLIDE, out / "raw")
    slide_id = svs.name.split(".")[0]
    dzi = out / f"{slide_id}.dzi"
    tiles = out / f"{slide_id}_files"
    slide = openslide.OpenSlide(svs)
    mpp = slide.properties.get(openslide.PROPERTY_NAME_MPP_X)
    magnification = slide.properties.get(openslide.PROPERTY_NAME_OBJECTIVE_POWER)
    width, height = slide.dimensions

    if not dzi.exists():
        dz = DeepZoomGenerator(slide, tile_size=DZI_TILE, overlap=DZI_OVERLAP, limit_bounds=False)
        jobs = [(level, col, row) for level in range(dz.level_count)
                for col in range(dz.level_tiles[level][0]) for row in range(dz.level_tiles[level][1])]
        print(f"    tiling {width}×{height}px into {len(jobs)} tiles…")

        # OpenSlide handles are not thread-safe; give each worker its own.
        import threading
        local = threading.local()

        def write(job):
            level, col, row = job
            if not hasattr(local, "dz"):
                local.dz = DeepZoomGenerator(openslide.OpenSlide(svs), tile_size=DZI_TILE, overlap=DZI_OVERLAP, limit_bounds=False)
            path = tiles / str(level) / f"{col}_{row}.jpeg"
            path.parent.mkdir(parents=True, exist_ok=True)
            local.dz.get_tile(level, (col, row)).convert("RGB").save(path, quality=80)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for i, _ in enumerate(pool.map(write, jobs, chunksize=64)):
                if i % 5000 == 0:
                    print(f"    {i}/{len(jobs)}")
        dzi.write_text(dz.get_dzi("jpeg"))

    thumb = out / f"{slide_id}_thumb.jpeg"
    if not thumb.exists():
        slide.get_thumbnail((512, 512)).convert("RGB").save(thumb, quality=85)
    tile_count = sum(1 for _ in tiles.rglob("*.jpeg"))
    tile_bytes = sum(p.stat().st_size for p in tiles.rglob("*.jpeg"))
    return {
        "id": "pathology-wsi",
        "title": "Pathology WSI · TCGA",
        "viewer": "pathology",
        "task": "region-annotation",
        "labels": ["tumor", "stroma", "necrosis", "lymphocytes"],
        "source": f"https://www.kaggle.com/datasets/{TCGA_DATASET} (original: portal.gdc.cancer.gov)",
        "license": "TCGA open-access slide. Verify GDC data use terms before redistribution. Local development only",
        "restricted": True,
        "assets": [{
            **asset(dzi, slide=slide_id, width=width, height=height, mpp=float(mpp) if mpp else None,
                    magnification=magnification, tiles=tile_count, raw=[str(svs.relative_to(SEED))]),
            "bytes": tile_bytes,
        }, asset(thumb, role="thumbnail")],
    }


FETCHERS = {
    "2d-xray": fetch_xray,
    "3d-brain-mri": fetch_brats,
    "ecg-waveform": fetch_ptbxl,
    "video-endoscopy": fetch_kvasir,
    "4d-cardiac": fetch_acdc,
    "pathology-wsi": fetch_tcga,
}


# Seed projects boot a Studio environment (apps/web/src/platform/presets/*.json). `viewer`
# and string `labels` stay for one release so older checkouts still load the manifest.
PRESET_FOR_VIEWER = {
    "image-2d": "preset:image-2d",
    "volume-3d": "preset:volume-3d",
    "signal": "preset:ecg",
    "temporal": "preset:video",
    "cine-4d": "preset:cine-4d",
    "pathology": "preset:pathology",
}


def with_environment(project: dict) -> dict:
    """Add `environment`: the viewer's preset plus label groups with palette colors.

    A classification task gets one `Choices` group and no region copy of the same classes
    (todo8 D4): a box labelled "pneumonia" isn't what that task asks for, and without a region
    group the Studio shows no drawing tools.
    """
    classes = [{"id": label, "color": f"chart-{i % 5 + 1}"} for i, label in enumerate(project.get("labels", []))]
    if project.get("task") == "classification":
        groups = [{"name": "class", "control": "Choices", "classes": classes}]
    else:
        groups = [{"name": "labels", "control": "Labels", "classes": classes}]
    env = {"extends": PRESET_FOR_VIEWER[project["viewer"]], "task": project.get("task"), "labels": groups}
    return {**project, "environment": {k: v for k, v in env.items() if v is not None}}


# ---- Upload to object storage (todo/done/todo3.md E.3) -------------------------------------------


def env(name: str, default: str | None = None) -> str | None:
    prefix = json.loads((ROOT / "schemas" / "naming.json").read_text())["envPrefix"]
    import os

    return os.environ.get(prefix + name) or default


def upload_keys(manifest: dict, only: set[str] | None, include_raw: bool) -> list[str]:
    """Keys (= seed-data relative paths) the Studio and the kernel read for these projects."""
    keys: list[str] = ["manifest.json"]
    for p in manifest.get("projects", []):
        if only and p["id"] not in only:
            continue
        if (SEED / p["id"] / "workspace.json").is_file():
            keys.append(f"{p['id']}/workspace.json")
        for a in p.get("assets", []):
            keys.append(a["path"])
            if a["path"].endswith(".dzi"):  # the tile pyramid lives next to the descriptor
                tiles = SEED / (a["path"][: -len(".dzi")] + "_files")
                keys += sorted(str(f.relative_to(SEED)) for f in tiles.rglob("*") if f.is_file())
            if include_raw:
                keys += a.get("raw") or []
    return list(dict.fromkeys(keys))


def upload(only: set[str] | None, include_raw: bool, create_bucket: bool) -> int:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError

    manifest_path = SEED / "manifest.json"
    if not manifest_path.is_file():
        print("seed-data/manifest.json is missing: fetch the seeds first")
        return 2
    endpoint, bucket = env("S3_ENDPOINT"), env("S3_BUCKET", "assets")
    prefix = (env("S3_PREFIX") or "").strip("/")
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=env("S3_REGION", "us-east-1"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path" if endpoint else "auto"}),
    )
    try:
        s3.head_bucket(Bucket=bucket)
    except ClientError:
        if not create_bucket:
            print(f"bucket {bucket!r} doesn't exist (or isn't readable); pass --create-bucket to create it")
            return 2
        s3.create_bucket(Bucket=bucket)
    keys = upload_keys(json.loads(manifest_path.read_text()), only, include_raw)
    known = {a["path"]: a.get("sha256") for p in json.loads(manifest_path.read_text()).get("projects", []) for a in p.get("assets", [])}

    def one(key: str) -> str:
        f = SEED / key
        if not f.is_file():
            return "missing"
        size = f.stat().st_size
        digest = known.get(key) or sha256(f)  # the manifest records each asset's sha256 (tiles are hashed here)
        full = f"{prefix}/{key}" if prefix else key
        try:
            head = s3.head_object(Bucket=bucket, Key=full)
            if head["ContentLength"] == size and head.get("Metadata", {}).get("sha256") == digest:
                return "skipped"
        except ClientError as e:
            if str(e.response.get("Error", {}).get("Code")) not in ("404", "NoSuchKey", "NotFound"):
                raise
        extra = {"Metadata": {"sha256": digest}}
        if key.endswith(".json"):
            extra["ContentType"] = "application/json"
        s3.upload_file(str(f), bucket, full, ExtraArgs=extra)
        return "uploaded"

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(one, keys))
    counts = {k: results.count(k) for k in ("uploaded", "skipped", "missing")}
    for key, r in zip(keys, results):
        if r == "missing":
            print(f"  missing locally: {key}")
    print(f"s3://{bucket}/{prefix + '/' if prefix else ''}: {counts['uploaded']} uploaded, {counts['skipped']} unchanged, {counts['missing']} missing")
    return 1 if counts["missing"] else 0


def check() -> int:
    """seed-data/manifest.json exists and has the current format (no third-party imports)."""
    manifest_path = SEED / "manifest.json"
    if not manifest_path.is_file():
        print(f"{manifest_path.relative_to(ROOT)} is missing: run `pnpm seeds`")
        return 1
    version = json.loads(manifest_path.read_text()).get("version")
    if version != MANIFEST_VERSION:
        print(f"{manifest_path.relative_to(ROOT)} is version {version}, expected {MANIFEST_VERSION}: run `pnpm seeds` again")
        return 1
    return 0


def main(argv: list[str]) -> int:
    flags = {a for a in argv if a.startswith("--")}
    argv = [a for a in argv if not a.startswith("--")]
    unknown_flags = flags - {"--upload", "--upload-only", "--include-raw", "--create-bucket", "--check"}
    if unknown_flags:
        print(f"Unknown option(s): {', '.join(sorted(unknown_flags))}")
        return 2
    if "--check" in flags:
        return check()
    if "--upload-only" in flags:
        return upload(set(argv) or None, "--include-raw" in flags, "--create-bucket" in flags)
    code = fetch(argv)
    if code == 0 and "--upload" in flags:
        return upload(set(argv) or None, "--include-raw" in flags, "--create-bucket" in flags)
    return code


def fetch(argv: list[str]) -> int:
    only = set(argv) or set(FETCHERS)
    unknown = only - set(FETCHERS)
    if unknown:
        print(f"Unknown project(s): {', '.join(sorted(unknown))}. Choose from {', '.join(FETCHERS)}")
        return 2
    SEED.mkdir(exist_ok=True)
    manifest_path = SEED / "manifest.json"
    existing = {p["id"]: p for p in json.loads(manifest_path.read_text())["projects"]} if manifest_path.exists() else {}
    projects = []
    for pid, fn in FETCHERS.items():
        if pid in only:
            print(f"Fetching {pid}…")
            projects.append(with_environment({**fn(), "status": "available"}))
        elif existing.get(pid, {}).get("status") == "available":
            projects.append(with_environment(existing[pid]))
    manifest_path.write_text(json.dumps({"version": MANIFEST_VERSION, "projects": projects}, indent=2))
    print(f"Wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
