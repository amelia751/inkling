from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.review_check_outcome import ReviewCheckOutcome
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.review_check_details import ReviewCheckDetails





T = TypeVar("T", bound="ReviewCheck")



@_attrs_define
class ReviewCheck:
    """ 
        Attributes:
            name (str):
            mandatory (bool):
            outcome (ReviewCheckOutcome):
            source_oid (str):
            target_oid (str):
            details (ReviewCheckDetails | Unset):
     """

    name: str
    mandatory: bool
    outcome: ReviewCheckOutcome
    source_oid: str
    target_oid: str
    details: ReviewCheckDetails | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.review_check_details import ReviewCheckDetails
        name = self.name

        mandatory = self.mandatory

        outcome = self.outcome.value

        source_oid = self.source_oid

        target_oid = self.target_oid

        details: dict[str, Any] | Unset = UNSET
        if not isinstance(self.details, Unset):
            details = self.details.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "name": name,
            "mandatory": mandatory,
            "outcome": outcome,
            "source_oid": source_oid,
            "target_oid": target_oid,
        })
        if details is not UNSET:
            field_dict["details"] = details

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.review_check_details import ReviewCheckDetails
        d = dict(src_dict)
        name = d.pop("name")

        mandatory = d.pop("mandatory")

        outcome = ReviewCheckOutcome(d.pop("outcome"))




        source_oid = d.pop("source_oid")

        target_oid = d.pop("target_oid")

        _details = d.pop("details", UNSET)
        details: ReviewCheckDetails | Unset
        if isinstance(_details,  Unset):
            details = UNSET
        else:
            details = ReviewCheckDetails.from_dict(_details)




        review_check = cls(
            name=name,
            mandatory=mandatory,
            outcome=outcome,
            source_oid=source_oid,
            target_oid=target_oid,
            details=details,
        )


        review_check.additional_properties = d
        return review_check

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
