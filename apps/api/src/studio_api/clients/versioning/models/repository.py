from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.repository_object_format import RepositoryObjectFormat
from dateutil.parser import isoparse
from typing import cast
from uuid import UUID
import datetime






T = TypeVar("T", bound="Repository")



@_attrs_define
class Repository:
    """ 
        Attributes:
            id (UUID):
            tenant_id (UUID):
            project_id (UUID):
            name (str):
            default_branch (str):
            policy_id (str):
            object_format (RepositoryObjectFormat):
            head (str):
            head_generation (int):
            created_at (datetime.datetime):
     """

    id: UUID
    tenant_id: UUID
    project_id: UUID
    name: str
    default_branch: str
    policy_id: str
    object_format: RepositoryObjectFormat
    head: str
    head_generation: int
    created_at: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        tenant_id = str(self.tenant_id)

        project_id = str(self.project_id)

        name = self.name

        default_branch = self.default_branch

        policy_id = self.policy_id

        object_format = self.object_format.value

        head = self.head

        head_generation = self.head_generation

        created_at = self.created_at.isoformat()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "id": id,
            "tenant_id": tenant_id,
            "project_id": project_id,
            "name": name,
            "default_branch": default_branch,
            "policy_id": policy_id,
            "object_format": object_format,
            "head": head,
            "head_generation": head_generation,
            "created_at": created_at,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))




        tenant_id = UUID(d.pop("tenant_id"))




        project_id = UUID(d.pop("project_id"))




        name = d.pop("name")

        default_branch = d.pop("default_branch")

        policy_id = d.pop("policy_id")

        object_format = RepositoryObjectFormat(d.pop("object_format"))




        head = d.pop("head")

        head_generation = d.pop("head_generation")

        created_at = isoparse(d.pop("created_at"))




        repository = cls(
            id=id,
            tenant_id=tenant_id,
            project_id=project_id,
            name=name,
            default_branch=default_branch,
            policy_id=policy_id,
            object_format=object_format,
            head=head,
            head_generation=head_generation,
            created_at=created_at,
        )


        repository.additional_properties = d
        return repository

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
