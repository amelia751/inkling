from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset






T = TypeVar("T", bound="CreateRepoRequest")



@_attrs_define
class CreateRepoRequest:
    """ 
        Attributes:
            name (str):
            policy_id (str | Unset):
            required_approvals (int | Unset):
     """

    name: str
    policy_id: str | Unset = UNSET
    required_approvals: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        name = self.name

        policy_id = self.policy_id

        required_approvals = self.required_approvals


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "name": name,
        })
        if policy_id is not UNSET:
            field_dict["policy_id"] = policy_id
        if required_approvals is not UNSET:
            field_dict["required_approvals"] = required_approvals

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        policy_id = d.pop("policy_id", UNSET)

        required_approvals = d.pop("required_approvals", UNSET)

        create_repo_request = cls(
            name=name,
            policy_id=policy_id,
            required_approvals=required_approvals,
        )


        create_repo_request.additional_properties = d
        return create_repo_request

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
