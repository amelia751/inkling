from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
from uuid import UUID
import datetime






T = TypeVar("T", bound="Comment")



@_attrs_define
class Comment:
    """ 
        Attributes:
            id (UUID):
            author_id (str):
            source_oid (str):
            body (str):
            created_at (datetime.datetime):
            sample_id (str | Unset):
            annotation_id (str | Unset):
     """

    id: UUID
    author_id: str
    source_oid: str
    body: str
    created_at: datetime.datetime
    sample_id: str | Unset = UNSET
    annotation_id: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        author_id = self.author_id

        source_oid = self.source_oid

        body = self.body

        created_at = self.created_at.isoformat()

        sample_id = self.sample_id

        annotation_id = self.annotation_id


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "id": id,
            "author_id": author_id,
            "source_oid": source_oid,
            "body": body,
            "created_at": created_at,
        })
        if sample_id is not UNSET:
            field_dict["sample_id"] = sample_id
        if annotation_id is not UNSET:
            field_dict["annotation_id"] = annotation_id

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))




        author_id = d.pop("author_id")

        source_oid = d.pop("source_oid")

        body = d.pop("body")

        created_at = isoparse(d.pop("created_at"))




        sample_id = d.pop("sample_id", UNSET)

        annotation_id = d.pop("annotation_id", UNSET)

        comment = cls(
            id=id,
            author_id=author_id,
            source_oid=source_oid,
            body=body,
            created_at=created_at,
            sample_id=sample_id,
            annotation_id=annotation_id,
        )


        comment.additional_properties = d
        return comment

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
