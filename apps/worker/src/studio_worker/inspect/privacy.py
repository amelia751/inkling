"""Privacy checks for inspection (todo6 Phase 5.1): DICOM headers, path names and table headers.

This extends the `deid.py` rules and is, like them, a deterministic development check, not a
de-identification: a hit *holds* the file out of datasets until a person clears it with a
reason (recorded in the audit log as `privacy.cleared`). Findings name the field or the kind
of pattern, never the value, so the flag itself carries no identifier.
"""

from __future__ import annotations

import re

from ..deid import PHI_KEY, PHI_VALUE

# DICOM attributes that identify a person (PS3.15 Annex E, the direct identifiers).
DICOM_PHI_TAGS = (
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientAddress",
    "PatientTelephoneNumbers",
    "OtherPatientIDs",
    "OtherPatientNames",
    "PatientMotherBirthName",
    "MilitaryRank",
    "ReferringPhysicianName",
    "PerformingPhysicianName",
    "InstitutionName",
    "InstitutionAddress",
    "AccessionNumber",
)
# Values anonymizers leave behind: not an identifier.
ANONYMIZED = re.compile(r"^(|anon\w*|anonymi[sz]ed|removed|unknown|none|n/?a|x+|0+|redacted|deidentified|de-identified|\*+|-+)$", re.I)

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
# Table headers: like `deid.PHI_KEY`, but a study's own subject id (`patient_id`, `subject`) is
# how tables link to scans; its *values* are checked instead (MRN-shaped numbers).
TABLE_PHI_KEY = re.compile(
    r"(patient.?(name|birth|address)|birth.?date|date.?of.?birth|\bdob\b|\bssn\b|social.?security|\bmrn\b|medical.?record|"
    r"street|address|zip.?code|postal|phone|telephone|\bfax\b|e-?mail|first.?name|last.?name|surname|given.?name|family.?name|"
    r"referring.?physician|accession)",
    re.I,
)


def dicom_findings(ds) -> list[str]:
    """Names of the identifying attributes a dataset carries with a real-looking value."""
    out = []
    for tag in DICOM_PHI_TAGS:
        v = ds.get(tag) if hasattr(ds, "get") else None
        if v is None:
            continue
        text = str(getattr(v, "value", v) or "").strip()
        if text and not ANONYMIZED.match(text):
            out.append(tag)
    return out


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


def table_findings(columns: list[str], rows: list[list[str]]) -> list[str]:
    """Identifier-like column names, and values shaped like SSNs, e-mails, phones or MRNs in
    columns that hold ids."""
    out = [f"column “{c}” looks like an identifier field" for c in columns if TABLE_PHI_KEY.search(c.replace("_", " ")) or TABLE_PHI_KEY.search(c)]
    for i, c in enumerate(columns):
        vals = [r[i] for r in rows if i < len(r) and r[i].strip()]
        for label, rx in PHI_VALUE:
            if any(rx.search(v) for v in vals):
                out.append(f"column “{c}” holds {label}-shaped values")
        if PHI_KEY.search(c.replace("_", " ")) and vals and sum(bool(MRN_LIKE.fullmatch(v.strip())) for v in vals) >= max(1, len(vals) // 2):
            out.append(f"column “{c}” holds record-number-shaped ids")
    return list(dict.fromkeys(out))


def flag(reasons: list[str], source: str, fields: list[str] | None = None) -> dict:
    """The node's `flags.privacy` (cleared later through POST /v1/source-nodes/:id/privacy/clear)."""
    reason = {
        "header": "Held: header has " + (", ".join(_plain(f) for f in (fields or [])[:3]) or "identifying fields"),
        "path": "Held: " + (reasons[0] if reasons else "a folder or file name may identify a person"),
        "table": "Held: " + (reasons[0] if reasons else "the table may hold identifiers"),
    }[source]
    out = {"reason": reason, "source": source, "findings": reasons[:10], "checker": "dev-inspect-v1"}
    if fields:
        out["fields"] = fields
    return out


def _plain(tag: str) -> str:
    """`PatientName` → `a patient name field`."""
    words = re.sub(r"(?<!^)(?=[A-Z])", " ", tag).lower()
    return f"a {words} field"
