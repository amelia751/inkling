from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.diff_change_type import DiffChangeType
from ..types import UNSET, Unset
from typing import cast






T = TypeVar("T", bound="DiffChange")



@_attrs_define
class DiffChange:
    """ 
        Attributes:
            type_ (DiffChangeType):
            sample_id (str | Unset):
            annotation_id (str | Unset):
            class_id (str | Unset):
            kind (str | Unset):
            fields (list[str] | Unset):
            base_ref (str | Unset):
            head_ref (str | Unset):
            from_class_id (str | Unset):
            to_class_id (str | Unset):
     """

    type_: DiffChangeType
    sample_id: str | Unset = UNSET
    annotation_id: str | Unset = UNSET
    class_id: str | Unset = UNSET
    kind: str | Unset = UNSET
    fields: list[str] | Unset = UNSET
    base_ref: str | Unset = UNSET
    head_ref: str | Unset = UNSET
    from_class_id: str | Unset = UNSET
    to_class_id: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        sample_id = self.sample_id

        annotation_id = self.annotation_id

        class_id = self.class_id

        kind = self.kind

        fields: list[str] | Unset = UNSET
        if not isinstance(self.fields, Unset):
            fields = self.fields



        base_ref = self.base_ref

        head_ref = self.head_ref

        from_class_id = self.from_class_id

        to_class_id = self.to_class_id


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "type": type_,
        })
        if sample_id is not UNSET:
            field_dict["sample_id"] = sample_id
        if annotation_id is not UNSET:
            field_dict["annotation_id"] = annotation_id
        if class_id is not UNSET:
            field_dict["class_id"] = class_id
        if kind is not UNSET:
            field_dict["kind"] = kind
        if fields is not UNSET:
            field_dict["fields"] = fields
        if base_ref is not UNSET:
            field_dict["base_ref"] = base_ref
        if head_ref is not UNSET:
            field_dict["head_ref"] = head_ref
        if from_class_id is not UNSET:
            field_dict["from_class_id"] = from_class_id
        if to_class_id is not UNSET:
            field_dict["to_class_id"] = to_class_id

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = DiffChangeType(d.pop("type"))




        sample_id = d.pop("sample_id", UNSET)

        annotation_id = d.pop("annotation_id", UNSET)

        class_id = d.pop("class_id", UNSET)

        kind = d.pop("kind", UNSET)

        fields = cast(list[str], d.pop("fields", UNSET))


        base_ref = d.pop("base_ref", UNSET)

        head_ref = d.pop("head_ref", UNSET)

        from_class_id = d.pop("from_class_id", UNSET)

        to_class_id = d.pop("to_class_id", UNSET)

        diff_change = cls(
            type_=type_,
            sample_id=sample_id,
            annotation_id=annotation_id,
            class_id=class_id,
            kind=kind,
            fields=fields,
            base_ref=base_ref,
            head_ref=head_ref,
            from_class_id=from_class_id,
            to_class_id=to_class_id,
        )


        diff_change.additional_properties = d
        return diff_change

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
