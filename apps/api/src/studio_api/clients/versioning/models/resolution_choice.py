from enum import Enum

class ResolutionChoice(str, Enum):
    CUSTOM = "custom"
    OURS = "ours"
    THEIRS = "theirs"

    def __str__(self) -> str:
        return str(self.value)
