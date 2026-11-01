from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from dateutil.parser import isoparse
from typing import cast
import datetime

if TYPE_CHECKING:
  from ..models.release_attestations_item import ReleaseAttestationsItem





T = TypeVar("T", bound="Release")



@_attrs_define
class Release:
    """ 
        Attributes:
            tag (str):
            commit_oid (str):
            manifest_root (str):
            created_by (str):
            created_at (datetime.datetime):
            retention_policy (str):
            attestations (list[ReleaseAttestationsItem]):
            retain_until (datetime.datetime | Unset):
            studio_tree (str | Unset): The released commit's .studio/ tree id: the Studio definition its labels were made
                with
     """

    tag: str
    commit_oid: str
    manifest_root: str
    created_by: str
    created_at: datetime.datetime
    retention_policy: str
    attestations: list[ReleaseAttestationsItem]
    retain_until: datetime.datetime | Unset = UNSET
    studio_tree: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)





    def to_dict(self) -> dict[str, Any]:
        from ..models.release_attestations_item import ReleaseAttestationsItem
        tag = self.tag

        commit_oid = self.commit_oid

        manifest_root = self.manifest_root

        created_by = self.created_by

        created_at = self.created_at.isoformat()

        retention_policy = self.retention_policy

        attestations = []
        for attestations_item_data in self.attestations:
            attestations_item = attestations_item_data.to_dict()
            attestations.append(attestations_item)



        retain_until: str | Unset = UNSET
        if not isinstance(self.retain_until, Unset):
            retain_until = self.retain_until.isoformat()

        studio_tree = self.studio_tree


        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({
            "tag": tag,
            "commit_oid": commit_oid,
            "manifest_root": manifest_root,
            "created_by": created_by,
            "created_at": created_at,
            "retention_policy": retention_policy,
            "attestations": attestations,
        })
        if retain_until is not UNSET:
            field_dict["retain_until"] = retain_until
        if studio_tree is not UNSET:
            field_dict["studio_tree"] = studio_tree

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.release_attestations_item import ReleaseAttestationsItem
        d = dict(src_dict)
        tag = d.pop("tag")

        commit_oid = d.pop("commit_oid")

        manifest_root = d.pop("manifest_root")

        created_by = d.pop("created_by")

        created_at = isoparse(d.pop("created_at"))




        retention_policy = d.pop("retention_policy")

        attestations = []
        _attestations = d.pop("attestations")
        for attestations_item_data in (_attestations):
            attestations_item = ReleaseAttestationsItem.from_dict(attestations_item_data)



            attestations.append(attestations_item)


        _retain_until = d.pop("retain_until", UNSET)
        retain_until: datetime.datetime | Unset
        if isinstance(_retain_until,  Unset):
            retain_until = UNSET
        else:
            retain_until = isoparse(_retain_until)




        studio_tree = d.pop("studio_tree", UNSET)

        release = cls(
            tag=tag,
            commit_oid=commit_oid,
            manifest_root=manifest_root,
            created_by=created_by,
            created_at=created_at,
            retention_policy=retention_policy,
            attestations=attestations,
            retain_until=retain_until,
            studio_tree=studio_tree,
        )


        release.additional_properties = d
        return release

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
