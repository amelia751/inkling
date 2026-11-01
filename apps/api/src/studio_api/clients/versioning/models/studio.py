from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.studio_files import StudioFiles





T = TypeVar("T", bound="Studio")



@_attrs_define
class Studio:
    """ 
        Attributes:
            commit_oid (str):
            files (StudioFiles):
            studio_tree (str | Unset):
     """

    commit_oid: str
    files: StudioFiles
    studio_tree: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.studio_files import StudioFiles
        commit_oid = self.commit_oid

        files = self.files.to_dict()

        studio_tree = self.studio_tree


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "commit_oid": commit_oid,
            "files": files,
        })
        if studio_tree is not UNSET:
            field_dict["studio_tree"] = studio_tree

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.studio_files import StudioFiles
        d = dict(src_dict)
        commit_oid = d.pop("commit_oid")

        files = StudioFiles.from_dict(d.pop("files"))




        studio_tree = d.pop("studio_tree", UNSET)

        studio = cls(
            commit_oid=commit_oid,
            files=files,
            studio_tree=studio_tree,
        )


        studio.additional_properties = d
        return studio

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
