"""Lint rule families (todo17 D4): pure functions over (input, rules) that return violations.

`rules` is a project's `rules.v1` document (D3) as a dict; `input` is the normalised write.
Severity here is the rule's default; `resolve_severity` applies a project's overrides and the
evaluate mode (D5) on top. The catalogue codes mirror `packages/contracts/src/lint-rules.ts`.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

Severity = str  # "error" | "warn" | "info" | "off"
SEVERITIES = ("off", "info", "warn", "error")
DOCS_BASE = "/docs/lint-rules#"


@dataclass(frozen=True)
class RuleSpec:
    code: str
    severity: Severity
    fix: str
    fixable: bool = False
    # D5: a rule's first release records findings but rejects nothing until promoted.
    evaluate: bool = False


CATALOGUE: dict[str, RuleSpec] = {
    s.code: s
    for s in (
        RuleSpec("label.unknown", "error", "Use one of the project's labels, or propose adding it to the rules."),
        RuleSpec("label.synonym", "info", "Use the canonical label; the normaliser rewrites synonyms.", fixable=True),
        RuleSpec("geometry.not-allowed", "error", "Use a geometry this label allows."),
        RuleSpec("layout.misplaced", "error", "Put the file under one of the project's folder patterns."),
        RuleSpec("layout.forbidden-char", "error", "Remove the forbidden characters from the path."),
        RuleSpec("layout.too-deep", "warn", "Use a shallower folder."),
        RuleSpec("name.pattern", "warn", "Rename the file to match the project's file-name pattern."),
        RuleSpec("dataset.metadata-missing", "error", "Add the required metadata to the dataset."),
        RuleSpec("dataset.name-taken", "error", "Choose a dataset name that is not used in this project."),
        RuleSpec("dataset.mixed-modality", "warn", "Split the dataset so it holds one modality.", evaluate=True),
        # Imaging checks (D11): the worker's `imaging.check` reports them (kernel/imaging_findings.py).
        RuleSpec("dicom.series-incomplete", "warn", "Upload the missing instances, or remove the partial series.", evaluate=True),
        RuleSpec("dicom.inconsistent-spacing", "warn", "Check the series for missing or duplicated slices, or resample it to even spacing.", evaluate=True),
        RuleSpec("dicom.inconsistent-orientation", "warn", "Split the series: its slices belong to more than one volume.", evaluate=True),
        RuleSpec("dicom.seg-frame-mismatch", "error", "Regenerate the segmentation against the referenced series.", evaluate=True),
        RuleSpec("dicom.conformance", "info", "Fix the attributes dciodvfy reports, or re-export from the source system.", evaluate=True),
        RuleSpec("nifti.orientation-mismatch", "warn", "Rewrite the header with one consistent affine (qform = sform).", evaluate=True),
        RuleSpec("nifti.voxel-size", "error", "Set positive voxel sizes (pixdim) in the header.", evaluate=True),
        RuleSpec("nifti.nan", "warn", "Replace NaN voxels (e.g. with 0) before labelling or training.", evaluate=True),
        RuleSpec("nifti.grid-mismatch", "error", "Resample the mask onto the image grid (same shape and affine).", evaluate=True),
    )
}


@dataclass
class Violation:
    rule: str
    path: str
    message: str
    severity: Severity = ""
    value: Any = None
    allowed: Any = None
    fix: str = ""
    docs: str = ""
    phi: bool = False  # True: never echo `value` (names, header fields; D6)
    evaluate: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"rule": self.rule, "severity": self.severity, "path": self.path}
        if not self.phi and self.value is not None:
            out["value"] = self.value
        if self.allowed is not None:
            out["allowed"] = self.allowed
        out["message"] = self.message
        out["fix"] = self.fix
        out["docs"] = self.docs
        if self.evaluate:
            out["evaluate"] = True
        return out


def violation(rule: str, path: str, message: str, **kw: Any) -> Violation:
    spec = CATALOGUE.get(rule)
    kw.setdefault("fix", spec.fix if spec else "")
    return Violation(rule=rule, path=path, message=message, severity=spec.severity if spec else "error", docs=DOCS_BASE + rule, **kw)


def resolve_severity(v: Violation, rules: Mapping[str, Any]) -> Violation:
    """Apply the project's `severityOverrides` and evaluate mode (D5). A rule in evaluate mode keeps
    its would-be severity but is flagged so admission records and never rejects it, unless the
    project lists it under `enforce` (promoted)."""
    overrides = rules.get("severityOverrides") or {}
    if v.rule in overrides and overrides[v.rule] in SEVERITIES:
        v.severity = overrides[v.rule]
    spec = CATALOGUE.get(v.rule)
    v.evaluate = bool(spec and spec.evaluate and v.rule not in set(rules.get("enforce") or ()))
    return v


Family = Callable[[Mapping[str, Any], Mapping[str, Any]], list[Violation]]


def run_families(families: Iterable[Family], data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    out: list[Violation] = []
    for fam in families:
        out.extend(resolve_severity(v, rules) for v in fam(data, rules))
    return [v for v in out if v.severity != "off"]
