from enum import Enum

class CommitOperation(str, Enum):
    COMMIT = "commit"
    INIT = "init"
    MERGE = "merge"
    REVERT = "revert"

    def __str__(self) -> str:
        return str(self.value)
