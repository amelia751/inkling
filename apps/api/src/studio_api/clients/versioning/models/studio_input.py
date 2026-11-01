from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
  from ..models.studio_input_files import StudioInputFiles





T = TypeVar("T", bound="StudioInput")



@_attrs_define
class StudioInput:
    """ Replaces the commit's whole `.studio/` tree (empty `files` removes it); omitted, the commit keeps its parent's. JSON
    files must be RFC 8785 canonical.

        Attributes:
            files (StudioInputFiles): plugins.lock.json, tasks/<taskId>/environment.json, tasks/<taskId>/README.md → file
                text
     """

    files: StudioInputFiles
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.studio_input_files import StudioInputFiles
        files = self.files.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "files": files,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.studio_input_files import StudioInputFiles
        d = dict(src_dict)
        files = StudioInputFiles.from_dict(d.pop("files"))




        studio_input = cls(
            files=files,
        )


        studio_input.additional_properties = d
        return studio_input

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
