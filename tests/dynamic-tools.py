#!/usr/bin/env python3
"""Offline regressions for dynamic tool contracts. No unknown targets executed.

python tests/dynamic-tools.py
Real Qiling/GDB/Frida acceptance remains a separate backend integration lane.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/re-dynamic/scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


oracle, frida, layer = (load(name) for name in ("oracle", "frida_time_hook", "layer_dump"))


def elf(path, bits=64, machine=None, etype=3):
    data = bytearray(128)
    data[:7] = b"\x7fELF" + bytes([2 if bits == 64 else 1, 1, 1])
    struct.pack_into("<HH", data, 16, etype, machine if machine is not None else 62 if bits == 64 else 3)
    struct.pack_into("<Q" if bits == 64 else "<I", data, 32 if bits == 64 else 28, 64)
    struct.pack_into("<HH", data, 54 if bits == 64 else 42, 56 if bits == 64 else 32, 1)
    struct.pack_into("<I", data, 64, 1)
    struct.pack_into("<Q" if bits == 64 else "<I", data, 80 if bits == 64 else 72, 0 if etype == 3 else 0x400000)
    path.write_bytes(data)
    return path


def spec(**kwargs):
    values = dict(kind="elf", bits=64, abi="sysv64", args=[], timeout=1, max_hits=1,
                  func=0x101100, image_base=0x100000, init_until=None, break_at=None, dumps=[])
    values.update(kwargs)
    return values


class Memory:
    def __init__(self): self.writes = {}; self.mappings = []
    def map(self, address, size): self.mappings.append((address, size))
    def write(self, address, data): self.writes[address] = bytes(data)
    def read(self, address, size): return self.writes.get(address, bytes(size))[:size]


class QilingFixture:
    mode = "return"
    def __init__(self, binaries=None, rootfs=None, **kwargs):
        self.arch = types.SimpleNamespace(regs=types.SimpleNamespace(
            rsp=0x70001000, esp=0x70001000, rip=0, eip=0, rax=42, eax=42,
            rbx=0, rdx=0, rsi=0, rdi=0, ebx=0, edx=0, esi=0, edi=0))
        self.mem = Memory(); self.stack = {}; self.hook = None
        self.loader = types.SimpleNamespace(images=[types.SimpleNamespace(path=binaries[0], base=0x600000)] if binaries else [])
        self.os = types.SimpleNamespace(set_syscall=lambda *a: None)
    def stack_write(self, offset, value): self.stack[self.arch.regs.rsp + offset] = value
    def stack_push(self, value):
        self.arch.regs.esp -= 4; self.stack[self.arch.regs.esp] = value
    def hook_code(self, callback): self.hook = callback
    def run(self, begin=None, end=None, **kwargs):
        if begin is not None:
            self.hook(self, begin, 1)
        if self.mode == "exception": raise RuntimeError("fixture exception")
        self.arch.regs.rip = end if self.mode == "return" else 0x600123
        self.arch.regs.eip = self.arch.regs.rip


class OracleTests(unittest.TestCase):
    def test_header_rejection(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "sample"
            elf(path, machine=183)
            with self.assertRaisesRegex(ValueError, "machine"): oracle.sniff(path)
            path.write_bytes(bytes(128))
            with self.assertRaises(ValueError): oracle.sniff(path)
            path.write_bytes(b"MZ")
            with self.assertRaises(ValueError): oracle.sniff(path)

    def test_valid_headers_and_bases(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "sample"
            self.assertEqual(oracle.inspect_binary(elf(path))["image_base"], 0x100000)
            self.assertEqual(oracle.inspect_binary(elf(path, bits=32, etype=2))["image_base"], 0x400000)
            data = bytearray(256); data[:2] = b"MZ"
            struct.pack_into("<I", data, 60, 64); data[64:68] = b"PE\0\0"
            struct.pack_into("<H", data, 68, 0x8664); struct.pack_into("<H", data, 84, 112)
            struct.pack_into("<H", data, 88, 0x20B); struct.pack_into("<Q", data, 112, 0x140000000)
            path.write_bytes(data)
            self.assertEqual(oracle.inspect_binary(path)["image_base"], 0x140000000)

    def test_excess_parameters_and_invalid_contract(self):
        for document in [spec(args=list(range(7))), spec(args=["a\0b"]), spec(timeout=float("nan")),
                         spec(args=["字" * 30000]), spec(abi="win64"), spec(dumps=["rax:4"]),
                         spec(args=[1 << 65])]:
            with self.subTest(document=str(document)[:70]), self.assertRaises(ValueError):
                oracle.validate_spec(document)

    def test_x64_stack_and_utf8(self):
        for abi, kind in (("sysv64", "elf"), ("win64", "pe")):
            ql = QilingFixture(); document = spec(abi=abi, kind=kind, args=["字" * 10, "NEXT", 9])
            oracle.validate_spec(document); oracle.marshal_args(ql, document)
            self.assertEqual(ql.arch.regs.rsp % 16, 8)
            self.assertEqual(ql.stack[ql.arch.regs.rsp], oracle.SENTINEL)
            registers = oracle.ARG_REGS[abi]
            a, b = (getattr(ql.arch.regs, r) for r in registers[:2])
            self.assertGreaterEqual(b, a + 31)
            self.assertEqual(ql.mem.writes[a], ("字" * 10).encode() + b"\0")
            if abi == "win64": self.assertLessEqual(ql.arch.regs.rsp + 40, 0x70001000)

    def test_i386_stack(self):
        ql = QilingFixture(); oracle.marshal_args(ql, spec(bits=32, abi="cdecl", args=[1, 2, 3]))
        sp = ql.arch.regs.esp
        self.assertEqual(sp % 16, 12)
        self.assertEqual([ql.stack[sp + 4*i] for i in range(4)], [oracle.SENTINEL, 1, 2, 3])

    def test_worker_return_and_nonreturn(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = elf(Path(directory) / "sample")
            document = spec(binary=str(path), rootfs=directory, **oracle.inspect_binary(path))
            constants = types.SimpleNamespace(QL_VERBOSE=types.SimpleNamespace(OFF=0), QL_INTERCEPT=types.SimpleNamespace(EXIT=1))
            fake = types.SimpleNamespace(Qiling=QilingFixture, __version__="test-double")
            with patch.dict(sys.modules, {"qiling": fake, "qiling.const": constants}):
                for mode in ("return", "stopped", "exception"):
                    with self.subTest(mode=mode), patch.object(QilingFixture, "mode", mode):
                        result = oracle.worker(document)
                        self.assertEqual(result["ok"], mode == "return")
                        self.assertEqual(result["retval"], 42 if mode == "return" else None)
                        self.assertIsNone(result["target_accepted"])
                        self.assertEqual(list((Path(directory) / "tmp").iterdir()), [])
                custom = dict(document, image_base=0x200000, func=0x201100)
                self.assertEqual(oracle.worker(custom)["func_runtime"], "0x601100")

    def test_output_cannot_overwrite_target(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = elf(Path(directory) / "sample"); original = path.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(oracle.main([str(path), "0x101100", "--out", str(path)]), 2)
            self.assertEqual(path.read_bytes(), original)


class FridaTests(unittest.TestCase):
    def test_failure_semantics(self):
        cases = [{"installed": None}, {"installed": {"hooked": ["time"]}, "js_errors": ["error"]},
                 {"installed": {"hooked": ["time"]}, "timeout": True},
                 {"installed": {"hooked": ["time"]}, "selfcheck": {"ok": False}}]
        for result in cases:
            with self.subTest(result=result):
                result["hits"] = 1
                self.assertFalse(frida.finalize_run(result, "selfcheck" in result)["ok"])

    def test_zero_hits_not_a_target_conclusion(self):
        result = frida.finalize_run({"installed": {"hooked": ["time"]}, "hits": 0})
        self.assertFalse(result["ok"])
        self.assertEqual(result["observation_status"], "not_observed")
        self.assertIsNone(result["target_accepted"])

    def test_owned_attach_failure_cleans_up(self):
        events = []
        spawn = types.SimpleNamespace(pid=123, terminate=lambda: events.append("terminate"),
            wait=lambda t: 1, drain=lambda: ("", ""), close=lambda: events.append("close"))
        device = types.SimpleNamespace(attach=lambda pid: (_ for _ in ()).throw(RuntimeError("attach failed")))
        args = types.SimpleNamespace(selfcheck=False)
        with patch.object(frida, "IS_WINDOWS", True), patch.object(frida, "_spawn_suspended_win32", return_value=spawn):
            result = frida.run_one(device, "", args, ["fixture"])
        self.assertFalse(result["ok"])
        self.assertEqual(events, ["terminate", "close"])

    def test_attached_timeout_does_not_kill(self):
        events = []; handlers = {}
        class Script:
            def on(self, name, callback): handlers[name] = callback
            def load(self):
                handlers["message"]({"type": "send", "payload": {"t": "installed", "hooked": ["time"]}}, None)
                handlers["message"]({"type": "send", "payload": {"t": "hit", "origin": "selfcheck"}}, None)
            def unload(self): events.append("unload")
        session = types.SimpleNamespace(create_script=lambda js: Script(), on=lambda *a: None, detach=lambda: events.append("detach"))
        device = types.SimpleNamespace(attach=lambda pid: session, kill=lambda pid: events.append("kill"))
        result = frida.run_one(device, "", types.SimpleNamespace(pid=123, selfcheck=False, timeout=0.001), None)
        self.assertFalse(result["ok"]); self.assertEqual(result["hits"], 0)
        self.assertEqual(result["selfcheck_hits"], 1)
        self.assertEqual(events, ["unload", "detach"])
        self.assertEqual(result["observation_status"], "inconclusive")

    def test_templates_separate_selfcheck(self):
        for source in frida.SOURCES:
            js = frida.build_script(source, 1700000000, selfcheck=True, all_clocks=False)
            self.assertIn("origin: selfChecking", js)
            self.assertIn("finally { selfChecking = false; }", js)

    def test_generated_hook_cannot_overwrite_target(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "hook_linux_1700000000.js"
            path.write_bytes(b"original target")
            with self.assertRaisesRegex(ValueError, "overwrite"):
                frida.write_hook(path, "generated", path)
            self.assertEqual(path.read_bytes(), b"original target")

    def test_generated_hook_cannot_overwrite_linked_target(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "sample"
            path.write_bytes(b"original target")
            alias = Path(directory) / "alias.js"
            try: os.link(path, alias)
            except (OSError, NotImplementedError) as exc: self.skipTest("hard links unavailable: " + str(exc))
            with self.assertRaisesRegex(ValueError, "overwrite"):
                frida.write_hook(alias, "generated", path)
            self.assertEqual(path.read_bytes(), b"original target")

    def test_unexpected_detach_is_not_success(self):
        result = frida.finalize_run({"installed": {"hooked": ["time"]}, "hits": 2, "detach_reason": "connection-terminated"})
        self.assertFalse(result["ok"])


class LayerTests(unittest.TestCase):
    def test_publish_does_not_truncate_linked_target(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory); target = root / "sample"; target.write_bytes(b"original")
            sidecar = root / "dump.bin.dis"
            try: os.link(target, sidecar)
            except (OSError, NotImplementedError) as exc: self.skipTest("hard links unavailable: " + str(exc))
            layer.publish(sidecar, b"disassembly")
            self.assertEqual(target.read_bytes(), b"original")
            self.assertEqual(sidecar.read_bytes(), b"disassembly")

    def experiment(self, fresh, returncode=0):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory); binary = root / "sample"; binary.write_bytes(b"fixture")
            paths = [root / "first dump.bin", root / "second.bin"]
            for path in paths: path.write_bytes(b"OLD!")
            def run(command, **kwargs):
                script = Path(command[command.index("-x") + 1]).read_text(encoding="utf-8")
                outputs = re.findall(r'dump binary memory (".*?") ', script)
                for index in fresh:
                    Path(json.loads(outputs[index])).write_bytes(b"NEW!")
                marker = re.search(r'LAYER_HIT_[a-f0-9]+', script)[0] if fresh else ""
                return types.SimpleNamespace(returncode=returncode, stdout=marker, stderr="")
            argv = [str(binary), "--break", "0x401000"]
            for path in paths: argv += ["--dump", "0x402000:4:" + str(path)]
            stream = io.StringIO()
            with patch.object(layer.shutil, "which", return_value="fake-gdb"), patch.object(layer.subprocess, "run", side_effect=run), contextlib.redirect_stdout(stream):
                code = layer.main(argv)
            return code, json.loads(stream.getvalue()), [p.read_bytes() for p in paths]

    def test_old_files_are_not_observations(self):
        code, result, data = self.experiment([], 1)
        self.assertEqual(code, 4); self.assertFalse(result["ok"])
        self.assertEqual(data, [b"OLD!", b"OLD!"])
        self.assertTrue(all(a["status"] == "not_produced" for a in result["artifacts"]))

    def test_partial_is_not_complete(self):
        code, result, data = self.experiment([0], 1)
        self.assertEqual(code, 4); self.assertEqual(result["execution_status"], "partial")
        self.assertEqual(data, [b"NEW!", b"OLD!"])

    def test_complete_publishes_fresh_files(self):
        code, result, data = self.experiment([0, 1])
        self.assertEqual(code, 0); self.assertTrue(result["ok"])
        self.assertEqual(data, [b"NEW!", b"NEW!"])


class CLITests(unittest.TestCase):
    def test_describe_needs_no_backend(self):
        for name in ("oracle", "frida_time_hook", "layer_dump", "local_bv_check"):
            with self.subTest(name=name):
                result = subprocess.run([sys.executable, str(SCRIPTS / (name + ".py")), "--describe"], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(json.loads(result.stdout)["target_accepted"])


@unittest.skipUnless(os.name == "nt", "Windows CreateProcess fixture")
class WindowsProcessTests(unittest.TestCase):
    def test_real_spawn_arguments_capture_and_close(self):
        values = ["a b", 'quote"value', "end\\"]
        child = frida._spawn_suspended_win32(sys.executable, ["-c", "import json,sys; print(json.dumps(sys.argv[1:]))"] + values)
        try:
            child.resume()
            self.assertEqual(child.wait(5), 0)
            out, err = child.drain()
            self.assertEqual(json.loads(out), values)
            self.assertEqual(err, "")
        finally:
            child.terminate(); child.close()

    def test_real_suspended_child_can_be_cleaned(self):
        child = frida._spawn_suspended_win32(sys.executable, ["-c", "pass"])
        try:
            child.terminate()
            self.assertIsNotNone(child.wait(1))
        finally:
            child.close()


if __name__ == "__main__":
    unittest.main()
