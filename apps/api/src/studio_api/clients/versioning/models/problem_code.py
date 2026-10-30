from enum import Enum

class ProblemCode(str, Enum):
    BAD_REQUEST = "bad_request"
    CONFLICT = "conflict"
    DISABLED = "disabled"
    FORBIDDEN = "forbidden"
    IDEMPOTENCY_MISMATCH = "idempotency_mismatch"
    INTERNAL = "internal"
    INVALID_TRANSITION = "invalid_transition"
    LEGAL_HOLD = "legal_hold"
    MULTIPLE_MERGE_BASES = "multiple_merge_bases"
    NOT_FOUND = "not_found"
    NOT_READY = "not_ready"
    PROTECTED_BRANCH = "protected_branch"
    PURGED = "purged"
    RATE_LIMITED = "rate_limited"
    RETENTION = "retention"
    SELF_APPROVAL = "self_approval"
    STALE_HEAD = "stale_head"
    TOO_LARGE = "too_large"
    UNAUTHENTICATED = "unauthenticated"
    UNRESOLVED_CONFLICTS = "unresolved_conflicts"
    VALIDATION_FAILED = "validation_failed"

    def __str__(self) -> str:
        return str(self.value)
