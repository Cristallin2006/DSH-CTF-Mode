#!/usr/bin/env python3
"""Verify one unchanged target with baseline, positive and negative controls."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path


def run_case(name, case, base, argv, cwd, timeout):
    if any(key in case for key in ("argv", "cwd", "env", "target")):
        raise ValueError(f"{name}: target and command must be shared at top level")
    if "stdin" in case and "stdin_file" in case:
        raise ValueError(f"{name}: use either stdin or stdin_file")
    data = ((base / case["stdin_file"]).read_bytes() if "stdin_file" in case
            else str(case.get("stdin", "")).encode())
    expect = case.get("expect", {})
    if not isinstance(expect, dict):
        raise ValueError(f"{name}.expect must be an object")
    started = time.monotonic()
    try:
        proc = subprocess.run(argv, input=data, cwd=cwd, capture_output=True,
                              timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"name": name, "valid": False, "failures": [str(exc)]}
    stdout = proc.stdout.decode("utf-8", "replace")
    stderr = proc.stderr.decode("utf-8", "replace")
    elapsed = round((time.monotonic() - started) * 1000)
    failures = []
    if proc.returncode not in expect.get("exit_codes", [0]):
        failures.append(f"exit code {proc.returncode} unexpected")
    for stream, value in (("stdout", stdout), ("stderr", stderr)):
        if f"{stream}_contains" in expect and expect[f"{stream}_contains"] not in value:
            failures.append(f"{stream} missing expected text")
        if f"{stream}_regex" in expect and not re.search(expect[f"{stream}_regex"], value):
            failures.append(f"{stream} missing expected regex")
    if elapsed < expect.get("min_duration_ms", 0):
        failures.append("finished too quickly for expected behavior")
    if expect.get("nonempty_output") and not (stdout or stderr):
        failures.append("both output streams empty")
    if re.search(r"(import_dll.*not found|c0000135|failed to load.*dll)", stderr, re.I):
        failures.append("loader/DLL failure; program behavior was not observed")
    return {"name": name, "argv": argv, "cwd": str(cwd),
            "stdin": data.decode("utf-8", "replace"), "exit_code": proc.returncode,
            "duration_ms": elapsed, "stdout": stdout, "stderr": stderr,
            "valid": not failures, "failures": failures}


def success_matches(case, success):
    checks = []
    for field, stream in (("stdout_regex", "stdout"), ("stderr_regex", "stderr")):
        if field in success:
            match = re.search(success[field], case[stream])
            checks.append(bool(match))
            if match and match.group() and match.group() in case["stdin"]:
                return False, "success marker occurs in supplied input (possible echo)"
    if "exit_codes" in success:
        checks.append(case["exit_code"] in success["exit_codes"])
    return all(checks), ""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cases", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    try:
        spec = json.loads(args.cases.read_text(encoding="utf-8"))
        base = args.cases.resolve().parent
        timeout = float(spec.get("timeout", 30))
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        target = (base / spec["target"]).resolve()
        if not target.is_file():
            raise ValueError(f"target file not found: {target}")
        target_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
        raw_argv = spec["argv"]
        if (not isinstance(raw_argv, list) or not raw_argv
                or not all(isinstance(x, str) for x in raw_argv)
                or sum("{target}" in x for x in raw_argv) != 1):
            raise ValueError("top-level argv must contain exactly one {target} placeholder")
        argv = [arg.replace("{target}", str(target)) for arg in raw_argv]
        cwd = (base / spec.get("cwd", ".")).resolve()
        success = spec["success"]
        if (not isinstance(success, dict) or not success
                or set(success) - {"stdout_regex", "stderr_regex", "exit_codes"}):
            raise ValueError("success must declare stdout_regex, stderr_regex or exit_codes")
        if not spec["baseline"].get("expect"):
            raise ValueError("baseline must declare expected behavior")
        cases = [run_case(name, spec[name], base, argv, cwd, timeout)
                 for name in ("baseline", "positive", "negative")]
        pos, neg = cases[1:]
        failures = [f"{case['name']}: {failure}" for case in cases
                    for failure in case["failures"]]
        distinguishes = (pos.get("stdout"), pos.get("stderr"), pos.get("exit_code")) != (
            neg.get("stdout"), neg.get("stderr"), neg.get("exit_code"))
        if not distinguishes:
            failures.append("positive and negative have identical observable outcomes")
        if hashlib.sha256(target.read_bytes()).hexdigest() != target_sha256:
            failures.append("target changed during control runs")
        if pos["valid"] and neg["valid"]:
            good, reason = success_matches(pos, success)
            bad, _ = success_matches(neg, success)
            if not good:
                failures.append("positive did not satisfy success predicate" +
                                (f": {reason}" if reason else ""))
            if bad:
                failures.append("negative also satisfied success predicate")
        result = {"ok": not failures, "target": str(target),
                  "target_sha256": target_sha256,
                  "independent_processes": True, "distinguishes": distinguishes,
                  "cases": cases, "failures": failures}
        output = json.dumps(result, ensure_ascii=False, indent=2)
        if args.out:
            args.out.write_text(output + "\n", encoding="utf-8")
        print(output)
        return 0 if result["ok"] else 2
    except (OSError, ValueError, KeyError, TypeError, re.error) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
