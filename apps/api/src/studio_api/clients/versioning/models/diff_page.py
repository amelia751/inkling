from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.diff_aggregates import DiffAggregates
  from ..models.diff_change import DiffChange
  from ..models.diff_page_summary import DiffPageSummary





T = TypeVar("T", bound="DiffPage")



@_attrs_define
class DiffPage:
    """ 
        Attributes:
            base (str):
            head (str):
            base_root (str):
            head_root (str):
            summary (DiffPageSummary):
            aggregates (DiffAggregates):
            changes (list[DiffChange]):
            changed_buckets (int | Unset):
            next_cursor (str | Unset):
     """

    base: str
    head: str
    base_root: str
    head_root: str
    summary: DiffPageSummary
    aggregates: DiffAggregates
    changes: list[DiffChange]
    changed_buckets: int | Unset = UNSET
    next_cursor: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.diff_aggregates import DiffAggregates
        from ..models.diff_change import DiffChange
        from ..models.diff_page_summary import DiffPageSummary
        base = self.base

        head = self.head

        base_root = self.base_root

        head_root = self.head_root

        summary = self.summary.to_dict()

        aggregates = self.aggregates.to_dict()

        changes = []
        for changes_item_data in self.changes:
            changes_item = changes_item_data.to_dict()
            changes.append(changes_item)



        changed_buckets = self.changed_buckets

        next_cursor = self.next_cursor


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "base": base,
            "head": head,
            "base_root": base_root,
            "head_root": head_root,
            "summary": summary,
            "aggregates": aggregates,
            "changes": changes,
        })
        if changed_buckets is not UNSET:
            field_dict["changed_buckets"] = changed_buckets
        if next_cursor is not UNSET:
            field_dict["next_cursor"] = next_cursor

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.diff_aggregates import DiffAggregates
        from ..models.diff_change import DiffChange
        from ..models.diff_page_summary import DiffPageSummary
        d = dict(src_dict)
        base = d.pop("base")

        head = d.pop("head")

        base_root = d.pop("base_root")

        head_root = d.pop("head_root")

        summary = DiffPageSummary.from_dict(d.pop("summary"))




        aggregates = DiffAggregates.from_dict(d.pop("aggregates"))




        changes = []
        _changes = d.pop("changes")
        for changes_item_data in (_changes):
            changes_item = DiffChange.from_dict(changes_item_data)



            changes.append(changes_item)


        changed_buckets = d.pop("changed_buckets", UNSET)

        next_cursor = d.pop("next_cursor", UNSET)

        diff_page = cls(
            base=base,
            head=head,
            base_root=base_root,
            head_root=head_root,
            summary=summary,
            aggregates=aggregates,
            changes=changes,
            changed_buckets=changed_buckets,
            next_cursor=next_cursor,
        )


        diff_page.additional_properties = d
        return diff_page

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
