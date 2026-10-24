# TOOLSET.md — 推荐工具集(面向用户的环境复现指南)

> **给 agent 的真相源不是本文档。** 工具可用性以 `skills/ghidra-core/scripts/doctor.py` 的 toolchain 注册表实时探测为准(`python3 doctor.py`,自动按平台选 Windows/Linux 注册表)。本文档面向想复现这套环境的人:列出工具、角色与选型原因,不含任何机器特定路径;版本号是参考实测值,不是硬性要求。
>
> 分级:**A** = 轻量高频,建议必装 / **B** = 重依赖(pip 大包或需 Linux)/ **C** = GUI 或场景受限,按需。

## Ghidra 引擎栈(ghidra-core / ghidra-static)

公开环境说明与探针的范围不同：`tools/doctor.py` 检查 DSH 分发前提；`ghidra-core/scripts/doctor.py` 检查专业后端，但部分条目仍假定个人 venv、发行版或工具目录。探针未命中这些预设只说明该位置未发现，不证明当前系统没有等价工具。先通过当前任务的 discover、PATH 和实际解释器验证所需能力，再决定是否补环境；本轮未重构旧路径注册表，也不自动安装依赖。

| 工具 | 角色 | 选型原因 |
|---|---|---|
| Ghidra 12.x | NSA 逆向框架 | 分析引擎本体 |
| JDK 21+ | PyGhidra 起 JVM(必须 JDK,JRE 不行) | 引擎运行依赖 |
| ghidra-rpc(本仓库 vendored + dsh 补丁) | 常驻 daemon 执行引擎 | 温热后每条命令 ~0.2s,替代一次性 JVM 冷启动 |
| pyghidra 3.x + JPype | daemon 的运行依赖;也可作 daemon 挂掉时的直接执行后路 | 引擎依赖与兜底 |

## 逆向通用 CLI(建议装在独立 venv)

| 工具 | 角色 | 选型原因 |
|---|---|---|
| frida + frida-tools | 动态插桩/hook | 静态死路时转动态;脱壳失败阶梯的一环 |
| z3-solver | SMT 约束求解 | 约束求解/矩阵题;符号执行辅助 |
| angr | 符号执行/自动探路 | `simgr.explore` 探路、可达性验证;⚠ 会把 z3 钉在 4.13 |
| checksec.py | PE/ELF 保护机制(NX/Canary/ASLR) | 判型补充;Windows 控制台需 `PYTHONUTF8=1` |
| 本仓库 relay_codec.py | 离线帧契约与注入式隧道 | 明确层间前缀、共享会话域和未知发送结果；不自动连接或重试 |
| 本仓库 worker_snapshot.py / observation_receipt.py | 只读进程与既有结果观察 | Linux 精确进程身份/ELF 映射；离线候选来源整理不升级外部接受 |
| 本仓库 seccomp_bpf.py / sqlite_api_map.py | BPF 路径与 SQLite API 表静态证据 | stdlib；明确输入与 ABI，未知不补猜；不安装过滤器或加载待分析库 |
| 本仓库 local_lab.py | Linux 可配置路径的自有服务实验 | pidfd、独立副本与原始 I/O；不支持固定路径重映射/setuid/network namespace，不扩大 Solver 资源权限 |
| 本仓库 pe_triage.py | PE32/PE32+ 声明和 Load Config 的静态证据 | stdlib；Windows/WSL 可用，不将静态标志等同运行策略 |
| 本仓库 windows_debug.py | Windows 原生异常、寄存器、模块、栈快照和进程策略 | Windows x64 的 64 位 Python；自建 x64/WOW64 进程，不依赖 cdb、不 attach、不改缓解；不是完整展开调用栈 |
| rust-demangler | Rust `_ZN` 符号还原(纯 wheel) | 无 cargo 环境时替代 rustfilt |
| speakeasy-emulator | Windows 用户态仿真 | 壳/恶意样本快速行为预览 |
| ghidriff | Ghidra headless 二进制 diff | 版本比对(ghidra-rpc 已内置 version-track,此为补充) |
| capstone / unicorn / lief | 反汇编/仿真/格式解析库 | 脚本层基础件 |

## 脱壳(re-unpack)

| 工具 | 角色 | 选型原因 |
|---|---|---|
| UPX 5.x | 加/脱 UPX 壳 | 主力;注意篡改过 header 的样本需先修头 |
| unpacker(anpa1200/Unpacker) | 自动脱壳路由,内部调度 unipacker | 防"肉眼死磕字节"死循环的强制工具升级入口 |
| unipacker(随 unpacker 装入) | PE32 仿真脱壳 | ⚠ 仅 PE32;64 位强壳走 qiling |
| qiling + Windows rootfs | 全系统仿真 | 64 位 Themida/VMProtect 档;免疫反调试仿真 |
| pycdc(Decompyle++,源码构建) | pyc 反编译,覆盖 Python ≥3.9 | uncompyle6/decompyle3 的唯一后继,现代 PyInstaller 样本必需 |

## 判型与平台专用(re-triage)

| 工具 | 角色 | 备注 |
|---|---|---|
| DIE(diec CLI) | 查壳/文件识别 | 手工补充查壳 |
| GoReSym | Go 符号/类型恢复 | Go 样本路由主力 |
| pyinstxtractor | PyInstaller 解包 | 与 pycdc 组合 |
| dnSpyEx(C) | .NET 反编译/调试 GUI | Windows only |
| de4dot-cex(C) | .NET 反混淆 CLI | 与 dnSpyEx 组合 |
| binutils(strings/readelf/nm/objdump) | ELF 分析基础件 | Linux 侧;Windows Git Bash 没有 |
| file | 判型 | 基础件 |

## pwn(pwn-exploit / ghidra-static pwn 工作流)

| 工具 | 角色 |
|---|---|
| gdb + pwndbg | 调试 + heap/context 增强 |
| pwntools | 漏洞利用脚本框架(`pwn checksec` 也是 ELF 侧 checksec) |
| ROPgadget / ropper | ROP gadget 搜索(后者支持语义搜索) |
| one_gadget | libc 一把梭 |
| seccomp-tools | seccomp 规则 dump/分析 |

## 流量分析(traffic-analysis)

本域脚本**全零依赖**(Python stdlib),下列均为增强:

| 工具 | 角色 |
|---|---|
| tshark / editcap(Wireshark 组件) | 协议分层统计、对象提取、格式转换;无它走自带 `pcap_triage.py` 保底 |
| scapy | pcap 脚本化解析进阶备手 |
| aircrack-ng | WPA 握手破解 |
| hashcat | NTLMv2 / WPA 哈希破解 |

## CTF web / misc / crypto(ctf-web / ctf-misc / ctf-crypto)

| 工具 | 角色 |
|---|---|
| sqlmap / httpx / flask-unsign | 注入、并发发包、flask session |
| pycryptodome / gmpy2 / fpylll(+cysignals) / py_ecc / ecdsa / sympy | 密码学主力库(fpylll 需系统 libfplll-dev) |
| RsaCtfTool | RSA 攻击聚合器(wiener/fermat/共模/部分泄露) |
| xortool | 多字节 XOR 密钥长度判定+爆破 |
| name-that-hash | 哈希类型识别 |
| jwt_tool | JWT 弱密钥/none alg/kid 注入 |
| ffuf + seclists | 目录/参数 fuzz + 字典 |
| CyberChef CLI(npm) | 500+ 确定性变换;消"手工逐层解码"死循环。注意 Magic op 被 Node API 禁用 |
| zbarimg / qrencode / ffmpeg | 二维码、音频频谱 |
| segno / dnslib / Pillow / numpy / hlextend | 二维码生成、DNS、图像、哈希长度扩展(hlextend 在 PyPI 无包,从 GitHub 单文件装) |

## Android(android-re)

jadx(Java 层反编译第一源)、apkanalyzer / adb / aapt2 / apksigner(Android SDK 自带)、androguard(交叉验证)、emulator + x86_64 镜像(无头真机 oracle)。apktool/baksmali 未装——jadx+apkanalyzer 已覆盖主场景(Tier C)。

## 已知不装项(选型决策记录)

| 工具 | 不装原因 | 替代 |
|---|---|---|
| GOOMBA | 实为 IDA 插件,不是 Ghidra 插件 | MBA 化简走 manual/angr |
| SiMBA | PyPI `simba-simplifier` 是占位包(0.0.1 无功能),真身需源码构建 | manual/angr 符号执行 |
| golang-loader | 上游仅 Jython 时代源码、无 release、Ghidra 12.x 未验证 | GoReSym |
| SageMath | Ubuntu 24.04 仓库无候选包 | fpylll+sympy 纯 Python 流程 |
| PayloadsAllTheThings | 不预装 | `ctf-web/references/pat-reference.md` 是索引,需要时浅克隆 |

## 双平台备注

skill 脚本按 `os.name`/`sys.platform` 自动分平台分支。Windows-only 项(dnSpyEx/de4dot/DIE/x64dbg/pywin32 GUI 驱动、Android emulator)在 Linux 侧不可用;Linux 侧优点是 binutils/gdb/qemu/tshark 等系统工具 apt 直达。
