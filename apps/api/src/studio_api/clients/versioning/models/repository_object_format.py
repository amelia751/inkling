from enum import Enum

class RepositoryObjectFormat(str, Enum):
    SHA1 = "sha1"
    SHA256 = "sha256"

    def __str__(self) -> str:
        return str(self.value)
