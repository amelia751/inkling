from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset







T = TypeVar("T", bound="CommitResult")



@_attrs_define
class CommitResult:
    """ 
        Attributes:
            commit_oid (str):
            branch (str):
            head_generation (int):
            manifest_root (str):
            request_id (str):
     """

    commit_oid: str
    branch: str
    head_generation: int
    manifest_root: str
    request_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        commit_oid = self.commit_oid

        branch = self.branch

        head_generation = self.head_generation

        manifest_root = self.manifest_root

        request_id = self.request_id


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "commit_oid": commit_oid,
            "branch": branch,
            "head_generation": head_generation,
            "manifest_root": manifest_root,
            "request_id": request_id,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        commit_oid = d.pop("commit_oid")

        branch = d.pop("branch")

        head_generation = d.pop("head_generation")

        manifest_root = d.pop("manifest_root")

        request_id = d.pop("request_id")

        commit_result = cls(
            commit_oid=commit_oid,
            branch=branch,
            head_generation=head_generation,
            manifest_root=manifest_root,
            request_id=request_id,
        )


        commit_result.additional_properties = d
        return commit_result

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
