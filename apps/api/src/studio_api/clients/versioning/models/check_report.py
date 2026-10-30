from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.check_report_outcome import CheckReportOutcome
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.check_report_details import CheckReportDetails





T = TypeVar("T", bound="CheckReport")



@_attrs_define
class CheckReport:
    """ 
        Attributes:
            source_oid (str):
            target_oid (str):
            outcome (CheckReportOutcome):
            details (CheckReportDetails | Unset):
     """

    source_oid: str
    target_oid: str
    outcome: CheckReportOutcome
    details: CheckReportDetails | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.check_report_details import CheckReportDetails
        source_oid = self.source_oid

        target_oid = self.target_oid

        outcome = self.outcome.value

        details: dict[str, Any] | Unset = UNSET
        if not isinstance(self.details, Unset):
            details = self.details.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "source_oid": source_oid,
            "target_oid": target_oid,
            "outcome": outcome,
        })
        if details is not UNSET:
            field_dict["details"] = details

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.check_report_details import CheckReportDetails
        d = dict(src_dict)
        source_oid = d.pop("source_oid")

        target_oid = d.pop("target_oid")

        outcome = CheckReportOutcome(d.pop("outcome"))




        _details = d.pop("details", UNSET)
        details: CheckReportDetails | Unset
        if isinstance(_details,  Unset):
            details = UNSET
        else:
            details = CheckReportDetails.from_dict(_details)




        check_report = cls(
            source_oid=source_oid,
            target_oid=target_oid,
            outcome=outcome,
            details=details,
        )


        check_report.additional_properties = d
        return check_report

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
