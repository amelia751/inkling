"""todo7 Phase 7 exit: privacy and the namespace, against the kernel and the worker.

A DICOM uploaded as `Smith_John_MRI.dcm` (its header is clean) is held for privacy review because
of its name. Renaming it to `case_014.dcm` in Files clears the hold, with an audit entry
`privacy.cleared` (reason "renamed"). The assistant's context for that file then shows only
`case_014.dcm`: never the name it arrived with. While typing a name like a person's, the rename
field warns (never blocks).

    STUDIO_API_URL=http://127.0.0.1:8000 STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_privacy_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import api, check, child, kernel_ok, launch, list_view, new_project, open_folder, parse_args, png, row, summary, sync_playwright, wait  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

# A small, clean DICOM (no patient name or id), written with the worker's pydicom.
DICOM = r"""
import sys
import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
meta = FileMetaDataset()
meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
meta.MediaStorageSOPInstanceUID = generate_uid()
meta.TransferSyntaxUID = ExplicitVRLittleEndian
ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
ds.Modality = "MR"
ds.PatientName = ""
ds.PatientID = ""
ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
ds.Rows = ds.Columns = 16
ds.BitsAllocated = ds.BitsStored = 8
ds.HighBit, ds.PixelRepresentation = 7, 0
ds.PixelData = (np.arange(256, dtype=np.uint8)).tobytes()
ds.save_as(sys.argv[1], enforce_file_format=True)
"""


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    root = Path(tempfile.mkdtemp(prefix="files-e2e-privacy-")) / "study"
    root.mkdir(parents=True)
    subprocess.run(["uv", "run", "--package", "studio-worker", "python", "-c", DICOM, str(root / "Smith_John_MRI.dcm")], cwd=ROOT, check=True)
    (root / "other.png").write_bytes(png(8, 8, 1))
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        pid, study = new_project(page, base, "Files privacy e2e", root)
        f = wait(lambda: (lambda n: n if n and n.get("status") not in ("checking", "pending") else None)(child(page, pid, study, "Smith_John_MRI.dcm")), 60)
        d = api(page, f"/source-nodes/{f['id']}")["json"] if f else {}
        priv = (d.get("flags") or {}).get("privacy") or {}
        check("Smith_John_MRI.dcm is held, because of its name", d.get("status") == "privacy" and priv.get("source") == "path", str({"status": d.get("status"), "privacy": priv, "kind": d.get("detectedKind")}))

        # ---- Rename it in Files; the field warns while the name still looks like a person's -----
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "Smith_John_MRI.dcm").click()
        page.keyboard.press("F2")
        field = page.locator("[data-testid=listing-rename-input]")
        field.wait_for(timeout=5000)
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.type("Doe_Jane.dcm")
        warn = page.get_by_test_id("rename-warning")
        check("typing a person's name warns (never blocks)", bool(wait(lambda: warn.is_visible() and "person's name" in warn.inner_text(), 3)) and page.get_by_test_id("rename-error").count() == 0, warn.inner_text() if warn.count() else "")
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.type("case_014.dcm")
        check("a study code doesn't", wait(lambda: warn.count() == 0, 3))
        page.keyboard.press("Enter")
        cleared = wait(lambda: (lambda x: x if x.get("name") == "case_014.dcm" and x.get("status") != "privacy" else None)(api(page, f"/source-nodes/{f['id']}")["json"]), 10)
        check("renaming to case_014.dcm clears the hold", bool(cleared), str({k: (cleared or {}).get(k) for k in ("name", "status")}))
        check("the flag says why it cleared", ((cleared or {}).get("flags") or {}).get("privacy", {}).get("clearReason") == "renamed", str((cleared or {}).get("flags")))
        acts = api(page, f"/projects/{pid}/activity?limit=50")
        events = (acts["json"] or {}).get("entries") or []
        audit = [e for e in events if e.get("action") == "privacy.cleared" and e.get("target") == f["id"]]
        check("with an audit entry privacy.cleared in the project's Activity", acts["status"] == 200 and bool(audit), str([(e.get("action"), e.get("target")) for e in events])[:400])

        # ---- The assistant's context names only case_014.dcm ----------------------------------
        page.wait_for_timeout(800)
        row(page, "case_014.dcm").click()
        ctx = wait(
            lambda: (lambda c: c if c and "case_014.dcm" in c["text"] else None)(
                page.evaluate("async () => { const m = await import('/src/studio/lib/agent/providers.ts'); const p = m.useAgentContextStore.getState().provider; return p ? { label: p.label, text: p.turnContext(), shares: p.shares } : null; }")
            ),
            10,
        )
        check("the assistant's context for the file names case_014.dcm", bool(ctx) and "case_014.dcm" in ctx["label"], str(ctx))
        blob = str(ctx)
        check("and never the name it arrived with", bool(ctx) and "Smith" not in blob and "John" not in blob, blob[:400])
        node = api(page, f"/source-nodes/{f['id']}")["json"]
        check("the person (a member) can still see the original name behind “Show original name”", "Smith_John_MRI.dcm" in str(node.get("originalPath")), str(node.get("originalPath")))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return summary()


if __name__ == "__main__":
    sys.exit(main())
