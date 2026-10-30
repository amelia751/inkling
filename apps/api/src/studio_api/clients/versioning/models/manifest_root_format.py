from enum import Enum

class ManifestRootFormat(str, Enum):
    CHUNKED_V1 = "chunked-v1"
    JSON_V1 = "json-v1"

    def __str__(self) -> str:
        return str(self.value)
