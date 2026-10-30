from enum import Enum

class ReviewCheckOutcome(str, Enum):
    ERROR = "error"
    FAILED = "failed"
    PASSED = "passed"
    PENDING = "pending"

    def __str__(self) -> str:
        return str(self.value)
