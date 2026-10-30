from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
import datetime

if TYPE_CHECKING:
  from ..models.manifest_annotation import ManifestAnnotation
  from ..models.ontology import Ontology
  from ..models.signed_object import SignedObject
  from ..models.sample import Sample





T = TypeVar("T", bound="Checkout")



@_attrs_define
class Checkout:
    """ 
        Attributes:
            commit_oid (str):
            manifest_root (str):
            ontology (Ontology):
            samples (list[Sample]):
            annotations (list[ManifestAnnotation]):
            objects (list[SignedObject]):
            expires_at (datetime.datetime):
            buckets_read (int):
            next_cursor (str | Unset):
     """

    commit_oid: str
    manifest_root: str
    ontology: Ontology
    samples: list[Sample]
    annotations: list[ManifestAnnotation]
    objects: list[SignedObject]
    expires_at: datetime.datetime
    buckets_read: int
    next_cursor: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.manifest_annotation import ManifestAnnotation
        from ..models.ontology import Ontology
        from ..models.signed_object import SignedObject
        from ..models.sample import Sample
        commit_oid = self.commit_oid

        manifest_root = self.manifest_root

        ontology = self.ontology.to_dict()

        samples = []
        for samples_item_data in self.samples:
            samples_item = samples_item_data.to_dict()
            samples.append(samples_item)



        annotations = []
        for annotations_item_data in self.annotations:
            annotations_item = annotations_item_data.to_dict()
            annotations.append(annotations_item)



        objects = []
        for objects_item_data in self.objects:
            objects_item = objects_item_data.to_dict()
            objects.append(objects_item)



        expires_at = self.expires_at.isoformat()

        buckets_read = self.buckets_read

        next_cursor = self.next_cursor


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "commit_oid": commit_oid,
            "manifest_root": manifest_root,
            "ontology": ontology,
            "samples": samples,
            "annotations": annotations,
            "objects": objects,
            "expires_at": expires_at,
            "buckets_read": buckets_read,
        })
        if next_cursor is not UNSET:
            field_dict["next_cursor"] = next_cursor

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.manifest_annotation import ManifestAnnotation
        from ..models.ontology import Ontology
        from ..models.signed_object import SignedObject
        from ..models.sample import Sample
        d = dict(src_dict)
        commit_oid = d.pop("commit_oid")

        manifest_root = d.pop("manifest_root")

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


        objects = []
        _objects = d.pop("objects")
        for objects_item_data in (_objects):
            objects_item = SignedObject.from_dict(objects_item_data)



            objects.append(objects_item)


        expires_at = isoparse(d.pop("expires_at"))




        buckets_read = d.pop("buckets_read")

        next_cursor = d.pop("next_cursor", UNSET)

        checkout = cls(
            commit_oid=commit_oid,
            manifest_root=manifest_root,
            ontology=ontology,
            samples=samples,
            annotations=annotations,
            objects=objects,
            expires_at=expires_at,
            buckets_read=buckets_read,
            next_cursor=next_cursor,
        )


        checkout.additional_properties = d
        return checkout

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
