"""Generic adapters by `adapter.kind` (plugin.yaml providers; todo25 W7)."""

from .hf import HuggingFace
from .oip import Oip
from .replicate import Replicate

ADAPTERS = {"oip": Oip, "replicate": Replicate, "hf": HuggingFace}
