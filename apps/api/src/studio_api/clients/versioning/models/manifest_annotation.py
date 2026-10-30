from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.annotation_kind import AnnotationKind






T = TypeVar("T", bound="ManifestAnnotation")



@_attrs_define
class ManifestAnnotation:
    """ 
        Attributes:
            annotation_id (str):
            revision_id (str):
            sample_id (str):
            kind (AnnotationKind):
            class_id (str):
            ontology_rev (str):
            ref (str):
     """

    annotation_id: str
    revision_id: str
    sample_id: str
    kind: AnnotationKind
    class_id: str
    ontology_rev: str
    ref: str





    def to_dict(self) -> dict[str, Any]:
        annotation_id = self.annotation_id

        revision_id = self.revision_id

        sample_id = self.sample_id

        kind = self.kind.value

        class_id = self.class_id

        ontology_rev = self.ontology_rev

        ref = self.ref


        field_dict: dict[str, Any] = {}

        field_dict.update({
            "annotation_id": annotation_id,
            "revision_id": revision_id,
            "sample_id": sample_id,
            "kind": kind,
            "class_id": class_id,
            "ontology_rev": ontology_rev,
            "ref": ref,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        annotation_id = d.pop("annotation_id")

        revision_id = d.pop("revision_id")

        sample_id = d.pop("sample_id")

        kind = AnnotationKind(d.pop("kind"))




        class_id = d.pop("class_id")

        ontology_rev = d.pop("ontology_rev")

        ref = d.pop("ref")

        manifest_annotation = cls(
            annotation_id=annotation_id,
            revision_id=revision_id,
            sample_id=sample_id,
            kind=kind,
            class_id=class_id,
            ontology_rev=ontology_rev,
            ref=ref,
        )

        return manifest_annotation

