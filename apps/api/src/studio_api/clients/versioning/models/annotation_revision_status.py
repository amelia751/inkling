from enum import Enum

class AnnotationRevisionStatus(str, Enum):
    ACCEPTED = "accepted"
    DRAFT = "draft"
    REJECTED = "rejected"
    SUBMITTED = "submitted"

    def __str__(self) -> str:
        return str(self.value)
