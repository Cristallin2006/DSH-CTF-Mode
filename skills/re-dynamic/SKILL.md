---
name: re-dynamic
description: 观察程序基线、验证假设，使用 GDB、Frida、Qiling、函数/程序 oracle 和 trace。可直接动态先行；后端、干预与适用条件需记录，不把仿真结果等同原平台。
---

# re-dynamic

## 输入与输出

输入为样本/进程、运行条件、假设和实验；输出为命令、目标哈希/代次、环境/干预、输入、原始输出/trace、结论范围。

## 最短可用流程

检查格式、架构和启动条件，按风险选择隔离环境与运行后端。WSL 内直接执行 Linux 命令：`./sample`、`gdb ./sample`、`qemu-riscv64 ./sample`；PE 可选择 Wine、隔离 Windows 原生运行或仿真并注明后端。不用 Windows 的 wsl 包装命令作为 Linux 默认流程。

基线/正负例判据见 references/oracle-health.md。`scripts/program_oracle.py` 固定哈希、命令和实际输出；未知正例时仅做启动诊断。`scripts/oracle.py` 是 Qiling 函数调用入口，参数/初始化/地址换算见 references/function-oracle.md，ABI、libc 与 rootfs 不匹配时回到实际进程核验。

oracle、Frida 时间 hook、layer_dump 和 local_bv_check 可用 `--describe` 查询契约，不运行目标。前三者可按需 `--check`；检查范围随工具不同，不把依赖检查当作运行成功。执行结果按状态、停止原因、实际观察和干预解释；细节见 references/tools.md。

## 选择实验

数据恢复模型与实际输出不一致时，核对位宽、读数、ABI 和初始状态，再按差异选断点、trace 或局部模型；不强制某个调试器。静态数据与未知变换的入口见 ghidra-static 的 references/data-driven-recovery.md。

GDB 用于断点、内存与控制流；Frida 用于真实进程插桩；Qiling 用于可控函数/系统调用实验；符号执行适合可控路径约束，评估模型覆盖和规模后使用。可重复调试模板用 gdbkit.py，也可写必要的手工脚本。

`scripts/layer_dump.py` 可保存解密层；需要 Ghidra xref 时 import-raw 保留基址和 OEP。`scripts/oracle_family.py` 打桩隔离因子；在有限输入、路径和常量干预下输出不变，只支持“未观察到影响”。改变返回值可能改变控制流，应对照基线。time/random hook 改变运行环境，文件未改不自动构成独立验证。

验证说明共享引擎、ABI、模型和输入假设等错误来源。Qiling 与 Unicorn 有共享基础；不同引擎有更强交叉检查价值，但不用“零共享”二分判断。普通 Wine 行为不能代替依赖 Windows 特性的原生结果。静态与运行结果冲突、变换尝试未缩小解释或准备作全局负面结论时，读取 [覆盖缺口复核](references/coverage-review.md)；按待区分命题选方法，不按尝试次数强制某个工具。干预实验、候选与未干预目标接受分开报告。

需要被动能力发现、离线 ELF/Ghidra/运行时坐标核对、已保存证据封存或显式 MCP 宿主握手时，按需读 [实验工作台](references/re-workbench.md)。这些辅助器不要求固定分析顺序；后端未验证时仍可使用既有工具或交付限定范围的结论。

需要把已保存的 native/DEX 观察关联回静态位置时，按需读 [只读静态关联](references/static-correlation.md)。匹配字节不等于运行绑定或目标接受，缺身份时保留未知。

## 会话与交接

按当前问题选方法，可静态先行、动态先行或直接建模。连续实验没有新增证据时盘点前提和可区分解释的实验；时间盒用于复查，可说明价值后继续原路线。

简单单点查询记录最小证据即可；多阶段、恢复或协作任务按需使用 analysis-session，记录关键结论、目标代次、实验干预和未决问题。普通工具事件由运行层记录。候选与外部接受分别说明，可交付限定范围的未完成报告。共享项目写操作协调所有权；未获变更权时先只读。


## 按需资料

需要跨返回或连接中断保留本地实验，且已显式启用 owner 时，按需读取 [持久实验与共享资源](references/re-owner.md)。普通前台分析没有新增前置步骤。

| 文件 | 何时读 |
|---|---|
| [状态指纹差分](references/state-fingerprint-oracle.md) | 已有结构化报告与模型逐字段核对，或需要受限 CALL 副本实验及证据边界 |
| [进程与结果观察](references/process-observation.md) | 同名/fork worker、模块 load bias、现存输出及动态结果的来源/接受边界 |
| [Windows 调试通道](references/windows-debug-channel.md) | PE 原生异常、寄存器、栈快照、进程缓解查询或后端语义差异 |
| [符号模型与反例](references/symbolic-model-checks.md) | 局部符号执行、状态初始化、分支/等价性查询与求解结果解释 |
| `references/js-antidebug.md` | CTF web/misc 遇到混淆 JS / 浏览器反调试时（混淆分类、反调试四件套中和模板、Node vm 沙箱脱 eval 链） |
| `references/js-env-rebuild.md` | JS 肯跑之后的下一步：补环境最小 stub、webpack 抠模块、Node 本地复现并对照浏览器输出 |

## 补充专题入口

- [tools](references/tools.md)：当前问题涉及文件名对应专题时按需读取。
- [unicorn-harness](references/unicorn-harness.md)：当前问题涉及文件名对应专题时按需读取。
