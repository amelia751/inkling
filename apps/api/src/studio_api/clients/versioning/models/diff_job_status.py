from enum import Enum

class DiffJobStatus(str, Enum):
    FAILED = "failed"
    PENDING = "pending"
    RUNNING = "running"

    def __str__(self) -> str:
        return str(self.value)
