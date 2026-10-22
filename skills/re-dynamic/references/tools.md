# 本 skill 工具入口

按当前问题选择工具，用 --help 查参数；工具是否可用以发现/功能探针为准。

| 脚本 | 用途线索 |
|---|---|
| `scripts/frida_time_hook.py` | 覆写指定时间 API；自检与目标命中分开，不覆盖全部随机源。 |
| `scripts/gdbkit.py` | gdbkit.py - gdb python 插桩公共库（re-dynamic）。 |
| `scripts/layer_dump.py` | layer_dump.py — 分层运行时解密样本的「gdb 断点 dump → objdump → strings」一条龙。 |
| `scripts/nes_state_probe.py` | Validate a debugger-assisted NES one-byte RAM experiment and hash artifacts. |
| `scripts/oracle.py` | oracle.py - function-level oracle + breakpoint memory dump. |
| `scripts/oracle_family.py` | oracle_family.py - 打桩 oracle 家族：单因子隔离（铁律 14 判定性实验的批量形态）。 |
| `scripts/program_oracle.py` | Verify one unchanged target with baseline, positive and negative controls. |
| `scripts/win_gui_drive.py` | win_gui_drive.py - Windows GUI 消息驱动 oracle（驱动模态对话框 GUI 批量试输入）。 |
| `scripts/windows_oracle_receipt.py` | Bind observed Windows runs to a sample and evidence files; never infer acceptance. |

## 可查询契约与回执

- `oracle.py`、`frida_time_hook.py`、`layer_dump.py`、`local_bv_check.py --describe`：离线查询支持范围和结论边界。
- `oracle.py --check`：验证本次调用，并在所选解释器探测 Qiling/rootfs；不执行目标。配置见 function-oracle.md。
- `frida_time_hook.py --check`：保留所选运行模式/参数，检查参数与 Frida 导入；不附加进程或探测设备。`--list` 仍只生成脚本。
- `layer_dump.py --check`：验证本次路径、地址与工具发现；不启动 GDB。地址是运行时 VA，不自动重定位。
- `local_bv_check.py`：只求解声明的模型，无二进制执行；`ok=true` 仍需检查具体 status。

Frida 回执分开 installed、selfcheck、hits、selfcheck_hits、js_errors、cleanup_errors。零目标命中只表示未观察到；等待窗口到期为 partial/inconclusive。只清理本次 spawn 的进程，attach 不终止既有进程。非 Windows spawn 不捕获 stdout，pattern_match 无法据此判断。`--out` 保持生成物目录含义。

layer_dump stdout 改为 JSON 回执，退出码保留 0/2/3/4。`--out` 可保存回执；旧的人类文本消费者需改为读取 artifacts。只将本次临时目录中、断点命中后生成且长度正确的文件登记为 observed。部分 dump 可交付，但退出 4；未产生的输出路径可能仍有旧文件，不能当作本次证据。`--disasm-machine` 默认 i386:x86-64，其他架构须显式选择；线性反汇编不证明 CFG。

这些工具不会自行决定下一种分析方法或判断目标接受。简单实验无需强制绑定项目状态库。
