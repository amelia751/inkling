from enum import Enum

class SignedObjectStatus(str, Enum):
    AVAILABLE = "available"
    MISSING = "missing"
    PURGED = "purged"
    STAGED = "staged"

    def __str__(self) -> str:
        return str(self.value)
