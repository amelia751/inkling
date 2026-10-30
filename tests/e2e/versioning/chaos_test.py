"""Chaos (todo4 Phase 7: "refs survive restarts" + k8s pod-kill): SKIPPED.

This test kills versioning pods mid-commit in the dev k8s overlay and checks that branch heads
and reviews come back consistent. The overlay (`infra/k8s/`) doesn't exist yet: it is
todo3's work (todo4 Phase 5). Until then, restart safety is covered by
apps/versioning/tests/integration (restart and concurrent-CAS tests against real Postgres).
"""

from __future__ import annotations

import sys


def run(api: str) -> None:  # noqa: ARG001
    print("chaos: SKIPPED — needs the dev k8s overlay (todo3 / todo4 Phase 5), which doesn't exist yet")


if __name__ == "__main__":
    run("")
    sys.exit(0)
