from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.studio_input import StudioInput





T = TypeVar("T", bound="CommitRequest")



@_attrs_define
class CommitRequest:
    """ 
        Attributes:
            branch (str):
            expected_head (str):
            manifest_root (str):
            message (str):
            idempotency_key (str):
            tool (str | Unset):
            inputs (list[str] | Unset):
            studio (StudioInput | Unset): Replaces the commit's whole `.studio/` tree (empty `files` removes it); omitted,
                the commit keeps its parent's. JSON files must be RFC 8785 canonical.
     """

    branch: str
    expected_head: str
    manifest_root: str
    message: str
    idempotency_key: str
    tool: str | Unset = UNSET
    inputs: list[str] | Unset = UNSET
    studio: StudioInput | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.studio_input import StudioInput
        branch = self.branch

        expected_head = self.expected_head

        manifest_root = self.manifest_root

        message = self.message

        idempotency_key = self.idempotency_key

        tool = self.tool

        inputs: list[str] | Unset = UNSET
        if not isinstance(self.inputs, Unset):
            inputs = self.inputs



        studio: dict[str, Any] | Unset = UNSET
        if not isinstance(self.studio, Unset):
            studio = self.studio.to_dict()


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "branch": branch,
            "expected_head": expected_head,
            "manifest_root": manifest_root,
            "message": message,
            "idempotency_key": idempotency_key,
        })
        if tool is not UNSET:
            field_dict["tool"] = tool
        if inputs is not UNSET:
            field_dict["inputs"] = inputs
        if studio is not UNSET:
            field_dict["studio"] = studio

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.studio_input import StudioInput
        d = dict(src_dict)
        branch = d.pop("branch")

        expected_head = d.pop("expected_head")

        manifest_root = d.pop("manifest_root")

        message = d.pop("message")

        idempotency_key = d.pop("idempotency_key")

        tool = d.pop("tool", UNSET)

        inputs = cast(list[str], d.pop("inputs", UNSET))


        _studio = d.pop("studio", UNSET)
        studio: StudioInput | Unset
        if isinstance(_studio,  Unset):
            studio = UNSET
        else:
            studio = StudioInput.from_dict(_studio)




        commit_request = cls(
            branch=branch,
            expected_head=expected_head,
            manifest_root=manifest_root,
            message=message,
            idempotency_key=idempotency_key,
            tool=tool,
            inputs=inputs,
            studio=studio,
        )


        commit_request.additional_properties = d
        return commit_request

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
