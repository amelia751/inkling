from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.merge_conflict_resolution import MergeConflictResolution





T = TypeVar("T", bound="MergeConflict")



@_attrs_define
class MergeConflict:
    """ 
        Attributes:
            conflict_key (str):
            kind (str):
            sample_id (str | Unset):
            annotation_id (str | Unset):
            field (str | Unset):
            base_ref (str | Unset):
            ours_ref (str | Unset):
            theirs_ref (str | Unset):
            resolution (MergeConflictResolution | Unset):
     """

    conflict_key: str
    kind: str
    sample_id: str | Unset = UNSET
    annotation_id: str | Unset = UNSET
    field: str | Unset = UNSET
    base_ref: str | Unset = UNSET
    ours_ref: str | Unset = UNSET
    theirs_ref: str | Unset = UNSET
    resolution: MergeConflictResolution | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.merge_conflict_resolution import MergeConflictResolution
        conflict_key = self.conflict_key

        kind = self.kind

        sample_id = self.sample_id

        annotation_id = self.annotation_id

        field = self.field

        base_ref = self.base_ref

        ours_ref = self.ours_ref

        theirs_ref = self.theirs_ref

        resolution: dict[str, Any] | Unset = UNSET
        if not isinstance(self.resolution, Unset):
            resolution = self.resolution.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "conflict_key": conflict_key,
            "kind": kind,
        })
        if sample_id is not UNSET:
            field_dict["sample_id"] = sample_id
        if annotation_id is not UNSET:
            field_dict["annotation_id"] = annotation_id
        if field is not UNSET:
            field_dict["field"] = field
        if base_ref is not UNSET:
            field_dict["base_ref"] = base_ref
        if ours_ref is not UNSET:
            field_dict["ours_ref"] = ours_ref
        if theirs_ref is not UNSET:
            field_dict["theirs_ref"] = theirs_ref
        if resolution is not UNSET:
            field_dict["resolution"] = resolution

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.merge_conflict_resolution import MergeConflictResolution
        d = dict(src_dict)
        conflict_key = d.pop("conflict_key")

        kind = d.pop("kind")

        sample_id = d.pop("sample_id", UNSET)

        annotation_id = d.pop("annotation_id", UNSET)

        field = d.pop("field", UNSET)

        base_ref = d.pop("base_ref", UNSET)

        ours_ref = d.pop("ours_ref", UNSET)

        theirs_ref = d.pop("theirs_ref", UNSET)

        _resolution = d.pop("resolution", UNSET)
        resolution: MergeConflictResolution | Unset
        if isinstance(_resolution,  Unset):
            resolution = UNSET
        else:
            resolution = MergeConflictResolution.from_dict(_resolution)




        merge_conflict = cls(
            conflict_key=conflict_key,
            kind=kind,
            sample_id=sample_id,
            annotation_id=annotation_id,
            field=field,
            base_ref=base_ref,
            ours_ref=ours_ref,
            theirs_ref=theirs_ref,
            resolution=resolution,
        )


        merge_conflict.additional_properties = d
        return merge_conflict

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
