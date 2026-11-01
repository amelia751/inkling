from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.commit_operation import CommitOperation
from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
import datetime






T = TypeVar("T", bound="Commit")



@_attrs_define
class Commit:
    """ 
        Attributes:
            oid (str):
            parents (list[str]):
            manifest_root (str):
            author_id (str):
            message (str):
            operation (CommitOperation):
            created_at (datetime.datetime):
            manifest_format (str | Unset):
            sample_count (int | Unset):
            annotation_count (int | Unset):
            on_behalf_of (str | Unset):
            studio_tree (str | Unset): Git tree id of the commit's .studio/ subtree (todo10 §3.2)
     """

    oid: str
    parents: list[str]
    manifest_root: str
    author_id: str
    message: str
    operation: CommitOperation
    created_at: datetime.datetime
    manifest_format: str | Unset = UNSET
    sample_count: int | Unset = UNSET
    annotation_count: int | Unset = UNSET
    on_behalf_of: str | Unset = UNSET
    studio_tree: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        oid = self.oid

        parents = self.parents



        manifest_root = self.manifest_root

        author_id = self.author_id

        message = self.message

        operation = self.operation.value

        created_at = self.created_at.isoformat()

        manifest_format = self.manifest_format

        sample_count = self.sample_count

        annotation_count = self.annotation_count

        on_behalf_of = self.on_behalf_of

        studio_tree = self.studio_tree


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "oid": oid,
            "parents": parents,
            "manifest_root": manifest_root,
            "author_id": author_id,
            "message": message,
            "operation": operation,
            "created_at": created_at,
        })
        if manifest_format is not UNSET:
            field_dict["manifest_format"] = manifest_format
        if sample_count is not UNSET:
            field_dict["sample_count"] = sample_count
        if annotation_count is not UNSET:
            field_dict["annotation_count"] = annotation_count
        if on_behalf_of is not UNSET:
            field_dict["on_behalf_of"] = on_behalf_of
        if studio_tree is not UNSET:
            field_dict["studio_tree"] = studio_tree

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        oid = d.pop("oid")

        parents = cast(list[str], d.pop("parents"))


        manifest_root = d.pop("manifest_root")

        author_id = d.pop("author_id")

        message = d.pop("message")

        operation = CommitOperation(d.pop("operation"))




        created_at = isoparse(d.pop("created_at"))




        manifest_format = d.pop("manifest_format", UNSET)

        sample_count = d.pop("sample_count", UNSET)

        annotation_count = d.pop("annotation_count", UNSET)

        on_behalf_of = d.pop("on_behalf_of", UNSET)

        studio_tree = d.pop("studio_tree", UNSET)

        commit = cls(
            oid=oid,
            parents=parents,
            manifest_root=manifest_root,
            author_id=author_id,
            message=message,
            operation=operation,
            created_at=created_at,
            manifest_format=manifest_format,
            sample_count=sample_count,
            annotation_count=annotation_count,
            on_behalf_of=on_behalf_of,
            studio_tree=studio_tree,
        )


        commit.additional_properties = d
        return commit

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
