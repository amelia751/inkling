from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.diff_aggregates_head import DiffAggregatesHead
  from ..models.diff_aggregates_split_delta import DiffAggregatesSplitDelta
  from ..models.diff_aggregates_suspicious_duplicates_item import DiffAggregatesSuspiciousDuplicatesItem
  from ..models.diff_aggregates_base import DiffAggregatesBase
  from ..models.diff_aggregates_class_balance_delta import DiffAggregatesClassBalanceDelta





T = TypeVar("T", bound="DiffAggregates")



@_attrs_define
class DiffAggregates:
    """ 
        Attributes:
            base (DiffAggregatesBase | Unset):
            head (DiffAggregatesHead | Unset):
            class_balance_delta (DiffAggregatesClassBalanceDelta | Unset):
            split_delta (DiffAggregatesSplitDelta | Unset):
            suspicious_duplicates (list[DiffAggregatesSuspiciousDuplicatesItem] | Unset):
     """

    base: DiffAggregatesBase | Unset = UNSET
    head: DiffAggregatesHead | Unset = UNSET
    class_balance_delta: DiffAggregatesClassBalanceDelta | Unset = UNSET
    split_delta: DiffAggregatesSplitDelta | Unset = UNSET
    suspicious_duplicates: list[DiffAggregatesSuspiciousDuplicatesItem] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.diff_aggregates_head import DiffAggregatesHead
        from ..models.diff_aggregates_split_delta import DiffAggregatesSplitDelta
        from ..models.diff_aggregates_suspicious_duplicates_item import DiffAggregatesSuspiciousDuplicatesItem
        from ..models.diff_aggregates_base import DiffAggregatesBase
        from ..models.diff_aggregates_class_balance_delta import DiffAggregatesClassBalanceDelta
        base: dict[str, Any] | Unset = UNSET
        if not isinstance(self.base, Unset):
            base = self.base.to_dict()

        head: dict[str, Any] | Unset = UNSET
        if not isinstance(self.head, Unset):
            head = self.head.to_dict()

        class_balance_delta: dict[str, Any] | Unset = UNSET
        if not isinstance(self.class_balance_delta, Unset):
            class_balance_delta = self.class_balance_delta.to_dict()

        split_delta: dict[str, Any] | Unset = UNSET
        if not isinstance(self.split_delta, Unset):
            split_delta = self.split_delta.to_dict()

        suspicious_duplicates: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.suspicious_duplicates, Unset):
            suspicious_duplicates = []
            for suspicious_duplicates_item_data in self.suspicious_duplicates:
                suspicious_duplicates_item = suspicious_duplicates_item_data.to_dict()
                suspicious_duplicates.append(suspicious_duplicates_item)




        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
        })
        if base is not UNSET:
            field_dict["base"] = base
        if head is not UNSET:
            field_dict["head"] = head
        if class_balance_delta is not UNSET:
            field_dict["class_balance_delta"] = class_balance_delta
        if split_delta is not UNSET:
            field_dict["split_delta"] = split_delta
        if suspicious_duplicates is not UNSET:
            field_dict["suspicious_duplicates"] = suspicious_duplicates

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.diff_aggregates_head import DiffAggregatesHead
        from ..models.diff_aggregates_split_delta import DiffAggregatesSplitDelta
        from ..models.diff_aggregates_suspicious_duplicates_item import DiffAggregatesSuspiciousDuplicatesItem
        from ..models.diff_aggregates_base import DiffAggregatesBase
        from ..models.diff_aggregates_class_balance_delta import DiffAggregatesClassBalanceDelta
        d = dict(src_dict)
        _base = d.pop("base", UNSET)
        base: DiffAggregatesBase | Unset
        if isinstance(_base,  Unset):
            base = UNSET
        else:
            base = DiffAggregatesBase.from_dict(_base)




        _head = d.pop("head", UNSET)
        head: DiffAggregatesHead | Unset
        if isinstance(_head,  Unset):
            head = UNSET
        else:
            head = DiffAggregatesHead.from_dict(_head)




        _class_balance_delta = d.pop("class_balance_delta", UNSET)
        class_balance_delta: DiffAggregatesClassBalanceDelta | Unset
        if isinstance(_class_balance_delta,  Unset):
            class_balance_delta = UNSET
        else:
            class_balance_delta = DiffAggregatesClassBalanceDelta.from_dict(_class_balance_delta)




        _split_delta = d.pop("split_delta", UNSET)
        split_delta: DiffAggregatesSplitDelta | Unset
        if isinstance(_split_delta,  Unset):
            split_delta = UNSET
        else:
            split_delta = DiffAggregatesSplitDelta.from_dict(_split_delta)




        _suspicious_duplicates = d.pop("suspicious_duplicates", UNSET)
        suspicious_duplicates: list[DiffAggregatesSuspiciousDuplicatesItem] | Unset = UNSET
        if _suspicious_duplicates is not UNSET:
            suspicious_duplicates = []
            for suspicious_duplicates_item_data in _suspicious_duplicates:
                suspicious_duplicates_item = DiffAggregatesSuspiciousDuplicatesItem.from_dict(suspicious_duplicates_item_data)



                suspicious_duplicates.append(suspicious_duplicates_item)


        diff_aggregates = cls(
            base=base,
            head=head,
            class_balance_delta=class_balance_delta,
            split_delta=split_delta,
            suspicious_duplicates=suspicious_duplicates,
        )


        diff_aggregates.additional_properties = d
        return diff_aggregates

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
