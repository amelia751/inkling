from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset






T = TypeVar("T", bound="RevertRequest")



@_attrs_define
class RevertRequest:
    """ 
        Attributes:
            branch (str):
            expected_head (str):
            target_oid (str):
            idempotency_key (str):
            message (str | Unset):
     """

    branch: str
    expected_head: str
    target_oid: str
    idempotency_key: str
    message: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        branch = self.branch

        expected_head = self.expected_head

        target_oid = self.target_oid

        idempotency_key = self.idempotency_key

        message = self.message


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "branch": branch,
            "expected_head": expected_head,
            "target_oid": target_oid,
            "idempotency_key": idempotency_key,
        })
        if message is not UNSET:
            field_dict["message"] = message

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        branch = d.pop("branch")

        expected_head = d.pop("expected_head")

        target_oid = d.pop("target_oid")

        idempotency_key = d.pop("idempotency_key")

        message = d.pop("message", UNSET)

        revert_request = cls(
            branch=branch,
            expected_head=expected_head,
            target_oid=target_oid,
            idempotency_key=idempotency_key,
            message=message,
        )


        revert_request.additional_properties = d
        return revert_request

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
