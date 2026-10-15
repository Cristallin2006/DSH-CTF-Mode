#!/usr/bin/env python3
"""把本仓库的钩子片段幂等合并进 ~/.dsh/hooks/hooks.json。

按 (事件, command) 为 key 去重;已存在的其它条目原样保留。
若同一事件下已有同名脚本但 command 不同,报错退出,不静默覆盖。

用法: python3 install.py [--home ~/.dsh] [--dry-run]
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

EVENTS = ["SessionStart", "SubagentStart", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]
SELF = "analysis_hook.py"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=str(Path.home() / ".dsh"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    hooks_dir = Path(a.home) / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    target = hooks_dir / "hooks.json"

    src = Path(__file__).resolve().parent
    # 钩子脚本本体放到 hooks 目录;片段中的 ${CLAUDE_PLUGIN_ROOT} 指该目录
    shutil.copy2(src / "analysis_hook.py", hooks_dir / "analysis_hook.py")

    cfg = {"hooks": {}}
    if target.is_file():
        cfg = json.loads(target.read_text(encoding="utf-8"))
    cfg.setdefault("hooks", {})

    entry = {
        "type": "command",
        "command": 'python3 "${CLAUDE_PLUGIN_ROOT}/analysis_hook.py"',
        "timeout": 10,
    }
    for ev in EVENTS:
        groups = cfg["hooks"].setdefault(ev, [])
        if not groups:
            groups.append({"hooks": []})
        lst = groups[0].setdefault("hooks", [])
        for h in lst:
            cmd = h.get("command", "")
            if SELF in cmd:
                if cmd != entry["command"]:
                    print(f"冲突:{ev} 已有不同的 {SELF} 条目: {cmd}", file=sys.stderr)
                    return 2
                break
        else:
            lst.append(dict(entry))

    if a.dry_run:
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
        return 0
    target.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已合并写入 {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
