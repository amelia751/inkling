from enum import Enum

class CreateReleaseRequestRetentionPolicy(str, Enum):
    LEGAL = "legal"
    LONG_TERM = "long_term"
    STANDARD = "standard"

    def __str__(self) -> str:
        return str(self.value)
