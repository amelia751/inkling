"""WebAssembly converters under wasmtime (todo10 D3 trial): a WASI preview-1 command module,
`argv = [name, "/in/<input>", "/out", *args]`, `/in` preopened read-only, `/out` writable, no
sockets (WASI p1 has none), no environment, no inherited stdio. Fuel and an epoch deadline
bound the run; the store's memory is capped. Components (`wasi-p2`) are not run here yet."""

from __future__ import annotations

import threading
from pathlib import Path

import wasmtime


class WasmError(Exception):
    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def run(module: Path, in_dir: Path, input_name: str, out_dir: Path, args: list[str], *, timeout_s: int, memory_mb: int, fuel_millions: int | None) -> int:
    cfg = wasmtime.Config()
    cfg.epoch_interruption = True
    cfg.consume_fuel = fuel_millions is not None
    engine = wasmtime.Engine(cfg)
    try:
        mod = wasmtime.Module.from_file(engine, str(module))
    except wasmtime.WasmtimeError as e:
        raise WasmError("converter-invalid") from e
    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    store = wasmtime.Store(engine)
    store.set_limits(memory_size=memory_mb * 1024 * 1024)
    if fuel_millions is not None:
        store.set_fuel(fuel_millions * 1_000_000)
    store.set_epoch_deadline(1)
    wasi = wasmtime.WasiConfig()
    wasi.argv = ["converter", f"/in/{input_name}", "/out", *args]
    wasi.preopen_dir(str(in_dir), "/in", fs_mutable=False)
    wasi.preopen_dir(str(out_dir), "/out", fs_mutable=True)
    store.set_wasi(wasi)
    timer = threading.Timer(timeout_s, engine.increment_epoch)
    timer.start()
    try:
        instance = linker.instantiate(store, mod)
        start = instance.exports(store).get("_start")
        if start is None:
            raise WasmError("converter-invalid")
        try:
            start(store)  # type: ignore[operator]
            return 0
        except wasmtime.ExitTrap as e:
            return e.code
        except wasmtime.Trap as e:
            code = getattr(e, "trap_code", None)
            if code == wasmtime.TrapCode.INTERRUPT:
                raise WasmError("timeout") from e
            if code == wasmtime.TrapCode.OUT_OF_FUEL:
                raise WasmError("timeout") from e
            raise WasmError("crash") from e
    except wasmtime.WasmtimeError as e:
        raise WasmError("memory" if "memory" in str(e).lower() else "crash") from e
    finally:
        timer.cancel()
