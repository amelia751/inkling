from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.manifest_root_format import ManifestRootFormat






T = TypeVar("T", bound="ManifestRoot")



@_attrs_define
class ManifestRoot:
    """ 
        Attributes:
            manifest_root (str):
            format_ (ManifestRootFormat):
            sample_count (int):
            annotation_count (int):
     """

    manifest_root: str
    format_: ManifestRootFormat
    sample_count: int
    annotation_count: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        manifest_root = self.manifest_root

        format_ = self.format_.value

        sample_count = self.sample_count

        annotation_count = self.annotation_count


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "manifest_root": manifest_root,
            "format": format_,
            "sample_count": sample_count,
            "annotation_count": annotation_count,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        manifest_root = d.pop("manifest_root")

        format_ = ManifestRootFormat(d.pop("format"))




        sample_count = d.pop("sample_count")

        annotation_count = d.pop("annotation_count")

        manifest_root = cls(
            manifest_root=manifest_root,
            format_=format_,
            sample_count=sample_count,
            annotation_count=annotation_count,
        )


        manifest_root.additional_properties = d
        return manifest_root

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
