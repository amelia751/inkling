from enum import Enum

class ArtifactStatus(str, Enum):
    AVAILABLE = "available"
    DELETED = "deleted"
    PURGED = "purged"
    STAGED = "staged"
    UNREFERENCED = "unreferenced"

    def __str__(self) -> str:
        return str(self.value)
