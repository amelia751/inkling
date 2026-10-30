from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
import datetime






T = TypeVar("T", bound="Branch")



@_attrs_define
class Branch:
    """ 
        Attributes:
            name (str):
            commit_oid (str):
            generation (int):
            protected (bool):
            updated_at (datetime.datetime):
            deleted_at (datetime.datetime | Unset):
     """

    name: str
    commit_oid: str
    generation: int
    protected: bool
    updated_at: datetime.datetime
    deleted_at: datetime.datetime | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        name = self.name

        commit_oid = self.commit_oid

        generation = self.generation

        protected = self.protected

        updated_at = self.updated_at.isoformat()

        deleted_at: str | Unset = UNSET
        if not isinstance(self.deleted_at, Unset):
            deleted_at = self.deleted_at.isoformat()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "name": name,
            "commit_oid": commit_oid,
            "generation": generation,
            "protected": protected,
            "updated_at": updated_at,
        })
        if deleted_at is not UNSET:
            field_dict["deleted_at"] = deleted_at

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        commit_oid = d.pop("commit_oid")

        generation = d.pop("generation")

        protected = d.pop("protected")

        updated_at = isoparse(d.pop("updated_at"))




        _deleted_at = d.pop("deleted_at", UNSET)
        deleted_at: datetime.datetime | Unset
        if isinstance(_deleted_at,  Unset):
            deleted_at = UNSET
        else:
            deleted_at = isoparse(_deleted_at)




        branch = cls(
            name=name,
            commit_oid=commit_oid,
            generation=generation,
            protected=protected,
            updated_at=updated_at,
            deleted_at=deleted_at,
        )


        branch.additional_properties = d
        return branch

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
