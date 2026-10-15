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

## 选择实验

GDB 用于断点、内存与控制流；Frida 用于真实进程插桩；Qiling 用于可控函数/系统调用实验；符号执行适合可控路径约束，评估模型覆盖和规模后使用。可重复调试模板用 gdbkit.py，也可写必要的手工脚本。

`scripts/layer_dump.py` 可保存解密层；需要 Ghidra xref 时 import-raw 保留基址和 OEP。`scripts/oracle_family.py` 打桩隔离因子；在有限输入、路径和常量干预下输出不变，只支持“未观察到影响”。改变返回值可能改变控制流，应对照基线。time/random hook 改变运行环境，文件未改不自动构成独立验证。

验证说明共享引擎、ABI、模型和输入假设等错误来源。Qiling 与 Unicorn 有共享基础；不同引擎有更强交叉检查价值，但不用“零共享”二分判断。普通 Wine 行为不能代替依赖 Windows 特性的原生结果。干预实验、候选与未干预目标接受分开报告。

## 会话与交接

按当前问题选方法，可静态先行、动态先行或直接建模。连续实验没有新增证据时盘点前提和可区分解释的实验；时间盒用于复查，可说明价值后继续原路线。

简单单点查询记录最小证据即可；多阶段、恢复或协作任务按需使用 analysis-session，记录关键结论、目标代次、实验干预和未决问题。普通工具事件由运行层记录。候选与外部接受分别说明，可交付限定范围的未完成报告。共享项目写操作协调所有权；未获变更权时先只读。


## 按需资料

| 文件 | 何时读 |
|---|---|
| [符号模型与反例](references/symbolic-model-checks.md) | 局部符号执行、状态初始化、分支/等价性查询与求解结果解释 |
| `references/js-antidebug.md` | CTF web/misc 遇到混淆 JS / 浏览器反调试时（混淆分类、反调试四件套中和模板、Node vm 沙箱脱 eval 链） |
| `references/js-env-rebuild.md` | JS 肯跑之后的下一步：补环境最小 stub、webpack 抠模块、Node 本地复现并对照浏览器输出 |

## 补充专题入口

- [tools](references/tools.md)：当前问题涉及文件名对应专题时按需读取。
- [unicorn-harness](references/unicorn-harness.md)：当前问题涉及文件名对应专题时按需读取。
