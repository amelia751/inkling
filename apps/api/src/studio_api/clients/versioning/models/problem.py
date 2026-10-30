from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.problem_code import ProblemCode
from ..types import UNSET, Unset
from typing import cast






T = TypeVar("T", bound="Problem")



@_attrs_define
class Problem:
    """ 
        Attributes:
            type_ (str):
            title (str):
            status (int):
            code (ProblemCode): Stable machine code.
            detail (str | Unset):
            request_id (str | Unset):
            current_head (str | Unset):
            head_generation (int | Unset):
            problems (list[str] | Unset):
     """

    type_: str
    title: str
    status: int
    code: ProblemCode
    detail: str | Unset = UNSET
    request_id: str | Unset = UNSET
    current_head: str | Unset = UNSET
    head_generation: int | Unset = UNSET
    problems: list[str] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        title = self.title

        status = self.status

        code = self.code.value

        detail = self.detail

        request_id = self.request_id

        current_head = self.current_head

        head_generation = self.head_generation

        problems: list[str] | Unset = UNSET
        if not isinstance(self.problems, Unset):
            problems = self.problems




        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "type": type_,
            "title": title,
            "status": status,
            "code": code,
        })
        if detail is not UNSET:
            field_dict["detail"] = detail
        if request_id is not UNSET:
            field_dict["request_id"] = request_id
        if current_head is not UNSET:
            field_dict["current_head"] = current_head
        if head_generation is not UNSET:
            field_dict["head_generation"] = head_generation
        if problems is not UNSET:
            field_dict["problems"] = problems

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = d.pop("type")

        title = d.pop("title")

        status = d.pop("status")

        code = ProblemCode(d.pop("code"))




        detail = d.pop("detail", UNSET)

        request_id = d.pop("request_id", UNSET)

        current_head = d.pop("current_head", UNSET)

        head_generation = d.pop("head_generation", UNSET)

        problems = cast(list[str], d.pop("problems", UNSET))


        problem = cls(
            type_=type_,
            title=title,
            status=status,
            code=code,
            detail=detail,
            request_id=request_id,
            current_head=current_head,
            head_generation=head_generation,
            problems=problems,
        )


        problem.additional_properties = d
        return problem

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
