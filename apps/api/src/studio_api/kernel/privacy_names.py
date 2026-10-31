"""The path-name privacy check, in-process (todo7 Phase 7).

A copy of `apps/worker/src/studio_worker/inspect/privacy.py` `path_findings` and the value
patterns of `deid.py` (apps never import each other). Renaming or moving a file re-runs it on
the new path: a hold raised only by a name (`flags.privacy.source == "path"`) clears when the
new path is clean, and comes back if an undo brings the name back. Keep the two in sync: a
test compares them (`tests/test_files_privacy.py`).
"""

from __future__ import annotations

import re

PHI_VALUE = [
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")),
    ("phone", re.compile(r"\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b")),
]

# `Lastname_Firstname`, `DOE^JANE`, `Doe, Jane`: two capitalised words. Imaging words are not names.
NAME_LIKE = re.compile(r"^([A-Z][a-z]{1,20}|[A-Z]{2,20})(?:\^|_|, ?| )([A-Z][a-z]{1,20}|[A-Z]{2,20})$")
NOT_NAMES = {
    w.lower()
    for w in (
        "Chest Xray Image Images Scan Scans Series Study Studies Patient Patients Subject Subjects Normal Abnormal Pneumonia Brain Heart Cardiac "
        "Left Right Axial Coronal Sagittal Head Neck Spine Knee Lung Lungs Liver Kidney Breast Train Test Val Validation Data Dataset Raw Processed "
        "New Old Final Draft Copy Export Import Upload Batch Mask Masks Label Labels Video Videos Echo Report Reports Notes Sample Samples Case Cases "
        "Control Controls Group Pre Post Mri Ct Pet Us Xr Dx Cr Mr Dicom Nifti Png Jpeg Readme Misc Other Archive Backup Tmp Temp"
    ).split()
}
DATE_LIKE = re.compile(r"(?<!\d)(19[0-9]{2}|20[0-9]{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12][0-9]|3[01])(?!\d)")
MRN_LIKE = re.compile(r"(?<!\d)\d{7,10}(?!\d)")


def path_findings(rel_path: str) -> list[str]:
    """Reasons a path's folder or file names may identify a person."""
    out: list[str] = []
    parts = [p for p in rel_path.split("/") if p]
    for i, part in enumerate(parts):
        stem = part.rsplit(".", 1)[0] if i == len(parts) - 1 and "." in part else part
        m = NAME_LIKE.match(stem)
        if m and m.group(1).lower() not in NOT_NAMES and m.group(2).lower() not in NOT_NAMES:
            out.append("a name looks like a person's name")
        if DATE_LIKE.search(stem):
            out.append("a name holds a date")
        if MRN_LIKE.search(stem):
            out.append("a name holds a record-number-shaped number")
        for label, rx in PHI_VALUE:
            if rx.search(stem):
                out.append(f"a name holds a {label}-shaped value")
    return list(dict.fromkeys(out))
