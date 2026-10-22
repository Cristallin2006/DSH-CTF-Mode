#!/usr/bin/env python3
"""Qiling function experiment. Integer/C-string arguments; no target acceptance claim.

oracle.py BINARY ADDRESS [ARGS...] --rootfs DIR [--python PYTHON] [@out.json]
Linux uses the selected local interpreter. Windows defaults to WSL; select
--transport native explicitly for a native backend. --describe is offline;
--check validates the request and probes dependencies without executing the target.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

SENTINEL = 0xDEAD0000
ARG_REGS = {"sysv64": ("rdi", "rsi", "rdx", "rcx", "r8", "r9"),
            "win64": ("rcx", "rdx", "r8", "r9")}
ABI = {("elf", 64): "sysv64", ("pe", 64): "win64",
       ("elf", 32): "cdecl", ("pe", 32): "cdecl"}


def describe():
    return {"tool": "function-oracle", "contract_version": 1,
            "formats": ["ELF little-endian x86/x86-64", "PE i386/AMD64"],
            "abi": {k: {"register_args": list(v), "max_args": len(v)} for k, v in ARG_REGS.items()},
            "i386": "cdecl integer/pointer stack arguments only; caller must confirm ABI",
            "arguments": "integers or str: UTF-8 NUL-terminated strings; no floats/structs/variadics",
            "addresses": "analysis VA; --image-base overrides inferred analysis base; translated via loaded image",
            "dependencies": ["qiling", "matching rootfs", "selected interpreter"],
            "interventions": ["emulation", "synthetic call frame", "scratch memory"],
            "limitations": ["not native execution", "no automatic ABI inference", "return value is not target acceptance"],
            "target_accepted": None}


def inspect_binary(binary):
    data = Path(binary).read_bytes()
    def unpack(fmt, offset):
        size = struct.calcsize(fmt)
        if offset < 0 or offset + size > len(data):
            raise ValueError("truncated binary header")
        return struct.unpack_from(fmt, data, offset)
    if data[:4] == b"\x7fELF":
        if len(data) < 16 or data[4] not in (1, 2) or data[5] != 1 or data[6] != 1:
            raise ValueError("unsupported ELF class/endianness/version")
        bits = 32 if data[4] == 1 else 64
        etype, machine = unpack("<HH", 16)
        if machine != (3 if bits == 32 else 62):
            raise ValueError("unsupported ELF machine: x86/x86-64 only")
        if etype not in (2, 3):
            raise ValueError("ELF must be an executable or shared object")
        header_size = 52 if bits == 32 else 64
        if len(data) < header_size:
            raise ValueError("truncated ELF header")
        phoff = unpack("<I" if bits == 32 else "<Q", 28 if bits == 32 else 32)[0]
        phsize, phnum = unpack("<HH", 42 if bits == 32 else 54)
        if not phnum or phsize < (32 if bits == 32 else 56) or phoff + phsize * phnum > len(data):
            raise ValueError("invalid ELF program header table")
        bases = []
        for i in range(phnum):
            off = phoff + i * phsize
            if unpack("<I", off)[0] == 1:
                bases.append(unpack("<I" if bits == 32 else "<Q", off + (8 if bits == 32 else 16))[0])
        if not bases:
            raise ValueError("ELF has no loadable segments")
        base = 0x100000 if etype == 3 else min(bases) & ~0xFFF
        kind = "elf"
    elif data[:2] == b"MZ":
        peoff = unpack("<I", 60)[0]
        if data[peoff:peoff + 4] != b"PE\0\0":
            raise ValueError("invalid PE signature")
        machine = unpack("<H", peoff + 4)[0]
        optsize = unpack("<H", peoff + 20)[0]
        magic = unpack("<H", peoff + 24)[0]
        if (machine, magic) not in ((0x14C, 0x10B), (0x8664, 0x20B)):
            raise ValueError("unsupported or inconsistent PE machine/optional header")
        bits = 64 if magic == 0x20B else 32
        if optsize < (112 if bits == 64 else 96) or peoff + 24 + optsize > len(data):
            raise ValueError("truncated PE optional header")
        base = unpack("<Q" if bits == 64 else "<I", peoff + (48 if bits == 64 else 52))[0]
        kind = "pe"
    else:
        raise ValueError("unrecognized executable format")
    return {"kind": kind, "bits": bits, "machine": machine, "image_base": base,
            "abi": ABI[(kind, bits)], "target_sha256": hashlib.sha256(data).hexdigest()}


def sniff(binary):
    info = inspect_binary(binary)
    return info["kind"], info["bits"]


def validate_spec(spec):
    bits, abi, args = spec["bits"], spec["abi"], spec["args"]
    if abi != ABI[(spec["kind"], bits)]:
        raise ValueError("ABI does not match supported format/architecture")
    if abi in ARG_REGS and len(args) > len(ARG_REGS[abi]):
        raise ValueError("stack arguments are not supported for this x64 ABI")
    if len(args) > 256:
        raise ValueError("too many arguments")
    allocated = 0
    for arg in args:
        if isinstance(arg, str):
            if "\0" in arg:
                raise ValueError("embedded NUL in C string")
            allocated += len(arg.encode("utf-8")) + 8
        elif type(arg) is not int or not -(1 << (bits - 1)) <= arg < 1 << bits:
            raise ValueError("integer argument outside target word width")
    if allocated > 0x10000:
        raise ValueError("string arguments exceed scratch memory")
    if not math.isfinite(spec["timeout"]) or spec["timeout"] <= 0:
        raise ValueError("timeout must be finite and positive")
    if spec["max_hits"] <= 0:
        raise ValueError("max-hits must be positive")
    for key in ("func", "image_base", "init_until", "break_at"):
        value = spec.get(key)
        if value is not None and not 0 <= value < 1 << bits:
            raise ValueError(key + " outside target address width")
    if spec["dumps"] and spec.get("break_at") is None:
        raise ValueError("--dump requires --break")
    registers = ({"eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "eip"} if bits == 32
                 else {"rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "rip"} | {"r" + str(i) for i in range(8, 16)})
    for expr in spec["dumps"]:
        target, sep, size = expr.partition(":")
        match = re.fullmatch(r"([a-z][a-z0-9]*)(?:[+-](?:0x[0-9a-fA-F]+|\d+))?", target)
        if not (match and match[1] in registers):
            if not 0 <= int(target, 0) < 1 << bits:
                raise ValueError("dump address outside target width")
        if sep and not 0 < int(size, 0) <= 0x100000:
            raise ValueError("dump length must be 1..1048576")


def marshal_args(ql, spec):
    scratch, ptr = 0x50000000, 0x50000000
    ql.mem.map(scratch, 0x10000)
    values = []
    for arg in spec["args"]:
        if isinstance(arg, str):
            encoded = arg.encode("utf-8") + b"\0"
            ql.mem.write(ptr, encoded)
            values.append(ptr)
            ptr += len(encoded) + 7
        else:
            values.append(arg & ((1 << spec["bits"]) - 1))
    if spec["bits"] == 64:
        for reg, value in zip(ARG_REGS[spec["abi"]], values):
            setattr(ql.arch.regs, reg, value)
        shadow = 32 if spec["abi"] == "win64" else 0
        ql.arch.regs.rsp = ((ql.arch.regs.rsp - shadow) & ~15) - 8
        ql.stack_write(0, SENTINEL)
    else:
        # Before CALL the stack is 16-byte aligned; CALL pushes a 4-byte return.
        ql.arch.regs.esp = ((ql.arch.regs.esp - 4 * len(values)) & ~15) + 4 * len(values)
        for value in reversed(values):
            ql.stack_push(value)
        ql.stack_push(SENTINEL)


def worker(spec):
    import qiling
    from qiling import Qiling
    from qiling.const import QL_VERBOSE
    rootfs = Path(spec["rootfs"]).resolve()
    if not rootfs.is_dir():
        raise ValueError("rootfs does not exist in backend environment")
    if spec.get("probe"):
        return {"ok": True, "execution_status": "not_run", "observation_status": "inconclusive",
                "backend": {"engine": "qiling", "version": getattr(qiling, "__version__", "unknown"),
                            "python": sys.executable, "rootfs": str(rootfs)},
                "limitations": ["dependency probe only; ABI/rootfs runtime compatibility unverified"], "target_accepted": None}
    validate_spec(spec)
    original = Path(spec["binary"])
    if hashlib.sha256(original.read_bytes()).hexdigest() != spec["target_sha256"]:
        raise ValueError("target changed before worker execution")
    staging = rootfs / "tmp"
    staging.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oracle-", dir=staging) as directory:
        binary = Path(directory) / original.name
        shutil.copyfile(original, binary)
        ql = Qiling([str(binary)], str(rootfs), verbose=QL_VERBOSE.OFF)
        images = [im for im in ql.loader.images if Path(im.path).resolve() == binary.resolve()]
        if len(images) != 1:
            raise ValueError("main runtime image cannot be uniquely identified")
        runtime_base = images[0].base
        to_rt = lambda addr: runtime_base + addr - spec["image_base"]
        pc = lambda: ql.arch.regs.rip if spec["bits"] == 64 else ql.arch.regs.eip
        if spec["init_until"] is not None:
            destination = to_rt(spec["init_until"])
            ql.run(end=destination, timeout=int(spec["timeout"] * 1_000_000))
            if pc() != destination:
                return {"ok": False, "execution_status": "partial", "observation_status": "inconclusive",
                        "stop_reason": "initialization_not_reached", "final_pc": hex(pc()), "retval": None,
                        "target_accepted": None}
        hits, dumps, captured = 0, [], []
        entered = False
        def trace(ql, address, size):
            nonlocal hits, entered
            entered |= address == to_rt(spec["func"])
            if spec["break_at"] is None or address != to_rt(spec["break_at"]) or hits >= spec["max_hits"]:
                return
            hits += 1
            for expr in spec["dumps"]:
                item = {"expr": expr, "hit": hits}
                try:
                    target, sep, length = expr.partition(":")
                    m = re.fullmatch(r"([a-z][a-z0-9]*)(?:([+-])(0x[0-9a-fA-F]+|\d+))?", target)
                    if m and hasattr(ql.arch.regs, m[1]):
                        value = getattr(ql.arch.regs, m[1])
                        if m[2]:
                            value += int(m[3], 0) * (1 if m[2] == "+" else -1)
                    else:
                        value = to_rt(int(target, 0))
                    if sep:
                        data = bytes(ql.mem.read(value, int(length, 0)))
                        item.update(addr=hex(value), len=len(data), hex=data.hex())
                    else:
                        item["value"] = hex(value)
                except Exception as exc:
                    item["error"] = str(exc)
                dumps.append(item)
        ql.hook_code(trace)
        marshal_args(ql, spec)
        if spec["kind"] == "elf":
            from qiling.const import QL_INTERCEPT
            def hook_write(ql, fd, buf, count, retval):
                if fd in (1, 2) and retval > 0:
                    captured.append({"fd": fd, "hex": bytes(ql.mem.read(buf, min(count, retval))).hex()})
            ql.os.set_syscall("write", hook_write, QL_INTERCEPT.EXIT)
        error = None
        try:
            ql.run(begin=to_rt(spec["func"]), end=SENTINEL, timeout=int(spec["timeout"] * 1_000_000))
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        returned = error is None and entered and pc() == SENTINEL
        observation_ok = spec["break_at"] is None or (hits > 0 and all("error" not in d for d in dumps))
        ok = returned and observation_ok
        regs = ("rax", "rbx", "rdx", "rsi", "rdi", "rsp", "rip") if spec["bits"] == 64 else ("eax", "ebx", "edx", "esi", "edi", "esp", "eip")
        return {"ok": ok, "execution_status": "completed" if ok else "failed" if error else "partial",
                "observation_status": "observed" if ok else "inconclusive", "target_accepted": None,
                "retval": getattr(ql.arch.regs, regs[0]) if returned else None,
                "retval_valid": returned, "entry_reached": entered, "return_reached": returned,
                "stop_reason": "exception" if error else "end" if returned else "stopped_without_return",
                "error": error, "final_pc": hex(pc()), "func_runtime": hex(to_rt(spec["func"])),
                "break_hits": hits, "dumps": dumps, "writes": captured,
                "stdout": b"".join(bytes.fromhex(c["hex"]) for c in captured if c["fd"] == 1).decode("latin1"),
                "regs": {r: getattr(ql.arch.regs, r) for r in regs},
                "backend": {"engine": "qiling", "version": getattr(qiling, "__version__", "unknown"),
                            "python": sys.executable, "rootfs": str(rootfs), "runtime_base": hex(runtime_base)},
                "interventions": describe()["interventions"], "limitations": describe()["limitations"]}


def win_to_wsl(path):
    value = str(Path(path).resolve()).replace("\\", "/")
    if len(value) > 2 and value[1] == ":":
        return "/mnt/" + value[0].lower() + value[2:]
    raise ValueError("WSL transport requires a local drive path")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("binary", nargs="?")
    ap.add_argument("address", nargs="?")
    ap.add_argument("args", nargs="*")
    ap.add_argument("--describe", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--max-hits", type=int, default=1)
    ap.add_argument("--init-until", type=lambda x: int(x, 0))
    ap.add_argument("--break", dest="break_at", type=lambda x: int(x, 0))
    ap.add_argument("--dump", action="append", default=[])
    ap.add_argument("--image-base", type=lambda x: int(x, 0))
    ap.add_argument("--abi", choices=("sysv64", "win64", "cdecl"))
    ap.add_argument("--transport", choices=("native", "wsl"), default="wsl" if os.name == "nt" else "native")
    ap.add_argument("--python", default=os.environ.get("DSH_QILING_PYTHON"))
    ap.add_argument("--rootfs", default=os.environ.get("DSH_QILING_ROOTFS"))
    ap.add_argument("--wsl-distro", default=os.environ.get("DSH_QILING_WSL_DISTRO"))
    ap.add_argument("--out")
    legacy = [a[1:] for a in argv if a.startswith("@")]
    args = ap.parse_intermixed_args([a for a in argv if not a.startswith("@")])
    out = args.out or (legacy[-1] if legacy else None)
    if out and args.binary and Path(out).resolve() == Path(args.binary).resolve():
        print(json.dumps({"ok": False, "error": "output cannot overwrite target"}))
        return 2
    code = 1
    try:
        if args.describe:
            result, code = describe(), 0
        else:
            if not args.binary or not args.address:
                raise ValueError("binary and function address are required")
            if not args.rootfs:
                raise ValueError("set --rootfs or DSH_QILING_ROOTFS for the selected backend")
            binary = Path(args.binary).resolve()
            info = inspect_binary(binary)
            spec = dict(info, binary=str(binary), func=int(args.address, 16),
                        args=[a[4:] if a.startswith("str:") else int(a, 16) if a.lower().startswith("0x") else int(a) for a in args.args],
                        timeout=args.timeout, max_hits=args.max_hits, init_until=args.init_until,
                        break_at=args.break_at, dumps=args.dump, rootfs=args.rootfs, probe=args.check)
            if args.image_base is not None:
                spec["image_base"] = args.image_base
            if args.abi:
                spec["abi"] = args.abi
            validate_spec(spec)
            convert = win_to_wsl if args.transport == "wsl" else lambda p: str(Path(p).resolve())
            if args.transport == "wsl" and os.name != "nt":
                raise ValueError("use native transport inside Linux/WSL")
            spec["binary"] = convert(binary)
            prefix = []
            if args.transport == "wsl":
                prefix = ["wsl"] + (["-d", args.wsl_distro] if args.wsl_distro else []) + ["--"]
            interpreter = args.python or ("python3" if prefix else sys.executable)
            with tempfile.TemporaryDirectory(prefix="function-oracle-") as directory:
                request, response = Path(directory) / "request.json", Path(directory) / "result.json"
                request.write_text(json.dumps(spec), encoding="utf-8")
                command = prefix + [interpreter, convert(__file__), "--worker", convert(request), convert(response)]
                proc = subprocess.run(command, capture_output=True, text=True, timeout=2 * args.timeout + 30)
                if not response.is_file():
                    raise RuntimeError("worker produced no result: " + (proc.stderr or proc.stdout)[-2000:])
                result = json.loads(response.read_text(encoding="utf-8"))
                if proc.returncode and result.get("ok"):
                    result.update(ok=False, execution_status="failed", error="worker exited unsuccessfully")
            result.update(target_sha256=info["target_sha256"], abi=spec["abi"], image_base=hex(spec["image_base"]),
                          transport=args.transport, target_accepted=None)
            if hashlib.sha256(binary.read_bytes()).hexdigest() != info["target_sha256"]:
                result.update(ok=False, execution_status="failed", error="target changed during experiment")
            code = 0 if result.get("ok") else 1
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        result = {"ok": False, "execution_status": "failed", "observation_status": "inconclusive",
                  "error": str(exc), "target_accepted": None}
        code = 2 if isinstance(exc, ValueError) else 1
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if out:
        Path(out).write_text(text + "\n", encoding="utf-8")
    return code


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        try:
            result = worker(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
        except Exception as exc:
            result = {"ok": False, "execution_status": "unavailable" if isinstance(exc, ImportError) else "failed",
                      "observation_status": "inconclusive", "error": f"{type(exc).__name__}: {exc}", "target_accepted": None}
        Path(sys.argv[3]).write_text(json.dumps(result), encoding="utf-8")
        sys.exit(0 if result.get("ok") else 1)
    sys.exit(main())
