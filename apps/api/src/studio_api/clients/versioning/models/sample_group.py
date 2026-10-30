from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset






T = TypeVar("T", bound="SampleGroup")



@_attrs_define
class SampleGroup:
    """ 
        Attributes:
            study_uid_hash (str | Unset):
            series_uid_hash (str | Unset):
            sequence (int | Unset):
     """

    study_uid_hash: str | Unset = UNSET
    series_uid_hash: str | Unset = UNSET
    sequence: int | Unset = UNSET





    def to_dict(self) -> dict[str, Any]:
        study_uid_hash = self.study_uid_hash

        series_uid_hash = self.series_uid_hash

        sequence = self.sequence


        field_dict: dict[str, Any] = {}

        field_dict.update({
        })
        if study_uid_hash is not UNSET:
            field_dict["study_uid_hash"] = study_uid_hash
        if series_uid_hash is not UNSET:
            field_dict["series_uid_hash"] = series_uid_hash
        if sequence is not UNSET:
            field_dict["sequence"] = sequence

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        study_uid_hash = d.pop("study_uid_hash", UNSET)

        series_uid_hash = d.pop("series_uid_hash", UNSET)

        sequence = d.pop("sequence", UNSET)

        sample_group = cls(
            study_uid_hash=study_uid_hash,
            series_uid_hash=series_uid_hash,
            sequence=sequence,
        )

        return sample_group

