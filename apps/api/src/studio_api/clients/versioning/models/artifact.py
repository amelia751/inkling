from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.artifact_status import ArtifactStatus
from ..types import UNSET, Unset






T = TypeVar("T", bound="Artifact")



@_attrs_define
class Artifact:
    """ 
        Attributes:
            sha256 (str):
            size_bytes (int):
            media_type (str):
            status (ArtifactStatus):
            legal_hold (bool | Unset):
     """

    sha256: str
    size_bytes: int
    media_type: str
    status: ArtifactStatus
    legal_hold: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        sha256 = self.sha256

        size_bytes = self.size_bytes

        media_type = self.media_type

        status = self.status.value

        legal_hold = self.legal_hold


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "sha256": sha256,
            "size_bytes": size_bytes,
            "media_type": media_type,
            "status": status,
        })
        if legal_hold is not UNSET:
            field_dict["legal_hold"] = legal_hold

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sha256 = d.pop("sha256")

        size_bytes = d.pop("size_bytes")

        media_type = d.pop("media_type")

        status = ArtifactStatus(d.pop("status"))




        legal_hold = d.pop("legal_hold", UNSET)

        artifact = cls(
            sha256=sha256,
            size_bytes=size_bytes,
            media_type=media_type,
            status=status,
            legal_hold=legal_hold,
        )


        artifact.additional_properties = d
        return artifact

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
