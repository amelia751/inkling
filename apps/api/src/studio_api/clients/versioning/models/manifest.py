from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.manifest_schema_version import ManifestSchemaVersion
from typing import cast

if TYPE_CHECKING:
  from ..models.manifest_annotation import ManifestAnnotation
  from ..models.ontology import Ontology
  from ..models.sample import Sample





T = TypeVar("T", bound="Manifest")



@_attrs_define
class Manifest:
    """ 
        Attributes:
            schema_version (ManifestSchemaVersion):
            ontology (Ontology):
            samples (list[Sample]):
            annotations (list[ManifestAnnotation]):
     """

    schema_version: ManifestSchemaVersion
    ontology: Ontology
    samples: list[Sample]
    annotations: list[ManifestAnnotation]





    def to_dict(self) -> dict[str, Any]:
        from ..models.manifest_annotation import ManifestAnnotation
        from ..models.ontology import Ontology
        from ..models.sample import Sample
        schema_version = self.schema_version.value

        ontology = self.ontology.to_dict()

        samples = []
        for samples_item_data in self.samples:
            samples_item = samples_item_data.to_dict()
            samples.append(samples_item)



        annotations = []
        for annotations_item_data in self.annotations:
            annotations_item = annotations_item_data.to_dict()
            annotations.append(annotations_item)




        field_dict: dict[str, Any] = {}

        field_dict.update({
            "schema_version": schema_version,
            "ontology": ontology,
            "samples": samples,
            "annotations": annotations,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.manifest_annotation import ManifestAnnotation
        from ..models.ontology import Ontology
        from ..models.sample import Sample
        d = dict(src_dict)
        schema_version = ManifestSchemaVersion(d.pop("schema_version"))




        ontology = Ontology.from_dict(d.pop("ontology"))




        samples = []
        _samples = d.pop("samples")
        for samples_item_data in (_samples):
            samples_item = Sample.from_dict(samples_item_data)



            samples.append(samples_item)


        annotations = []
        _annotations = d.pop("annotations")
        for annotations_item_data in (_annotations):
            annotations_item = ManifestAnnotation.from_dict(annotations_item_data)



            annotations.append(annotations_item)


        manifest = cls(
            schema_version=schema_version,
            ontology=ontology,
            samples=samples,
            annotations=annotations,
        )

        return manifest

