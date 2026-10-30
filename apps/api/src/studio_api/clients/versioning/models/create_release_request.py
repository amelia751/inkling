from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.create_release_request_retention_policy import CreateReleaseRequestRetentionPolicy
from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
import datetime






T = TypeVar("T", bound="CreateReleaseRequest")



@_attrs_define
class CreateReleaseRequest:
    """ 
        Attributes:
            tag (str):
            commit_oid (str):
            retention_policy (CreateReleaseRequestRetentionPolicy | Unset):
            retain_until (datetime.datetime | Unset):
     """

    tag: str
    commit_oid: str
    retention_policy: CreateReleaseRequestRetentionPolicy | Unset = UNSET
    retain_until: datetime.datetime | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        tag = self.tag

        commit_oid = self.commit_oid

        retention_policy: str | Unset = UNSET
        if not isinstance(self.retention_policy, Unset):
            retention_policy = self.retention_policy.value


        retain_until: str | Unset = UNSET
        if not isinstance(self.retain_until, Unset):
            retain_until = self.retain_until.isoformat()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "tag": tag,
            "commit_oid": commit_oid,
        })
        if retention_policy is not UNSET:
            field_dict["retention_policy"] = retention_policy
        if retain_until is not UNSET:
            field_dict["retain_until"] = retain_until

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        tag = d.pop("tag")

        commit_oid = d.pop("commit_oid")

        _retention_policy = d.pop("retention_policy", UNSET)
        retention_policy: CreateReleaseRequestRetentionPolicy | Unset
        if isinstance(_retention_policy,  Unset):
            retention_policy = UNSET
        else:
            retention_policy = CreateReleaseRequestRetentionPolicy(_retention_policy)




        _retain_until = d.pop("retain_until", UNSET)
        retain_until: datetime.datetime | Unset
        if isinstance(_retain_until,  Unset):
            retain_until = UNSET
        else:
            retain_until = isoparse(_retain_until)




        create_release_request = cls(
            tag=tag,
            commit_oid=commit_oid,
            retention_policy=retention_policy,
            retain_until=retain_until,
        )


        create_release_request.additional_properties = d
        return create_release_request

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
