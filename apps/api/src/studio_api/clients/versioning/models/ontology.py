from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
  from ..models.ontology_classes_item import OntologyClassesItem





T = TypeVar("T", bound="Ontology")



@_attrs_define
class Ontology:
    """ 
        Attributes:
            revision_id (str):
            classes (list[OntologyClassesItem]):
     """

    revision_id: str
    classes: list[OntologyClassesItem]





    def to_dict(self) -> dict[str, Any]:
        from ..models.ontology_classes_item import OntologyClassesItem
        revision_id = self.revision_id

        classes = []
        for classes_item_data in self.classes:
            classes_item = classes_item_data.to_dict()
            classes.append(classes_item)




        field_dict: dict[str, Any] = {}

        field_dict.update({
            "revision_id": revision_id,
            "classes": classes,
        })

        return field_dict



    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.ontology_classes_item import OntologyClassesItem
        d = dict(src_dict)
        revision_id = d.pop("revision_id")

        classes = []
        _classes = d.pop("classes")
        for classes_item_data in (_classes):
            classes_item = OntologyClassesItem.from_dict(classes_item_data)



            classes.append(classes_item)


        ontology = cls(
            revision_id=revision_id,
            classes=classes,
        )

        return ontology

