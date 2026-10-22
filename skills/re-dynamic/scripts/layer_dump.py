#!/usr/bin/env python3
"""layer_dump.py — 分层运行时解密样本的「gdb 断点 dump → objdump → strings」一条龙。

判例 c50c8812：同一模式（loader 返回断点 → dump 解密页 →
objdump -D 线性反汇编 → strings）被手写 heredoc 重复 4 次（g9/g12/g13/g17.gdb）。
本脚本把它固化成一次调用。

典型用法（在「本层解密完成、下一层尚未执行」的断点处取层，如 loader 返回点）：

    python3 layer_dump.py ./glitch --break 0x40115d \\
        --dump 0x405000:0x1000:s2.bin --dump 0x406000:0x1000:s3.bin \\
        --input in_s1.txt --pass-signals --disasm --strings

- --break 只在第一次命中时 dump 并退出（dump 完即 quit，程序不继续跑）。
- --pass-signals：SIGILL/SIGSEGV/SIGBUS nostop noprint pass——自定义信号
  handler 是正常执行路径的样本（UD2 磁带/页故障合成）在断点前会被信号停住时加。
  **不含 SIGTRAP**：gdb 的断点/单步内部复用 SIGTRAP，pass 掉会让程序直接死
  （本脚本实测：pass SIGTRAP 后 Program terminated with signal SIGTRAP）。
- --disasm 产物 = OUT.dis（objdump -D 线性反汇编，--adjust-vma 对齐到 VA）。
  线性反汇编会从密文/数据里解出垃圾指令，读 .dis 时以地址为锚，别信 CFG。
- 取层之后需要 xref/反编译（而非线性反汇编）时走重载管线：
  `python3 rpc_driver.py import-raw <原样本> OUT --base 0x<VA> [--entry 0x…]`
  ——按原 VA 把 dump 导入为新程序（共享原样本的 language），之后
  decompile/xrefs 直接对它用（第二参传程序名，见 rpc_driver passthrough）。

exit: 0 成功 / 2 用法错 / 3 gdb 或 objdump 缺失 / 4 断点未命中（零 dump 产出）
stdlib only，不经 daemon。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import shlex
from pathlib import Path
import uuid

_SIGNALS = ("SIGILL", "SIGSEGV", "SIGBUS")  # 不含 SIGTRAP：gdb 内部复用，pass 即程序死（实测）


def _parse_dump(spec):
    """VA:LEN:OUT -> (va, length, out)。VA 必须 0x 十六进制，LEN 支持 0x。"""
    parts = spec.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"--dump 格式必须是 VA:LEN:OUT，收到 {spec!r}")
    va_s, len_s, out = parts
    va = int(va_s, 16)
    length = int(len_s, 16) if len_s.lower().startswith("0x") else int(len_s)
    if length <= 0:
        raise ValueError(f"--dump 长度必须为正：{spec!r}")
    if not out:
        raise ValueError(f"--dump 输出路径为空：{spec!r}")
    return va, length, out


def _build_gdb_script(args, dumps):
    lines = ["set pagination off", "set confirm off"]
    if args.pass_signals:
        for sig in _SIGNALS:
            lines.append(f"handle {sig} nostop noprint pass")
    lines.append(f"break *{args.breakpoint}")
    lines.append("commands")
    lines.append("silent")
    lines.append(f'printf "{args.hit_marker}\\n"')
    for va, length, out in dumps:
        lines.append(f'dump binary memory {json.dumps(out)} {va:#x} {va + length:#x}')
    lines.append("quit")
    lines.append("end")
    run = "run"
    if args.input:
        run += " < " + shlex.quote(str(Path(args.input).resolve()))
    else:
        run += " < /dev/null"
    lines.append(run)
    return "\n".join(lines) + "\n"


def _strings(path, va, min_len=5):
    data = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, data):
        out.append(f"{va + m.start():#x}  {m.group().decode('ascii')}")
    return out


def describe():
    return {"tool": "layer-dump", "contract_version": 1,
            "host": "Linux/WSL GDB batch; addresses are runtime virtual addresses",
            "dependencies": ["gdb", "objdump only with --disasm"],
            "interventions": ["debugger breakpoint", "optional signal forwarding", "target terminated after dump"],
            "limitations": ["no automatic PIE rebasing", "linear disassembly is not a CFG",
                            "--disasm-machine defaults to i386:x86-64; select the target machine explicitly"],
            "target_accepted": None}


def publish(path, data):
    """Replace the directory entry, never truncate through an existing link."""
    fd, temporary = tempfile.mkstemp(prefix=".layer-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--describe"]:
        print(json.dumps(describe())); return 0
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("binary")
    ap.add_argument("--break", "-b", dest="breakpoint", required=True)
    ap.add_argument("--dump", action="append", required=True, metavar="VA:LEN:OUT")
    ap.add_argument("--input")
    ap.add_argument("--pass-signals", action="store_true", help="forward SIGILL/SIGSEGV/SIGBUS; never SIGTRAP")
    ap.add_argument("--disasm", action="store_true")
    ap.add_argument("--disasm-machine", default="i386:x86-64")
    ap.add_argument("--strings", action="store_true")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--keep-gdb", action="store_true")
    ap.add_argument("--check", action="store_true", help="validate paths and tool discovery without running target")
    ap.add_argument("--out", help="JSON receipt path")
    args = ap.parse_args(argv)
    protected = [Path(p).resolve() for p in (args.binary, args.input) if p]
    named_outputs = [Path(value.split(":", 2)[2]).resolve() for value in args.dump if len(value.split(":", 2)) == 3]
    protected += named_outputs + ([Path(str(path) + ".dis").resolve() for path in named_outputs] if args.disasm else [])
    if args.out and Path(args.out).resolve() in protected:
        print(json.dumps({"ok": False, "error": "receipt cannot overwrite target/input"}))
        return 2
    result = {"ok": False, "execution_status": "failed", "observation_status": "inconclusive",
              "target_accepted": None, "artifacts": [], "limitations": describe()["limitations"],
              "interventions": ["debugger breakpoint"] + (["signal forwarding"] if args.pass_signals else [])}
    code = 4
    try:
        binary = Path(args.binary).resolve()
        if not binary.is_file() or args.timeout <= 0:
            raise ValueError("existing binary and positive timeout required")
        args.breakpoint = hex(int(args.breakpoint, 0))
        if int(args.breakpoint, 0) < 0:
            raise ValueError("negative breakpoint address")
        dumps = [_parse_dump(value) for value in args.dump]
        destinations = [Path(out).resolve() for _, _, out in dumps]
        if len(set(destinations)) != len(destinations) or binary in destinations:
            raise ValueError("dump destinations must be distinct and cannot overwrite target")
        if args.disasm:
            dis_paths = [Path(str(path) + ".dis").resolve() for path in destinations]
            protected = destinations + [binary] + ([Path(args.input).resolve()] if args.input else [])
            if any(path in protected for path in dis_paths) or args.out and Path(args.out).resolve() in dis_paths:
                args.out = None
                raise ValueError("disassembly outputs overlap other inputs/outputs")
        if args.input and (not Path(args.input).is_file() or Path(args.input).resolve() in destinations):
            raise ValueError("input must exist and cannot be a dump destination")
        if args.out and Path(args.out).resolve() in destinations + [binary]:
            args.out = None
            raise ValueError("receipt cannot overwrite target or dump")
        if any(va < 0 for va, _, _ in dumps):
            raise ValueError("negative dump address")
        for path in destinations:
            if not path.parent.is_dir():
                raise ValueError("dump parent directory must exist")
        gdb = shutil.which("gdb")
        if not gdb or args.disasm and not shutil.which("objdump"):
            result["execution_status"] = "unavailable"
            raise FileNotFoundError("required gdb/objdump not found")
        result["target_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        if args.check:
            result.update(ok=True, execution_status="not_run", backend={"gdb": gdb})
            code = 0
        else:
            # Only fresh files in this run's directory can become observations.
            with tempfile.TemporaryDirectory(prefix="layer-dump-") as directory:
                staged = [(va, length, str(Path(directory) / (str(i) + ".bin")))
                          for i, (va, length, _) in enumerate(dumps)]
                args.hit_marker = "LAYER_HIT_" + uuid.uuid4().hex
                script = _build_gdb_script(args, staged)
                script_path = Path(directory) / "run.gdb"
                script_path.write_text(script, encoding="utf-8")
                if args.keep_gdb:
                    fd, saved = tempfile.mkstemp(prefix="layer-dump-", suffix=".gdb")
                    with os.fdopen(fd, "w", encoding="utf-8") as stream:
                        stream.write(script)
                    result["gdb_script"] = saved
                proc = subprocess.run([gdb, "-nx", "-q", "-batch", "-x", str(script_path), str(binary)],
                                      capture_output=True, text=True, timeout=args.timeout)
                hit = args.hit_marker in proc.stdout
                result.update(gdb_exit_code=proc.returncode, breakpoint_hit=hit,
                              stdout=proc.stdout, stderr=proc.stderr)
                target_same = hashlib.sha256(binary.read_bytes()).hexdigest() == result["target_sha256"]
                valid = [hit and Path(out).is_file() and Path(out).stat().st_size == length
                         for _, length, out in staged]
                complete = proc.returncode == 0 and all(valid) and target_same
                # Preserve observed partial dumps explicitly; never reuse old destinations.
                for i, ((va, length, staged_path), destination) in enumerate(zip(staged, destinations)):
                    if not valid[i] or not target_same:
                        result["artifacts"].append({"path": str(destination), "status": "not_produced"})
                        continue
                    data = Path(staged_path).read_bytes()
                    # Same-directory replace keeps each published artifact atomic.
                    publish(destination, data)
                    result["artifacts"].append({"path": str(destination), "status": "observed",
                                                "address": hex(va), "length": length,
                                                "sha256": hashlib.sha256(data).hexdigest()})
                    if args.disasm:
                        dis = subprocess.run(["objdump", "-D", "-b", "binary", "-m", args.disasm_machine,
                                              f"--adjust-vma={va:#x}", str(destination)],
                                             capture_output=True, timeout=args.timeout)
                        if dis.returncode:
                            complete = False
                            result["artifacts"][-1]["disassembly_error"] = dis.stderr.decode("utf-8", "replace")
                        else:
                            publish(Path(str(destination) + ".dis"), dis.stdout)
                    if args.strings:
                        result["artifacts"][-1]["strings"] = _strings(destination, va)
                result.update(ok=complete, execution_status="completed" if complete else "partial" if any(valid) and target_same else "failed",
                              observation_status="observed" if complete else "inconclusive")
                if not target_same: result["error"] = "target changed during experiment"
                code = 0 if complete else 4
    except ValueError as exc:
        result["error"] = str(exc); code = 2
    except FileNotFoundError as exc:
        result["error"] = str(exc); code = 3
    except (OSError, subprocess.TimeoutExpired) as exc:
        result["error"] = str(exc); code = 4
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
