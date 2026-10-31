"""Free-text check for what crosses the data boundary (todo10 §6.1 step 5, §6.3).

Two questions, asked of every string the agent could see that came from a real sample:

- `name_ok(name)`: may a *structural name* (header field, column, dataset path, label) pass as
  it is? Identifier-shaped names do, unless they look like an identifier of a person (e-mail,
  phone, SSN, a date, a long digit run).
- `text_ok(text)`: may *free text* (a probe's `read_text`, an annotation's string attribute)
  pass? Only if every word is in a structural vocabulary (format magic, dtype and header
  words, the task's own labels) or is a number. Everything else comes back as a placeholder.

The `dev` check is a deterministic allowlist: it errs on the side of placeholders. A hosted
deployment swaps in Sensitive Data Protection behind the same two functions (todo10 Phase 9);
`checker()` names the one in use, and reports carry that name.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:/-]{0,63}$")
TEXT = re.compile(r"^[A-Za-z0-9 _.:/-]{0,32}$")
PHI_SHAPES = [
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),  # e-mail
    re.compile(r"\d{3}-\d{2}-\d{4}"),  # SSN
    re.compile(r"\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}"),  # phone
    re.compile(r"(19|20)\d{2}[-/.]?(0[1-9]|1[0-2])[-/.]?(0[1-9]|[12]\d|3[01])"),  # a date
    re.compile(r"\d{6,}"),  # MRNs, accession numbers
]

# Words that describe structure, never a person. Lower-case; compared case-insensitively.
VOCABULARY = frozenset(
    """
    dicm dicom hdf hdf5 png ihdr idat iend jfif exif gif gif87a gif89a riff wave fmt avi tiff ii mm pk par1 numpy npy npz
    nifti ni1 n+1 nii mha mhd nrrd ome zarr json csv tsv txt bin dat hea edf bdf xml yaml
    bool int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float float16 float32 float64 double complex string bytes
    header data metadata body footer section block chunk frame frames slice slices volume image images pixel pixels voxel
    width height depth rows columns cols channels bands samples sample rate fs hz khz mm um ms sec
    version magic dtype shape size length offset count index type kind format encoding endian little big le be
    signed unsigned bits bit stored allocated spacing origin direction orientation units unit scale slope intercept
    min max mean nan none null true false yes no ok end start begin stop
    """.split()
)

_NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_HEX = re.compile(r"^(0x)?[0-9a-fA-F]+$")


def checker() -> str:
    return "dev-vocab-v1"


def _phi_shaped(s: str) -> bool:
    return any(rx.search(s) for rx in PHI_SHAPES)


def name_ok(name: str) -> bool:
    return isinstance(name, str) and bool(FIELD_NAME.match(name)) and not _phi_shaped(name)


def text_ok(text: str, vocabulary: Iterable[str] = ()) -> bool:
    if not isinstance(text, str) or not TEXT.match(text) or _phi_shaped(text):
        return False
    extra = {v.lower() for v in vocabulary}
    for word in re.split(r"[\s_.:/-]+", text.strip()):
        if not word:
            continue
        w = word.lower()
        if w in VOCABULARY or w in extra or _NUMBER.match(word) or (len(word) <= 4 and _HEX.match(word) and any(c.isdigit() for c in word)):
            continue
        return False
    return True


def placeholder(text: str) -> str:
    return f"<redacted:{min(len(text), 99999)}>"


def name_or_placeholder(name: str) -> tuple[str, bool]:
    """(the name, or a placeholder; whether it was redacted)."""
    return (name, False) if name_ok(name) else (placeholder(str(name)), True)


def text_or_placeholder(text: str, vocabulary: Iterable[str] = ()) -> str:
    return text if text_ok(text, vocabulary) else placeholder(str(text))
