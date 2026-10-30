from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.review_status import ReviewStatus
from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
from uuid import UUID
import datetime

if TYPE_CHECKING:
  from ..models.merge_conflict import MergeConflict
  from ..models.review_approval import ReviewApproval
  from ..models.review_check import ReviewCheck





T = TypeVar("T", bound="Review")



@_attrs_define
class Review:
    """ 
        Attributes:
            id (UUID):
            repo_id (UUID):
            title (str):
            author_id (str):
            source_branch (str):
            source_oid (str):
            target_branch (str):
            status (ReviewStatus):
            required_approvals (int):
            version (int):
            created_at (datetime.datetime):
            updated_at (datetime.datetime):
            approvals (list[ReviewApproval]):
            checks (list[ReviewCheck]):
            conflicts (list[MergeConflict]):
            description (str | Unset):
            author_on_behalf_of (str | Unset):
            checked_target_oid (str | Unset):
            base_oid (str | Unset):
            merge_oid (str | Unset):
     """

    id: UUID
    repo_id: UUID
    title: str
    author_id: str
    source_branch: str
    source_oid: str
    target_branch: str
    status: ReviewStatus
    required_approvals: int
    version: int
    created_at: datetime.datetime
    updated_at: datetime.datetime
    approvals: list[ReviewApproval]
    checks: list[ReviewCheck]
    conflicts: list[MergeConflict]
    description: str | Unset = UNSET
    author_on_behalf_of: str | Unset = UNSET
    checked_target_oid: str | Unset = UNSET
    base_oid: str | Unset = UNSET
    merge_oid: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.merge_conflict import MergeConflict
        from ..models.review_approval import ReviewApproval
        from ..models.review_check import ReviewCheck
        id = str(self.id)

        repo_id = str(self.repo_id)

        title = self.title

        author_id = self.author_id

        source_branch = self.source_branch

        source_oid = self.source_oid

        target_branch = self.target_branch

        status = self.status.value

        required_approvals = self.required_approvals

        version = self.version

        created_at = self.created_at.isoformat()

        updated_at = self.updated_at.isoformat()

        approvals = []
        for approvals_item_data in self.approvals:
            approvals_item = approvals_item_data.to_dict()
            approvals.append(approvals_item)



        checks = []
        for checks_item_data in self.checks:
            checks_item = checks_item_data.to_dict()
            checks.append(checks_item)



        conflicts = []
        for conflicts_item_data in self.conflicts:
            conflicts_item = conflicts_item_data.to_dict()
            conflicts.append(conflicts_item)



        description = self.description

        author_on_behalf_of = self.author_on_behalf_of

        checked_target_oid = self.checked_target_oid

        base_oid = self.base_oid

        merge_oid = self.merge_oid


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "id": id,
            "repo_id": repo_id,
            "title": title,
            "author_id": author_id,
            "source_branch": source_branch,
            "source_oid": source_oid,
            "target_branch": target_branch,
            "status": status,
            "required_approvals": required_approvals,
            "version": version,
            "created_at": created_at,
            "updated_at": updated_at,
            "approvals": approvals,
            "checks": checks,
            "conflicts": conflicts,
        })
        if description is not UNSET:
            field_dict["description"] = description
        if author_on_behalf_of is not UNSET:
            field_dict["author_on_behalf_of"] = author_on_behalf_of
        if checked_target_oid is not UNSET:
            field_dict["checked_target_oid"] = checked_target_oid
        if base_oid is not UNSET:
            field_dict["base_oid"] = base_oid
        if merge_oid is not UNSET:
            field_dict["merge_oid"] = merge_oid

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.merge_conflict import MergeConflict
        from ..models.review_approval import ReviewApproval
        from ..models.review_check import ReviewCheck
        d = dict(src_dict)
        id = UUID(d.pop("id"))




        repo_id = UUID(d.pop("repo_id"))




        title = d.pop("title")

        author_id = d.pop("author_id")

        source_branch = d.pop("source_branch")

        source_oid = d.pop("source_oid")

        target_branch = d.pop("target_branch")

        status = ReviewStatus(d.pop("status"))




        required_approvals = d.pop("required_approvals")

        version = d.pop("version")

        created_at = isoparse(d.pop("created_at"))




        updated_at = isoparse(d.pop("updated_at"))




        approvals = []
        _approvals = d.pop("approvals")
        for approvals_item_data in (_approvals):
            approvals_item = ReviewApproval.from_dict(approvals_item_data)



            approvals.append(approvals_item)


        checks = []
        _checks = d.pop("checks")
        for checks_item_data in (_checks):
            checks_item = ReviewCheck.from_dict(checks_item_data)



            checks.append(checks_item)


        conflicts = []
        _conflicts = d.pop("conflicts")
        for conflicts_item_data in (_conflicts):
            conflicts_item = MergeConflict.from_dict(conflicts_item_data)



            conflicts.append(conflicts_item)


        description = d.pop("description", UNSET)

        author_on_behalf_of = d.pop("author_on_behalf_of", UNSET)

        checked_target_oid = d.pop("checked_target_oid", UNSET)

        base_oid = d.pop("base_oid", UNSET)

        merge_oid = d.pop("merge_oid", UNSET)

        review = cls(
            id=id,
            repo_id=repo_id,
            title=title,
            author_id=author_id,
            source_branch=source_branch,
            source_oid=source_oid,
            target_branch=target_branch,
            status=status,
            required_approvals=required_approvals,
            version=version,
            created_at=created_at,
            updated_at=updated_at,
            approvals=approvals,
            checks=checks,
            conflicts=conflicts,
            description=description,
            author_on_behalf_of=author_on_behalf_of,
            checked_target_oid=checked_target_oid,
            base_oid=base_oid,
            merge_oid=merge_oid,
        )


        review.additional_properties = d
        return review

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
