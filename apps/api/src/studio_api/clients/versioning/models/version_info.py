from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset







T = TypeVar("T", bound="VersionInfo")



@_attrs_define
class VersionInfo:
    """ 
        Attributes:
            git_sha (str):
            git_library (str):
            schema_version (int):
     """

    git_sha: str
    git_library: str
    schema_version: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        git_sha = self.git_sha

        git_library = self.git_library

        schema_version = self.schema_version


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "git_sha": git_sha,
            "git_library": git_library,
            "schema_version": schema_version,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        git_sha = d.pop("git_sha")

        git_library = d.pop("git_library")

        schema_version = d.pop("schema_version")

        version_info = cls(
            git_sha=git_sha,
            git_library=git_library,
            schema_version=schema_version,
        )


        version_info.additional_properties = d
        return version_info

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
