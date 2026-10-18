# DSH-CTF-Skill

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 CTF 与安全分析 skill 合集：Web、Misc、密码学、Pwn、流量取证与逆向知识库，配合可选的任务状态、结构化记忆和解题编排插件。

CTF and analysis skills for DSH, with optional durable task state, structured memory and supervised continuable Solvers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Platform: dsh](https://img.shields.io/badge/platform-dsh-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh)

模型自主分析并选择路线；运行层维护任务身份、证据引用、资源和生命周期；skill 提供专业方法。简单任务可直接使用专业 skill，复杂且有独立分支的任务可按需启用专职编排。

## 本次更新（2026-10-18）

- **实验性解题编排 0.4.0**：主代理负责战略、派发和复核，具体执行交给持续型 Solver；事件通知与心跳支持进度监督、有据纠偏和确认取消。
- **同一子会话续做**：Solver 返回后可空闲，`followup` 恢复同一身份及自身历史。默认不设置任务时限、工作时限、步骤上限或累计唤醒上限；模型上下文、单次工具限制及资源租约仍生效。
- **空闲后的明确决策**：记录继续、等待、阻塞、暂缓或完成；`finish` 只结束编排阶段，总任务完成另需当前范围与证据。目标、约束、结果或关键证据变化会使旧判断失效。
- **更准确的交接与负面证据**：区分用户约束、阶段安排、假设与建议；登录诊断、失败复用和覆盖度判断说明实际排除范围。
- **生命周期修复**：卸载前移除旧取消监听并收尾，避免延迟取消回调访问已关闭数据库。

本次发布不宣称跑分提升或多代理必然优于单代理。编排适用于交接成本可控、能独立执行或复核的工作。

## 仓库结构

| 路径 | 能力 |
|---|---|
| `skills/ctf-web`、`ctf-misc`、`ctf-crypto` | Web、Misc、密码学知识库与诊断方法 |
| `skills/traffic-analysis` | pcap 分诊、隐信道、USB HID、WPA/TLS |
| `skills/ghidra-core`、`ghidra-static` | Ghidra headless RPC 引擎与静态分析 |
| `skills/re-*`、`vuln-audit`、`android-re`、`pwn-exploit` | 逆向、动态验证、代码分析、Android 与 Pwn；与 [ghidra-skill-for-dsh](https://github.com/Cristallin2006/ghidra-skill-for-dsh) 同源 |
| `skills/analysis-session`、`analysis-memory` | 任务、目标代次、证据、资源租约、结构化记忆及材料交接 |
| `skills/analysis-orchestration` | 专职编排、持续型 Solver、监督与完成判定的方法和契约 |
| `runtime/analysis-v1` | Python/SQLite 状态运行库；当前 session 版本 1.0.7 |
| `plugins/` | DSH 宿主插件：状态适配、记忆、可选请求控制、实验性编排 |
| `dsh-hooks/` | 会话卡与状态钩子入口、配置片段和合并脚本 |
| `tests/` | 隔离的合成回归，不调用外部模型或靶场 |

## 安装（WSL / Linux）

专业 skill 需要相应工具。插件已在 **Linux/WSL、Node.js 24.21.0、DSH 0.1.5-rc.3、Python 3** 的本地环境验收；Python 运行库要求 3.10+。逆向引擎另需 Ghidra 12.x 与 JDK 21+，见 [TOOLSET.md](TOOLSET.md)。Windows 原生平台层未作为本次发布的验收范围。

先备份已有同名目录；升级插件时先暂停任务并确认子代理收尾，再维护重启 DSH。不要用旧状态库覆盖新任务。

```bash
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME/skills" "$DSH_HOME/runtime"
cp -R skills/. "$DSH_HOME/skills/"
cp -R runtime/analysis-v1 "$DSH_HOME/runtime/"
```

仅复制 skill 不会自动获得运行层工具。使用状态、记忆或编排时，还需注册插件并配置钩子与独立状态目录，见[插件安装说明](plugins/README.md)。本仓库不分发个人 profile、模型密钥、任务库或本机私有 `TOOLCHAIN.md`；公开工具选择与探测方式见 [TOOLSET.md](TOOLSET.md)。

## 编排如何工作

1. 主代理读取 `analysis-orchestration` skill，用 `analysis_session init/bind` 绑定任务，再用 `dsh_memory_write open` 打开记忆。
2. `dsh_orchestration enable` 后，主代理保留阅读、状态与记忆工具，运行层限制其直接执行及其他派发渠道。`add` 写清问题、输入、判据和执行工具，`dispatch` 非阻塞启动 Solver。
3. Solver 默认获得 `skill` 和自身反馈工具，按需加载已安装且可调用的专业 skill；执行工具仍须显式授予。它不继承主代理完整对话或已加载的 skill 正文。可选 Observer 零工具，仅审查交接材料。
4. 主代理用 `wait/status/result/trace` 监督，以 `steer/followup` 补材料、纠偏或续做；Solver 可以提出有证据的异议。返回结果须 `review`，被采纳的结果修订后要重新复核。
5. 全部工作空闲后，按 `status.decision_review.signature` 调用 `resolve`，记录处置、未决问题及证据。`finish/disable` 可正常止损；总任务 `complete` 需要最新完成判断，不能用空未决列表绕过。

字段和例子见[编排 skill](skills/analysis-orchestration/SKILL.md)、[监督契约](skills/analysis-orchestration/references/supervision.md)与[目标处置](skills/analysis-orchestration/references/resolution.md)。工具的 `schema` 返回当前动作字段。暂停或重启后不自动重放工作，核对状态后明确恢复。

## 能力边界与已知限制

- 编排为按任务启用的实验功能，依赖 DSH 原生 `startContinuable/sendMessage/drainContinuableChildren` 接口及生命周期事件；其他 DSH 版本需验证兼容性。插件使用现有 SDK，不扩大沙箱、审批、工具权限或递归派发权限。
- 默认任务并发 2、宿主上限 3。状态库只保存有界摘要，结果超过 32768 字符会标记截断；完整材料须使用可读文件或 `dsh_handoff` 分块交接。子代理上下文容量由实际模型和宿主决定，不承诺固定 1M。
- `adopted`、工具返回成功和完成处置不等于独立验证或目标接受；引用存在也不证明结论正确。负面结论需说明测试条件与未覆盖范围。
- **请求控制是可选的宿主策略**：导入策略后，受控会话只能通过 `dsh_control` 发 HTTP(S)，预算、速率、origin 和凭据引用由该控制器管理。普通 shell、浏览器及 MCP 路径没有全局逐请求计量。严格 HTTP 控制尚不支持执行型 Solver，编排会拒绝启用，不能为此绕开原控制。
- 极端取消下曾观察到原生 hook 子进程启动失败后宿主退出等待未结束，根因尚未确认。本次修复覆盖编排数据库关闭顺序，不承诺解决原生 hook 链的全部退出问题；也未禁用生产钩子。

## 验证

在 WSL/Linux 中运行：

```bash
python3 tests/run.py
# 可选：原生宿主验收，需要已安装的 DSH；从同一终端运行
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tests/run.py --native
```

基础回归覆盖交接契约、反馈、默认预算、版本化处置、跨任务证据隔离与数据库关闭；原生回归另验证插件卸载重载、空闲 Solver 唤醒父代理、同一子会话续做、技能与权限边界。使用本地合成模型适配器和独立临时状态，不读取真实解题 session，不调用已配置模型服务。报告写入被忽略的 `.test-results/`，临时材料留在系统临时目录供排错。

## 历史测试记录

2026-10-14 的一次本地 TSecBench v1 测试记录：点数 **21215 / 23000**，平台综合得分字段 **91.94**，完成率 **93.2%（61/63 题）**，答对 Flag **69/74**。这些是历史记录，未上官方榜单，仓库未附可独立复现的完整评测材料；综合得分与原始点数为不同字段，不互相换算。

模型、工具环境、题目状态及编排版本都会影响结果。这次记录不代表当前版本成绩，也不能用于归因本次更新的收益。设计面向通用分析流程，不依赖特定平台题号、固定扫描清单、枚举次数或强制用满时限。

## 许可与致谢

本仓库原创代码以 [MIT](LICENSE) 发布；收录或衍生内容保留上游适用的许可。直接来源、架构参考与知识归纳分层列于 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。编排借鉴 BreachWeave、实际检查的 ARTEX artex-global 版本及 Microsoft Magentic 的部分机制，并使用 DSH 原生接口独立实现。
