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






T = TypeVar("T", bound="ReviewApproval")



@_attrs_define
class ReviewApproval:
    """ 
        Attributes:
            id (UUID): Stable per (reviewer, source, target); the pipeline's PublishWorkflow id.
            reviewer_id (str):
            approved_source_oid (str):
            created_at (datetime.datetime):
            approved_target_oid (str | Unset): The target head the review was checked against when approved.
            candidate_digest (str | Unset):
     """

    id: UUID
    reviewer_id: str
    approved_source_oid: str
    created_at: datetime.datetime
    approved_target_oid: str | Unset = UNSET
    candidate_digest: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        reviewer_id = self.reviewer_id

        approved_source_oid = self.approved_source_oid

        created_at = self.created_at.isoformat()

        approved_target_oid = self.approved_target_oid

        candidate_digest = self.candidate_digest


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "id": id,
            "reviewer_id": reviewer_id,
            "approved_source_oid": approved_source_oid,
            "created_at": created_at,
        })
        if approved_target_oid is not UNSET:
            field_dict["approved_target_oid"] = approved_target_oid
        if candidate_digest is not UNSET:
            field_dict["candidate_digest"] = candidate_digest

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))




        reviewer_id = d.pop("reviewer_id")

        approved_source_oid = d.pop("approved_source_oid")

        created_at = isoparse(d.pop("created_at"))




        approved_target_oid = d.pop("approved_target_oid", UNSET)

        candidate_digest = d.pop("candidate_digest", UNSET)

        review_approval = cls(
            id=id,
            reviewer_id=reviewer_id,
            approved_source_oid=approved_source_oid,
            created_at=created_at,
            approved_target_oid=approved_target_oid,
            candidate_digest=candidate_digest,
        )


        review_approval.additional_properties = d
        return review_approval

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
