# 逆向工作台：分阶段设计与当前实现

[首页](../README.md) · [专业工具](../TOOLSET.md) · [动态分析](../skills/re-dynamic/SKILL.md)

目标是把现有 Ghidra、Android 和动态分析能力连成可复核、可恢复的研究工作流。专业方法继续由模型按问题选择；实现分批推进，不用一套固定实验步骤限制所有任务。

本批源码位于 `exp/re-workbench-20261027` 实验分支，安装验收使用独立 DSH_HOME；稳定 main 和现有配置未自动切换。

## 当前交付：离线与宿主基础

| 能力 | 已实现的范围 | 尚不能据此声称 |
|---|---|---|
| 被动能力发现 | PATH、显式路径、venv 包元数据；不执行被发现工具 | 设备已连接、版本兼容、attach/Java 观察可用 |
| 地址核对 | ELF32/ELF64、显式字节序、PT_LOAD、Ghidra rebase、BSS、多候选 | 当前真实进程、JIT、ART 方法或任意 dump 的地址已恢复 |
| 保存证据 | 私有内容副本、来源声明、不可覆盖记录、离线 hash 复核 | 完整事件流、目标接受、后台 job 已收尾 |
| MCP 宿主检查 | 临时 stdio 初始化和工具目录分页，不调用工具 | 各工具的真实设备语义、持久 job、重启恢复已验证 |
| 自有标准样本 | 宿主 JVM/JNI 静态导出与 RegisterNatives 算术夹具 | Android ART、ClassLoader、插桩或盲测能力 |

入口为 `skills/re-dynamic/scripts/re_lab.py`；参数、字段和示例见[按需参考卡](../skills/re-dynamic/references/re-workbench.md)。仅需 Python 3.10+ 标准库。已有分析工具和工作状态没有因新工具引入额外前置步骤。

当前没有 Android 设备验收。后续设备相关测试应明确需要设备，缺设备时记录未验证，不能用本地假后端或宿主 JVM 替代通过。

## 灵活性与边界

- 普通文件查询可直接做；不要求每次先 doctor、建完整实验书、建立两个假设或跑一遍全部工具。
- 是否动态先行、使用哪个后端、何时升级观测强度由当前问题与证据决定。仿真或第二实现不是通用默认，也没有固定独立性排序。
- 缺失某个工具时，可以换已有工具、静态分析或交付有范围的部分结果；不为缺失可选后端阻塞整个任务。
- 大小与等待预算控制本次读取/握手资源，均显式说明；不新增累计任务数、思考轮数、方法次数或解题时长限制。
- 工具严格核对它实际承担的文件、坐标、协议身份和收尾；这些检查不代表证明自然语言推断或赋予额外权限。

## 第二批：可选本地持久实验

新增独立 Linux owner、稳定操作标识、声明资源租约、worker 身份回执、取消与恢复对账。通过 --re-owner-root / --re-realm 显式安装 bridge；默认配置和稳定 profile 不变。详见[配置、动作与恢复边界](../skills/re-dynamic/references/re-owner.md)。

本批仅覆盖配置好的本地进程组，不提供设备控制。多个 DSH_HOME 必须连接同一 owner root 才协调共享资源。目录别名/祖先关系、进程出生身份、目标代次、任务与原生 Solver 授权由运行层核对；自由 shell 和手工客户端在覆盖外。元数据不替代 DSH 的 task/work 状态。

同一操作不重放，Solver 普通返回保留实验；暂停/取消确认收尾后释放资源，无法确认时保留 cleanup_unknown。没有默认任务时限或累计实验数限制。分页与输出保留预算显式报告，不默默截短任务书或产物。

Linux 故障验收：`python3 tests/re-owner.py`。原生本地适配器验收随 `python3 tests/run.py --native` 执行，不调用真实模型或 Android。

## 第三批：DEX 索引与只读静动关联

复用已配置的 Androguard/JADX，补齐 SDK 原生路径发现，提供多 DEX 的完整方法身份、指令、字段/字符串使用点和编码引用索引。重载、重复 ZIP 条目与同名定义分别保留；查询分页，大字段可读取完整原件，解析失败明确标为部分覆盖。详见 [DEX 静态索引](../skills/android-re/references/dex-static-index.md)。

`re_correlate.py` 保存观察来源哈希，复用 ELF 坐标转换或精确 DEX 方法身份生成查询。`ReEvidenceSnapshot.java` 只读当前 Ghidra 程序，核对原文件哈希、真实文件映射/DEX lookup、当前字节与导出前后修改计数。关联区分匹配、歧义、过期、字节/rebase 冲突和未定位；不等于已验证运行身份或目标接受。详见 [只读关联](../skills/re-dynamic/references/static-correlation.md)。

不自动启动设备或注册新的控制工具，不扩大 Solver 授权，不修改 Ghidra 注释/符号/字节，不自动发布记忆。没有固定分析路线、强制双源检查或累计方法数量限制。CLI 可直接前台使用；大型可恢复工作才按需选已有 owner。

验收：`python3 tests/re-static.py --required-backend`，原生材料/前台查询接线随 `python3 tests/run.py --native` 执行。真实 Ghidra 验收使用独立自有 ELF/DEX 项目；不把宿主样本当作 ART/ClassLoader 设备通过。

## 后续阶段：契约先于设备操作

以下设备、事件流与静态回写仍是后续约定。本地进程取消已实现；不提前暴露设备 attach、远端 cancel 或回写工具。

### 持久 job 与归属

受管后端须绑定 task/work/原生 child 与 backend session/job。一个不依赖模型持续调用的 owner 负责在途核对、取消和产物封存。模型返回或工具等待超时，不自动等于远端工作已结束。

提交携带 operation_id 与预期任务/加载代次；同一操作重试先查询已知结果。状态区分请求已接收、实际运行、取消请求、确认收尾与 cleanup_unknown。失联或重启只恢复元数据和证据，不能假装原 Frida 执行句柄仍有效，也不默认重放操作。

### 资源协调

外部资源身份使用设备稳定身份及别名、设备启动代次、进程 PID 与出生身份；task generation、backend 和 owner 是授权/持有者属性，不应改变同一外部资源的互斥键。

独立 DSH_HOME 的主状态库相互隔离，不能各自声称已获得跨 profile 独占。受管控制需共享协调入口或明确的实验排他范围。设备级 spawn-gating、应用安装/清数据、ADB forward 与进程操作分开建模；未经协调的手工客户端属于旁路，不宣称已被系统阻止。

这些是实际发起共享资源操作时的要求；不对不使用该资源的静态分析加锁或增加步骤。

### 事件与证据

事件绑定 producer epoch、stream ID、脚本内容版本和序号范围；produced、received、persisted 和 acknowledged 分开记录。过滤、采样、队列丢失、写失败与未知缺口分别说明，不以 dropped=0 默认保证完整。

先封存内容和必要 manifest，再登记主状态引用；失败后按实际文件/任务状态对账。当前离线证据工具只完成已保存文件这一层，不复制权威 task/job 状态。原件可按问题读取相关范围，不自动把全部 Trace 注入上下文。

### 静态关联与受控回写

先交付只读关联。后续回写须有 proposal、程序/地址空间身份、事务内 pre-image 核对、操作标识、保存结果和预先记录的 change intent。提交成功而外部回执未落盘、项目保存失败等故障需可对账；补偿撤销在事务内核对 post-image，冲突时保留现状并报告。

类型与签名依赖恢复单独验证，不与首个 comment/label/rename 支持捆绑承诺。Ghidra GUI/直连 RPC 的旁路仍需界定，普通任务租约不能保证全系统封锁。

## 外部后端验证

本批在独立 WSL 目录构建并验证 Kahlo 提交 `7d091aa61645c1c1d9a9301d428f69621860f02f`，lockfile 对应 Frida Node 17.6.2。构建成功和 stdio 工具目录可读只是宿主层的结果；该后端未自动注册到 DSH。

上游当前 target/job 索引、live 事件读取及产物目录依赖进程内状态，取消成功也不保证卸载已确认。因此后续需逐项决定原样接入、薄适配或向上游补充能力，不凭 README 的生命周期描述承诺完整恢复。

Kahlo 为独立外部项目，不随本仓库分发。其当前 [LICENSE](https://github.com/FuzzySecurity/kahlo-mcp/blob/7d091aa61645c1c1d9a9301d428f69621860f02f/LICENSE) 标有 Commons Clause 和 2030-01-01 转换条款；复制/分发前需核清许可，不能直接归入本仓库 MIT。LLDB、Stalker、QBDI、unidbg、Flutter 和 IL2CPP 仍为按需求单独验收的扩展。

## 验收入口

仓库根目录：

```bash
python3 tests/re-lab-contract.py
# 自有 Linux JVM/JNI 夹具；缺 JDK/编译器时明确失败
python3 tests/re-lab-host.py --required-host
```

Windows 可用 `python` 跑离线合同；host JNI lane 当前限定 Linux，默认会说明 skipped，`--required-host` 则失败。这里的标准答案是公开合成回归，不是 held-out 评测。

原生 DSH 已安装时，使用现有回归入口验证按需材料交付与权限：

```bash
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tests/run.py --native
```

测试不调用真实模型服务。运行 MCP 检查须显式提供已审查后端的 descriptor；默认测试只启动自有协议夹具，不下载或运行第三方工具。

安装清单分发自有脚本、参考卡及显式选择的本地 owner bridge，不安装 Frida/Kahlo、设备工具或全局请求策略，不自动启动 owner。稳定环境继续按原维护流程使用；设备操作与静态回写需各自验收后推广。
