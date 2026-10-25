# Third-Party Licenses & Attribution

本仓库包含衍生自以下上游项目的内容,感谢原作者。致谢不替代实际收录文件所适用的许可、版权和其他通知,也不把不同来源统一改标为本仓库的许可。

原生 CTF 卡片与 Web 控件基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（本机相关原生包标注 MIT）的 Agent presets、Cordis、Typert Remote 与界面扩展接口独立适配。安装时从用户本机 Standard 组合复制并生成自定义预设，保留其组装内容；公开仓库不附带官方组合或编译产物，不将 DSH 原生功能宣称为本项目独有能力。

## 一、直接收录 / 衍生内容

### README 黑客版鲸鱼娘封面

[assets/social-preview.png](assets/social-preview.png) 为 AI 生成二创，角色设计参考 [TreapGoGo/deepseek-whale-girl](https://github.com/TreapGoGo/deepseek-whale-girl) 网站首页的“Q 版大肥鱼三视图与细节”，重绘为使用笔记本电脑的 CTF 黑客造型。原图未直接收录；原画作者未单独标明，不将资源库维护者推定为画师。原图规格、来源、改动与许可边界见 [封面说明](assets/ARTWORK.md)。上游网站代码的 MIT 不涵盖所有图像；本仓库不对参考角色或上游图片作新增授权。鲸鱼娘为社区非官方形象。

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

2026-10-21 目标地图的共享结构视图设计另参考 SapperLens 公开 Commander 提示词的事实图/工作面板思路。SapperLens 是独立分析，本文不声称已验证 sapper-v2 官方实现，也未完整读取上述文章。本仓库采用版本引用索引、原证据失效检查和主会话授权边界，未复制提示词或平台规则。

## 六、发布副本中的知识增量

2026-10-23 从用户提供的 DSH-CTF-Skill 发布副本整合渗透链、Next.js/RSC 与未知协议分析材料，并校准其适用条件和负结果解释。field_infer.py / stream_reassemble.py 基于该副本的统计与重组思路修订，增加共享 pcap 解析、覆盖说明与资源边界。没有将副本中的旧运行层、固定策略或旧工具覆盖到当前实现；这些知识归纳不构成当前目标漏洞或新跑分成绩的证据。

## 七、Windows 用户态补强的来源与边界

PE 结构和原生调试适配器按 [Microsoft PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)、[Debugging events](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events)、[CONTEXT](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-context) 与 [进程缓解查询](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessmitigationpolicy) 独立实现；没有打包 SDK 头文件、调试器或微软示例程序。

用户原设计把 [eip-public/security-skills](https://github.com/eip-public/security-skills)（MIT）和 [SnailSploit/Claude-Red](https://github.com/SnailSploit/Claude-Red)（MIT）列为 Windows 方法组织的调研来源。本次保留此调研出处，不声称移植其代码、完整提示词或 CVE 工作流；部分技能页未成功取得，未沿用其无法核验的现代缓解默认值和通用绕过断言。专题中的 [rp++](https://github.com/0vercl0k/rp) 只是可选工具指路，不随本仓库分发。旧 Windows 判例仍保留其原出处并标注适用条件。

## 八、SQLite/BPF 与本地实验

2026-10-24 方法增量来自用户提供的 justledger 复盘中的契约恢复、I/O 与资源归属经验；未发布原题附件、完整利用脚本、flag、目标端点或私有实例数据。三个新工具独立编写，未直接移植复盘里的脚本。SQLite API 语义依据 [SQLite 官方文档](https://sqlite.org/loadext.html)及 [pointer passing](https://sqlite.org/bindptr.html)，过滤器语义依据 [Linux seccomp](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)与 [BPF 结构文档](https://docs.kernel.org/networking/filter.html)；命名空间边界参考 Linux man-pages。不打包 SQLite 头文件/实现、内核代码或第三方题目样本，外部引用不表示获得其其他内容的再发布许可。

## 九、多层协议与进程观察

2026-10-24 增量参考用户提供的 redisrelay 复盘中分帧、调用实参与 worker 归属的经验，三个组件独立编写，未搬运其利用代码、四个工具或题目附件，不发布真实 flag、目标端点、偏移/密钥和私有实例数据。ABI 校准依据 [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI/-/raw/master/x86-64-ABI/low-level-sys-info.tex)；映射/进程引用依据 [ELF gABI](https://gabi.xinuos.com/elf/07-pheader.html)及 Linux man-pages；干预边界依据 [GDB Calling](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Calling.html)。引用是语义归纳，不打包规范源码/原题样本，也不推定其他内容的再发布许可。

## 十、运行时、生命周期与 VM 证据

2026-10-25 参考用户 cacheline/xmlbridge/VVMM 复盘中环境污染、精确 I/O、对象寿命、VM 模型与干预实验的经验。新增工具独立实现，未直接收编原题 Tube、启动/清理、GDB、分配 hook 或利用脚本；不发布附件、真实 flag、端点和实例秘密。

方法核对使用 [Linux ld.so](https://man7.org/linux/man-pages/man8/ld.so.8.html)、[ELF gABI](https://gabi.xinuos.com/elf/07-pheader.html)、[musl v1.2.6 源码镜像](https://github.com/ifduyue/musl/tree/v1.2.6/src/malloc/mallocng)、[libxml2 v2.9.14](https://github.com/GNOME/libxml2/tree/v2.9.14)、[nginx release-1.28.0](https://github.com/nginx/nginx/blob/release-1.28.0/src/core/ngx_module.h)、[GDB Forks](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Forks.html)及 Microsoft [PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)/[x64 ABI](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention)。这些是版本化语义与接口来源，不打包其库、规范、SDK 或调试器代码，不推定其他内容的再发布许可。
