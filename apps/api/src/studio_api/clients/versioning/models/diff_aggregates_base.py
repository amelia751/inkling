from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset






T = TypeVar("T", bound="DiffAggregatesBase")



@_attrs_define
class DiffAggregatesBase:
    """ 
        Attributes:
            samples (int | Unset):
            annotations (int | Unset):
     """

    samples: int | Unset = UNSET
    annotations: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        samples = self.samples

        annotations = self.annotations


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
        })
        if samples is not UNSET:
            field_dict["samples"] = samples
        if annotations is not UNSET:
            field_dict["annotations"] = annotations

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        samples = d.pop("samples", UNSET)

        annotations = d.pop("annotations", UNSET)

        diff_aggregates_base = cls(
            samples=samples,
            annotations=annotations,
        )


        diff_aggregates_base.additional_properties = d
        return diff_aggregates_base

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
