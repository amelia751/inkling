from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.checkout_filter import CheckoutFilter





T = TypeVar("T", bound="CheckoutRequest")



@_attrs_define
class CheckoutRequest:
    """ 
        Attributes:
            ref (str): Commit oid, release tag (tag:<name>) or branch name
            filter_ (CheckoutFilter | Unset):
            cursor (str | Unset):
            limit (int | Unset):
            include_urls (bool | Unset):  Default: True.
     """

    ref: str
    filter_: CheckoutFilter | Unset = UNSET
    cursor: str | Unset = UNSET
    limit: int | Unset = UNSET
    include_urls: bool | Unset = True
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.checkout_filter import CheckoutFilter
        ref = self.ref

        filter_: dict[str, Any] | Unset = UNSET
        if not isinstance(self.filter_, Unset):
            filter_ = self.filter_.to_dict()

        cursor = self.cursor

        limit = self.limit

        include_urls = self.include_urls


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "ref": ref,
        })
        if filter_ is not UNSET:
            field_dict["filter"] = filter_
        if cursor is not UNSET:
            field_dict["cursor"] = cursor
        if limit is not UNSET:
            field_dict["limit"] = limit
        if include_urls is not UNSET:
            field_dict["include_urls"] = include_urls

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.checkout_filter import CheckoutFilter
        d = dict(src_dict)
        ref = d.pop("ref")

        _filter_ = d.pop("filter", UNSET)
        filter_: CheckoutFilter | Unset
        if isinstance(_filter_,  Unset):
            filter_ = UNSET
        else:
            filter_ = CheckoutFilter.from_dict(_filter_)




        cursor = d.pop("cursor", UNSET)

        limit = d.pop("limit", UNSET)

        include_urls = d.pop("include_urls", UNSET)

        checkout_request = cls(
            ref=ref,
            filter_=filter_,
            cursor=cursor,
            limit=limit,
            include_urls=include_urls,
        )


        checkout_request.additional_properties = d
        return checkout_request

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
