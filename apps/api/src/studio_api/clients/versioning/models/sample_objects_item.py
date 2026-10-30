from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset







T = TypeVar("T", bound="SampleObjectsItem")



@_attrs_define
class SampleObjectsItem:
    """ 
        Attributes:
            role (str):
            sha256 (str):
            size_bytes (int):
            media_type (str):
     """

    role: str
    sha256: str
    size_bytes: int
    media_type: str





    def to_dict(self) -> dict[str, Any]:
        role = self.role

        sha256 = self.sha256

        size_bytes = self.size_bytes

        media_type = self.media_type


        field_dict: dict[str, Any] = {}

        field_dict.update({
            "role": role,
            "sha256": sha256,
            "size_bytes": size_bytes,
            "media_type": media_type,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        role = d.pop("role")

        sha256 = d.pop("sha256")

        size_bytes = d.pop("size_bytes")

        media_type = d.pop("media_type")

        sample_objects_item = cls(
            role=role,
            sha256=sha256,
            size_bytes=size_bytes,
            media_type=media_type,
        )

        return sample_objects_item

