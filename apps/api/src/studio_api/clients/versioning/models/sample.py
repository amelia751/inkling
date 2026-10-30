from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
  from ..models.sample_group import SampleGroup
  from ..models.sample_objects_item import SampleObjectsItem





T = TypeVar("T", bound="Sample")



@_attrs_define
class Sample:
    """ 
        Attributes:
            sample_id (str):
            modality (str):
            objects (list[SampleObjectsItem]):
            group (SampleGroup | Unset):
            split (str | Unset):
            width (int | Unset):
            height (int | Unset):
            depth (int | Unset):
            duration_s (float | Unset):
     """

    sample_id: str
    modality: str
    objects: list[SampleObjectsItem]
    group: SampleGroup | Unset = UNSET
    split: str | Unset = UNSET
    width: int | Unset = UNSET
    height: int | Unset = UNSET
    depth: int | Unset = UNSET
    duration_s: float | Unset = UNSET





    def to_dict(self) -> dict[str, Any]:
        from ..models.sample_group import SampleGroup
        from ..models.sample_objects_item import SampleObjectsItem
        sample_id = self.sample_id

        modality = self.modality

        objects = []
        for objects_item_data in self.objects:
            objects_item = objects_item_data.to_dict()
            objects.append(objects_item)



        group: dict[str, Any] | Unset = UNSET
        if not isinstance(self.group, Unset):
            group = self.group.to_dict()

        split = self.split

        width = self.width

        height = self.height

        depth = self.depth

        duration_s = self.duration_s


        field_dict: dict[str, Any] = {}

        field_dict.update({
            "sample_id": sample_id,
            "modality": modality,
            "objects": objects,
        })
        if group is not UNSET:
            field_dict["group"] = group
        if split is not UNSET:
            field_dict["split"] = split
        if width is not UNSET:
            field_dict["width"] = width
        if height is not UNSET:
            field_dict["height"] = height
        if depth is not UNSET:
            field_dict["depth"] = depth
        if duration_s is not UNSET:
            field_dict["duration_s"] = duration_s

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sample_group import SampleGroup
        from ..models.sample_objects_item import SampleObjectsItem
        d = dict(src_dict)
        sample_id = d.pop("sample_id")

        modality = d.pop("modality")

        objects = []
        _objects = d.pop("objects")
        for objects_item_data in (_objects):
            objects_item = SampleObjectsItem.from_dict(objects_item_data)



            objects.append(objects_item)


        _group = d.pop("group", UNSET)
        group: SampleGroup | Unset
        if isinstance(_group,  Unset):
            group = UNSET
        else:
            group = SampleGroup.from_dict(_group)




        split = d.pop("split", UNSET)

        width = d.pop("width", UNSET)

        height = d.pop("height", UNSET)

        depth = d.pop("depth", UNSET)

        duration_s = d.pop("duration_s", UNSET)

        sample = cls(
            sample_id=sample_id,
            modality=modality,
            objects=objects,
            group=group,
            split=split,
            width=width,
            height=height,
            depth=depth,
            duration_s=duration_s,
        )

        return sample

