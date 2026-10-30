from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.resolution_choice import ResolutionChoice
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.resolution_custom import ResolutionCustom





T = TypeVar("T", bound="Resolution")



@_attrs_define
class Resolution:
    """ 
        Attributes:
            conflict_key (str):
            choice (ResolutionChoice):
            custom (ResolutionCustom | Unset):
     """

    conflict_key: str
    choice: ResolutionChoice
    custom: ResolutionCustom | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.resolution_custom import ResolutionCustom
        conflict_key = self.conflict_key

        choice = self.choice.value

        custom: dict[str, Any] | Unset = UNSET
        if not isinstance(self.custom, Unset):
            custom = self.custom.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "conflict_key": conflict_key,
            "choice": choice,
        })
        if custom is not UNSET:
            field_dict["custom"] = custom

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.resolution_custom import ResolutionCustom
        d = dict(src_dict)
        conflict_key = d.pop("conflict_key")

        choice = ResolutionChoice(d.pop("choice"))




        _custom = d.pop("custom", UNSET)
        custom: ResolutionCustom | Unset
        if isinstance(_custom,  Unset):
            custom = UNSET
        else:
            custom = ResolutionCustom.from_dict(_custom)




        resolution = cls(
            conflict_key=conflict_key,
            choice=choice,
            custom=custom,
        )


        resolution.additional_properties = d
        return resolution

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
