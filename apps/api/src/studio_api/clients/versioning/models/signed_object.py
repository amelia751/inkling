from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.signed_object_status import SignedObjectStatus
from ..types import UNSET, Unset






T = TypeVar("T", bound="SignedObject")



@_attrs_define
class SignedObject:
    """ 
        Attributes:
            sha256 (str):
            size_bytes (int):
            status (SignedObjectStatus):
            url (str | Unset):
     """

    sha256: str
    size_bytes: int
    status: SignedObjectStatus
    url: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        sha256 = self.sha256

        size_bytes = self.size_bytes

        status = self.status.value

        url = self.url


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "sha256": sha256,
            "size_bytes": size_bytes,
            "status": status,
        })
        if url is not UNSET:
            field_dict["url"] = url

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sha256 = d.pop("sha256")

        size_bytes = d.pop("size_bytes")

        status = SignedObjectStatus(d.pop("status"))




        url = d.pop("url", UNSET)

        signed_object = cls(
            sha256=sha256,
            size_bytes=size_bytes,
            status=status,
            url=url,
        )


        signed_object.additional_properties = d
        return signed_object

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
