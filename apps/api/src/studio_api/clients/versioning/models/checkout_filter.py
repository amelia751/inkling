from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast






T = TypeVar("T", bound="CheckoutFilter")



@_attrs_define
class CheckoutFilter:
    """ 
        Attributes:
            sample_ids (list[str] | Unset):
            splits (list[str] | Unset):
            study_uid_hashes (list[str] | Unset):
     """

    sample_ids: list[str] | Unset = UNSET
    splits: list[str] | Unset = UNSET
    study_uid_hashes: list[str] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        sample_ids: list[str] | Unset = UNSET
        if not isinstance(self.sample_ids, Unset):
            sample_ids = self.sample_ids



        splits: list[str] | Unset = UNSET
        if not isinstance(self.splits, Unset):
            splits = self.splits



        study_uid_hashes: list[str] | Unset = UNSET
        if not isinstance(self.study_uid_hashes, Unset):
            study_uid_hashes = self.study_uid_hashes




        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
        })
        if sample_ids is not UNSET:
            field_dict["sample_ids"] = sample_ids
        if splits is not UNSET:
            field_dict["splits"] = splits
        if study_uid_hashes is not UNSET:
            field_dict["study_uid_hashes"] = study_uid_hashes

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sample_ids = cast(list[str], d.pop("sample_ids", UNSET))


        splits = cast(list[str], d.pop("splits", UNSET))


        study_uid_hashes = cast(list[str], d.pop("study_uid_hashes", UNSET))


        checkout_filter = cls(
            sample_ids=sample_ids,
            splits=splits,
            study_uid_hashes=study_uid_hashes,
        )


        checkout_filter.additional_properties = d
        return checkout_filter

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
