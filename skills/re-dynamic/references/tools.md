# 本 skill 工具入口

按当前问题选择工具，用 --help 查参数；工具是否可用以发现/功能探针为准。

| 脚本 | 用途线索 |
|---|---|
| `scripts/frida_time_hook.py` | frida_time_hook.py - 覆写时间/随机源，让未修改的二进制在指定时间下自己产出 flag。 |
| `scripts/gdbkit.py` | gdbkit.py - gdb python 插桩公共库（re-dynamic）。 |
| `scripts/layer_dump.py` | layer_dump.py — 分层运行时解密样本的「gdb 断点 dump → objdump → strings」一条龙。 |
| `scripts/nes_state_probe.py` | Validate a debugger-assisted NES one-byte RAM experiment and hash artifacts. |
| `scripts/oracle.py` | oracle.py - function-level oracle + breakpoint memory dump. |
| `scripts/oracle_family.py` | oracle_family.py - 打桩 oracle 家族：单因子隔离（铁律 14 判定性实验的批量形态）。 |
| `scripts/program_oracle.py` | Verify one unchanged target with baseline, positive and negative controls. |
| `scripts/win_gui_drive.py` | win_gui_drive.py - Windows GUI 消息驱动 oracle（驱动模态对话框 GUI 批量试输入）。 |
| `scripts/windows_oracle_receipt.py` | Bind observed Windows runs to a sample and evidence files; never infer acceptance. |
