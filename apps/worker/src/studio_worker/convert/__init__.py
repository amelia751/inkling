"""Converter runtime (todo10 Phase 6, ladder rung 2; contract: packages/contracts/src/converter.ts).

A converter turns one file the Studio can't read into a canonical shape (Zarr array, Arrow
table, or assets an existing data kind shows). This module runs one, untrusted, on one input:

    summary = convert(package_dir, input_file, out_dir)

- the package's `converter.yaml` is validated (strict, like plugin.yaml);
- the input must match `accepts` (extension or media type, magic bytes, header text);
- it is copied read-only into a private folder as `input<ext>`, so its name never reaches the
  converter or the summary;
- Python converters run in their own process (`python -I`, empty environment, CPU / memory /
  time limits, an audit hook that refuses sockets, subprocesses and writes outside the output
  folder); WebAssembly converters run under wasmtime with `/in` read-only and `/out`
  writable, no sockets, fuel and an epoch deadline;
- `output.json` is validated against the contract, every file must exist inside `out_dir`, and
  the files are measured (bytes, SHA-256, dims, dtype, value range) by the worker, not taken from
  the converter's word;
- the summary is fixed-schema (ConversionSummary): an error class and a line number in the
  converter's own source, never exception text.

In production this runs inside the worker's gVisor pod with egress denied (NetworkPolicy); the
audit hook and limits here are a second layer, not the sandbox. `python -m studio_worker.convert`
is the CLI.
"""

from .contract import CANONICAL_SHAPES, CONVERSION_ERRORS, ConverterInvalid, load_manifest
from .run import convert

__all__ = ["CANONICAL_SHAPES", "CONVERSION_ERRORS", "ConverterInvalid", "convert", "load_manifest"]
