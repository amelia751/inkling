from enum import Enum

class ReviewStatus(str, Enum):
    BLOCKED = "BLOCKED"
    CHECKING = "CHECKING"
    CLOSED = "CLOSED"
    CONFLICTED = "CONFLICTED"
    DRAFT = "DRAFT"
    MERGED = "MERGED"
    MERGING = "MERGING"
    OPEN = "OPEN"
    READY = "READY"

    def __str__(self) -> str:
        return str(self.value)
