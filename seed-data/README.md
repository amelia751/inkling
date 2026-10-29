# Seed data

Small, license-tracked development samples, one per imaging family. Fetch with
`pnpm seeds` (runs `scripts/fetch-seeds.py`; needs a logged-in Kaggle CLI and ffmpeg).
Pass project ids to fetch a subset, e.g. `uv run scripts/fetch-seeds.py pathology-wsi`.
The files themselves are never committed.

| Project | Source (Kaggle) | Sample | Served as | License note |
|---|---|---|---|---|
| `2d-xray` | `paultimothymooney/chest-xray-pneumonia` | 10 normal + 10 pneumonia | JPEG | CC BY 4.0 per original; Kaggle lists "Other" |
| `3d-brain-mri` | `dschettler8845/brats-2021-task1` | 2 subjects × FLAIR/T1/T1ce/T2 + seg | NIfTI (.nii.gz) | BraTS 2021 research terms |
| `ecg-waveform` | `physionet/ptbxl-electrocardiography-database` | 10 twelve-lead records | JSON in mV | CC BY 4.0 (PhysioNet), attribution required |
| `video-endoscopy` | `kelkalot/the-hyper-kvasir-dataset` | 2 videos (polyp, cecum), 25 fps | H.264 MP4 (from AVI) | **Restricted**: commercial use needs written permission |
| `4d-cardiac` | `samdazel/automated-cardiac-diagnosis-challenge-miccai17` | patient102: 30-frame cine + ED/ES expert contours | NIfTI (.nii.gz, from .nii) | **Restricted**: ACDC terms bar commercial use/redistribution; citation required |
| `pathology-wsi` | `mahmoodyousaf2018/tcga-wsi-svs` | 1 native SVS slide, 114,150×54,086 px at 40× | Deep Zoom (.dzi + 128k JPEG tiles) | **Restricted**: verify GDC/TCGA data use terms |

Restricted projects are marked `restricted: true` in `manifest.json` and badged
"Local dev only" in the app; do not ship them in a public or commercial build.
Originals are kept under each project's `raw/` folder next to the converted files.

`manifest.json` records each file's source, license and sha256. The dev server writes
Studio annotations to `.annotations/`, never into the seed files.
