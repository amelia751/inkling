from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset






T = TypeVar("T", bound="LegalHoldRequest")



@_attrs_define
class LegalHoldRequest:
    """ 
        Attributes:
            reason_code (str):
            artifact_sha256 (str | Unset):
     """

    reason_code: str
    artifact_sha256: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        reason_code = self.reason_code

        artifact_sha256 = self.artifact_sha256


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "reason_code": reason_code,
        })
        if artifact_sha256 is not UNSET:
            field_dict["artifact_sha256"] = artifact_sha256

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        reason_code = d.pop("reason_code")

        artifact_sha256 = d.pop("artifact_sha256", UNSET)

        legal_hold_request = cls(
            reason_code=reason_code,
            artifact_sha256=artifact_sha256,
        )


        legal_hold_request.additional_properties = d
        return legal_hold_request

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
