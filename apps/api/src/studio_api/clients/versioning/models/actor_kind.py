from enum import Enum

class ActorKind(str, Enum):
    AGENT = "agent"
    SERVICE = "service"
    USER = "user"

    def __str__(self) -> str:
        return str(self.value)
