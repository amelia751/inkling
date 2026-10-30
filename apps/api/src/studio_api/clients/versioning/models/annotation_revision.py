from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.annotation_kind import AnnotationKind
from ..models.annotation_revision_schema_version import AnnotationRevisionSchemaVersion
from ..models.annotation_revision_status import AnnotationRevisionStatus
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.annotation_revision_geometry import AnnotationRevisionGeometry
  from ..models.annotation_revision_provenance import AnnotationRevisionProvenance
  from ..models.annotation_revision_calibration import AnnotationRevisionCalibration
  from ..models.annotation_revision_attributes import AnnotationRevisionAttributes





T = TypeVar("T", bound="AnnotationRevision")



@_attrs_define
class AnnotationRevision:
    """ Mirrors schemas/versioning/annotation-revision.schema.json.

        Attributes:
            schema_version (AnnotationRevisionSchemaVersion):
            annotation_id (str):
            sample_id (str):
            kind (AnnotationKind):
            class_id (str):
            ontology_rev (str):
            geometry (AnnotationRevisionGeometry):
            coordinate_frame (str):
            status (AnnotationRevisionStatus):
            provenance (AnnotationRevisionProvenance):
            calibration (AnnotationRevisionCalibration | Unset):
            confidence (float | Unset):
            reviewer_id (str | Unset):
            attributes (AnnotationRevisionAttributes | Unset):
     """

    schema_version: AnnotationRevisionSchemaVersion
    annotation_id: str
    sample_id: str
    kind: AnnotationKind
    class_id: str
    ontology_rev: str
    geometry: AnnotationRevisionGeometry
    coordinate_frame: str
    status: AnnotationRevisionStatus
    provenance: AnnotationRevisionProvenance
    calibration: AnnotationRevisionCalibration | Unset = UNSET
    confidence: float | Unset = UNSET
    reviewer_id: str | Unset = UNSET
    attributes: AnnotationRevisionAttributes | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.annotation_revision_geometry import AnnotationRevisionGeometry
        from ..models.annotation_revision_provenance import AnnotationRevisionProvenance
        from ..models.annotation_revision_calibration import AnnotationRevisionCalibration
        from ..models.annotation_revision_attributes import AnnotationRevisionAttributes
        schema_version = self.schema_version.value

        annotation_id = self.annotation_id

        sample_id = self.sample_id

        kind = self.kind.value

        class_id = self.class_id

        ontology_rev = self.ontology_rev

        geometry = self.geometry.to_dict()

        coordinate_frame = self.coordinate_frame

        status = self.status.value

        provenance = self.provenance.to_dict()

        calibration: dict[str, Any] | Unset = UNSET
        if not isinstance(self.calibration, Unset):
            calibration = self.calibration.to_dict()

        confidence = self.confidence

        reviewer_id = self.reviewer_id

        attributes: dict[str, Any] | Unset = UNSET
        if not isinstance(self.attributes, Unset):
            attributes = self.attributes.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "schema_version": schema_version,
            "annotation_id": annotation_id,
            "sample_id": sample_id,
            "kind": kind,
            "class_id": class_id,
            "ontology_rev": ontology_rev,
            "geometry": geometry,
            "coordinate_frame": coordinate_frame,
            "status": status,
            "provenance": provenance,
        })
        if calibration is not UNSET:
            field_dict["calibration"] = calibration
        if confidence is not UNSET:
            field_dict["confidence"] = confidence
        if reviewer_id is not UNSET:
            field_dict["reviewer_id"] = reviewer_id
        if attributes is not UNSET:
            field_dict["attributes"] = attributes

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.annotation_revision_geometry import AnnotationRevisionGeometry
        from ..models.annotation_revision_provenance import AnnotationRevisionProvenance
        from ..models.annotation_revision_calibration import AnnotationRevisionCalibration
        from ..models.annotation_revision_attributes import AnnotationRevisionAttributes
        d = dict(src_dict)
        schema_version = AnnotationRevisionSchemaVersion(d.pop("schema_version"))




        annotation_id = d.pop("annotation_id")

        sample_id = d.pop("sample_id")

        kind = AnnotationKind(d.pop("kind"))




        class_id = d.pop("class_id")

        ontology_rev = d.pop("ontology_rev")

        geometry = AnnotationRevisionGeometry.from_dict(d.pop("geometry"))




        coordinate_frame = d.pop("coordinate_frame")

        status = AnnotationRevisionStatus(d.pop("status"))




        provenance = AnnotationRevisionProvenance.from_dict(d.pop("provenance"))




        _calibration = d.pop("calibration", UNSET)
        calibration: AnnotationRevisionCalibration | Unset
        if isinstance(_calibration,  Unset):
            calibration = UNSET
        else:
            calibration = AnnotationRevisionCalibration.from_dict(_calibration)




        confidence = d.pop("confidence", UNSET)

        reviewer_id = d.pop("reviewer_id", UNSET)

        _attributes = d.pop("attributes", UNSET)
        attributes: AnnotationRevisionAttributes | Unset
        if isinstance(_attributes,  Unset):
            attributes = UNSET
        else:
            attributes = AnnotationRevisionAttributes.from_dict(_attributes)




        annotation_revision = cls(
            schema_version=schema_version,
            annotation_id=annotation_id,
            sample_id=sample_id,
            kind=kind,
            class_id=class_id,
            ontology_rev=ontology_rev,
            geometry=geometry,
            coordinate_frame=coordinate_frame,
            status=status,
            provenance=provenance,
            calibration=calibration,
            confidence=confidence,
            reviewer_id=reviewer_id,
            attributes=attributes,
        )


        annotation_revision.additional_properties = d
        return annotation_revision

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
