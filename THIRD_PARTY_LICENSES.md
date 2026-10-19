# Third-Party Licenses & Attribution

本仓库包含衍生自以下上游项目的内容,感谢原作者。致谢不替代实际收录文件所适用的许可、版权和其他通知,也不把不同来源统一改标为本仓库的许可。

## 一、直接收录 / 衍生内容

| 上游 | 许可 | 用于 |
|---|---|---|
| [ljagiello/ctf-skills](https://github.com/ljagiello/ctf-skills) | MIT | ctf-web / ctf-misc / ctf-crypto 的知识框架与部分配方，以及逆向资料中的比较方向/诱饵提示等（经条件校准与改造） |
| [Cellebrite Labs ghidra-rpc](https://github.com/cellebrite-labs/ghidra-rpc) | MIT | `skills/ghidra-core/engine/ghidra-rpc` 执行引擎(vendored + dsh 补丁) |
| [clearbluejar/pyghidra-mcp](https://github.com/clearbluejar/pyghidra-mcp) | Apache-2.0 | ghidra-rpc 内 GUI 启动器模式(`GuiPyGhidraMcpLauncher` 适配,随上游 vendored 带入) |
| [zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill) | MIT | 逆向方法论框架 |
| [wgpsec/AboutSecurity](https://github.com/wgpsec/AboutSecurity) | 见上游 | ctf-reverse 知识片段 |
| [Und3rf10w/ai-ghidra-tools](https://github.com/Und3rf10w/ai-ghidra-tools) | 见上游 | ghidra_scripts 脚本集(legacy 冻结层) |
| [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) | Apache-2.0 | Go/Rust/crypto 识别/JS 反调试知识片段 |
| [yaklang/hack-skills](https://github.com/yaklang/hack-skills) | MIT | traffic-analysis 的 pcap 决策树骨架 |

## 二、设计参考(未移植源码)

analysis-memory / analysis-session 的结构化记忆与有限协作设计参考了以下项目的具体机制,结合 DSH 原生扩展接口自行实现。未移植这些项目的 agent 引擎、服务端或提示词体系,不宣称具有其完整功能或评测成绩:

| 项目 | 参考点 |
|---|---|
| [BreachWeave](https://github.com/m-sec-org/BreachWeave/tree/bc2d9502a2625c5ef354adc30243bd091341cc51) | 事实与方向的区分、失败边界、分层共享；编排的 Planner / Solver / Observer 职责分离与保守纠偏 |
| [Graphiti](https://github.com/getzep/graphiti) | 来源关联、显式关系、事实适用性管理 |
| [Mem0](https://github.com/mem0ai/mem0) | 作用域隔离、提取与存储分工、历史记录 |
| [LangMem](https://github.com/langchain-ai/langmem) | 类型契约、命名空间、记忆工具接口 |
| [Letta Code](https://github.com/letta-ai/letta-code) | 核心记忆分层、延后读取、定向修订 |
| [ARTEX artex-global（实际检查版本）](https://github.com/jiwoochris/artex-global/tree/fdfb7a17b7da5e2de716c0e98475ec77a41c64c6) | 任务依赖、证据关联与领取机制；编排的事件唤醒、心跳和工作生命周期 |
| [Microsoft Magentic](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic) | 独立协调与进度复查的设计参考；未移植其实现或完整算法 |
| [CyberChef Magic](https://github.com/gchq/CyberChef/wiki/Automatic-detection-of-encoded-data-using-CyberChef-Magic) | 数据驱动恢复的结构识别、试探变换与多指标排名方法；不宣称移植其完整自动检测引擎 |
| [Binary Refinery](https://github.com/binref/refinery) | 可组合字节变换与可重放管道的接口设计参考；transform_search.py 独立实现 |

上述编排参考应用于 `analysis-orchestration`，由本项目结合 DSH 原生接口独立实现，未复制所列项目的代码或提示词。ARTEX 链接指向实际研究的 artex-global 分支版本，不代表原项目当前版本，也不表示移植了完整探索图。未采用特定评测平台的固定完成规则、时限或请求配额。

## 三、知识归纳来源(未收录其代码/规则全集)

以下项目的特定示例、规则或文档用于对应知识卡的归纳、条件校准与验证设计;不宣称其后端已经集成:

| 项目 | 用于 |
|---|---|
| [Triton](https://github.com/JonathanSalwan/Triton) | `re-dynamic/references/symbolic-model-checks.md`(等价性与不透明谓词示例) |
| [angr-examples](https://github.com/angr/angr-examples) | 同上(状态与路径示例) |
| [capa-rules](https://github.com/mandiant/capa-rules) | `re-triage/references/capability-evidence.md`(组合特征与规则作用域) |
| [AFL++](https://github.com/AFLplusplus/AFLplusplus) | `vuln-audit/references/fuzzing-harness-evidence.md`(harness 保真与崩溃归因) |
| [how2heap](https://github.com/shellphish/how2heap) | `pwn-exploit/references/heap-version-evidence.md`(按版本校准堆技术前提;不携带其 PoC) |
| [glibc](https://github.com/bminor/glibc) | 同上(以固定版本分配器源码为语义依据;源码研究,非复制或重新许可) |
| [crypto-attacks](https://github.com/jvdsn/crypto-attacks) | `ctf-crypto/references/crypto-attack-contracts.md`(攻击接口与成立条件归纳) |
| [Wycheproof](https://github.com/C2SP/wycheproof) | 同上(测试目标区分;未打包向量库) |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra) | `ghidra-static/references/pcode-width-contracts.md`(P-code 官方规范归纳) |
| [Mandiant FLOSS](https://github.com/mandiant/flare-floss) | `ghidra-static/references/data-driven-recovery.md` 中静态、栈上、tight 与 decoded strings 的提取视角；未打包其引擎或承诺已安装后端 |

## 四、运行依赖

`re-dynamic/scripts/local_bv_check.py` 依赖 [Z3](https://github.com/Z3Prover/z3)(z3-solver 的 Python API),按各自环境的安装版本为准;该辅助器只验证声明的数学模型,不证明原程序接受候选。

各上游许可证全文见其各自仓库。MIT 许可文本同本仓库 [LICENSE](LICENSE);Apache-2.0 文本见 <https://www.apache.org/licenses/LICENSE-2.0>。

## 五、协作推理设计参考

### SapperLens / sapper-v2 公开复盘

协作推理与受限记忆设计参考 [SapperLens](https://github.com/inwpu/SapperLens) 及用户提供的 [sapper-v2 复盘文章](https://mp.weixin.qq.com/s/SmEpDPNMWKXqEw0JseTDOg) 中不同角度复核、共享记忆与错误前提传播的分析。实现基于 DSH 现有记忆与原生子会话独立编写，未复制该项目代码、提示词或题目答案；本说明不推定公开可读材料具有可再发布授权。
