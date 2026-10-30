from enum import Enum

class DiffChangeType(str, Enum):
    ANNOTATION_ADDED = "annotation.added"
    ANNOTATION_CHANGED = "annotation.changed"
    ANNOTATION_REMOVED = "annotation.removed"
    GROUPING_CHANGED = "grouping.changed"
    ONTOLOGY_CLASS_ADDED = "ontology.class_added"
    ONTOLOGY_CLASS_REMOVED = "ontology.class_removed"
    ONTOLOGY_CLASS_RENAMED = "ontology.class_renamed"
    ONTOLOGY_REQUIRED_FIELD_ADDED = "ontology.required_field_added"
    SAMPLE_ADDED = "sample.added"
    SAMPLE_REMOVED = "sample.removed"
    SAMPLE_REPLACED = "sample.replaced"

    def __str__(self) -> str:
        return str(self.value)
