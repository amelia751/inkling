"""`python -m studio_worker.convert <package> <input> <out>`: run one converter, print its ConversionSummary."""

import json
import sys
from pathlib import Path

from .run import convert

if len(sys.argv) != 4:
    sys.exit("usage: python -m studio_worker.convert <package> <input> <out>")
summary = convert(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
print(json.dumps(summary))
sys.exit(0 if summary["ok"] else 1)
