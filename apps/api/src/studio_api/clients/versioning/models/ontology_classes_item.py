from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast






T = TypeVar("T", bound="OntologyClassesItem")



@_attrs_define
class OntologyClassesItem:
    """ 
        Attributes:
            class_id (str):
            name (str):
            required_fields (list[str] | Unset):
     """

    class_id: str
    name: str
    required_fields: list[str] | Unset = UNSET





    def to_dict(self) -> dict[str, Any]:
        class_id = self.class_id

        name = self.name

        required_fields: list[str] | Unset = UNSET
        if not isinstance(self.required_fields, Unset):
            required_fields = self.required_fields




        field_dict: dict[str, Any] = {}

        field_dict.update({
            "class_id": class_id,
            "name": name,
        })
        if required_fields is not UNSET:
            field_dict["required_fields"] = required_fields

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        class_id = d.pop("class_id")

        name = d.pop("name")

        required_fields = cast(list[str], d.pop("required_fields", UNSET))


        ontology_classes_item = cls(
            class_id=class_id,
            name=name,
            required_fields=required_fields,
        )

        return ontology_classes_item

