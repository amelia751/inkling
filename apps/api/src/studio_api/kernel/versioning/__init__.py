"""Dataset versioning integration (todo4 Phase 6): apps/versioning behind the kernel."""

from .client import VersioningProblem, configured, set_client
from .service import COMMANDS, OPS, run, work_branch

__all__ = ["COMMANDS", "OPS", "VersioningProblem", "configured", "run", "set_client", "work_branch"]
