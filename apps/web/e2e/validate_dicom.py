"""Summarise a DICOM SEG or SR written by the viewers, for the e2e tests.

    uv run --with pydicom --with numpy python e2e/validate_dicom.py seg|sr FILE
Prints JSON on stdout.
"""

from __future__ import annotations

import json
import sys

import pydicom

SEG_SOP = {"1.2.840.10008.5.1.4.1.1.66.4": "Segmentation", "1.2.840.10008.5.1.4.1.1.66.7": "Label Map Segmentation"}


def seg(ds: pydicom.Dataset) -> dict:
    frames = int(ds.NumberOfFrames)
    px = ds.pixel_array.reshape(frames, int(ds.Rows), int(ds.Columns))
    segments = []
    for s in ds.SegmentSequence:
        segments.append({
            "number": int(s.SegmentNumber),
            "label": str(s.SegmentLabel),
            "algorithm": str(s.SegmentAlgorithmType),
            "lab": [int(v) for v in s.get("RecommendedDisplayCIELabValue", [])],
            "type": str(s.SegmentedPropertyTypeCodeSequence[0].CodeMeaning),
        })
    per_frame = []
    for i, f in enumerate(ds.PerFrameFunctionalGroupsSequence):
        ref = f.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID if "DerivationImageSequence" in f else None
        per_frame.append({
            "segment": int(f.SegmentIdentificationSequence[0].ReferencedSegmentNumber),
            "position": [float(v) for v in f.PlanePositionSequence[0].ImagePositionPatient] if "PlanePositionSequence" in f else None,
            "ref": ref,
            "pixels": int(px[i].sum()),
        })
    return {
        "sopClassUID": str(ds.SOPClassUID),
        "sopClass": SEG_SOP.get(str(ds.SOPClassUID), "?"),
        "modality": str(ds.Modality),
        "frames": frames,
        "rows": int(ds.Rows),
        "columns": int(ds.Columns),
        "segments": segments,
        "referencedSeries": [str(r.SeriesInstanceUID) for r in ds.get("ReferencedSeriesSequence", [])],
        "studyUID": str(ds.StudyInstanceUID),
        "frameOfReferenceUID": str(ds.get("FrameOfReferenceUID", "")),
        "perFrame": per_frame,
        "totalPixels": int(px.sum()),
    }


def walk(items, depth=0, out=None):
    out = [] if out is None else out
    for it in items:
        name = it.ConceptNameCodeSequence[0].CodeMeaning if "ConceptNameCodeSequence" in it else ""
        entry = {"type": str(it.ValueType), "name": str(name), "depth": depth}
        if it.ValueType == "NUM" and "MeasuredValueSequence" in it:
            mv = it.MeasuredValueSequence[0]
            entry["value"] = float(mv.NumericValue)
            entry["unit"] = str(mv.MeasurementUnitsCodeSequence[0].CodeValue)
        elif it.ValueType == "TEXT":
            entry["value"] = str(it.TextValue)
        elif it.ValueType == "CODE":
            entry["value"] = str(it.ConceptCodeSequence[0].CodeMeaning)
        elif it.ValueType in ("SCOORD", "SCOORD3D"):
            entry["graphicType"] = str(it.GraphicType)
            entry["points"] = len(it.GraphicData) // (3 if it.ValueType == "SCOORD3D" else 2)
        out.append(entry)
        if "ContentSequence" in it:
            walk(it.ContentSequence, depth + 1, out)
    return out


def sr(ds: pydicom.Dataset) -> dict:
    tree = walk(ds.ContentSequence)
    return {
        "sopClassUID": str(ds.SOPClassUID),
        "modality": str(ds.Modality),
        "template": str(ds.ContentTemplateSequence[0].TemplateIdentifier) if "ContentTemplateSequence" in ds else None,
        "title": str(ds.ConceptNameCodeSequence[0].CodeMeaning),
        "groups": sum(1 for e in tree if e["name"] == "Measurement Group"),
        "nums": [{"name": e["name"], "value": e["value"], "unit": e["unit"]} for e in tree if e["type"] == "NUM"],
        "codes": [e["value"] for e in tree if e["type"] == "CODE"],
        "scoords": [e["graphicType"] for e in tree if e["type"] in ("SCOORD", "SCOORD3D")],
        "evidence": [str(r.SeriesInstanceUID) for r in ds.get("CurrentRequestedProcedureEvidenceSequence", [{}])[0].get("ReferencedSeriesSequence", [])] if "CurrentRequestedProcedureEvidenceSequence" in ds else [],
    }


def main() -> None:
    kind, path = sys.argv[1], sys.argv[2]
    ds = pydicom.dcmread(path)
    print(json.dumps(seg(ds) if kind == "seg" else sr(ds)))


if __name__ == "__main__":
    main()
