# 逆向实验辅助：被动发现、坐标与已保存证据

需要确认工具位置、关联静态/动态地址、封存已有输出或验证一个已信任 MCP 的宿主协议时按需读。可直接使用适合当前命题的静态、动态或模拟后端；不要求先跑本页全部工具，不固定假设数量、工具顺序或任务时限。

当前是实验性离线/宿主层。真实 Android attach/spawn、ART/ClassLoader、持久 job owner、跨 profile 互斥、自动 Ghidra 回写与补偿撤销尚未由这些工具实现。已有工具仍可按其实际授权和验证范围使用，不因新后端缺失而阻断整个任务。

## 被动发现与主动操作分开

从本 skill 目录运行，或用脚本实际绝对路径：

```bash
python3 scripts/re_lab.py doctor
python3 scripts/re_lab.py doctor --python /your/venv/bin/python3
python3 scripts/re_lab.py doctor --config discovery.json
```

可选配置：

```json
{"tools":{"adb":"/your/sdk/platform-tools/adb","custom-observer":"/your/tool"},"pythons":["/your/venv/bin/python3"]}
```

只检查显式路径、PATH、解释器文件和包 METADATA，不执行二进制、不 import 目标包、不启动 ADB/JVM/Frida，不查询设备，也不读取 DSH profile 或密钥。可增加工具路径；未发现只表示搜索范围内没找到，不能直接升级为全系统未安装。

`discovered` 不等于版本兼容或操作可用，`not_probed` 不等于失败；返回的 `ok` 仅说明发现过程完成，没有全局 ready。需要当前设备能力时选择实际主动探测，并记录后端、设备、权限和范围，不用存在性报告代替实际观察。

## ELF、Ghidra 与运行时坐标

支持声明字节序的 ELF32/ELF64 PT_LOAD。先保存显式上下文，例如：

```json
{"image_sha256":"实际文件的SHA256","process_identity":"明确进程出生身份","load_instance_id":"本次模块加载身份","load_bias":"0x70000000","ghidra_rebase_delta":"0x100000"}
```

```bash
python3 scripts/re_lab.py map-address --image module.so --context mapping.json --from elf_va --value 0x3180
```

`--from` 可为 elf_va、runtime_addr、ghidra_va、file_offset。按对应 PT_LOAD：

```text
runtime_addr = load_bias + elf_va
ghidra_va    = ghidra_rebase_delta + elf_va
file_offset  = p_offset + (elf_va - p_vaddr)  # 仅文件支持范围
```

输入文件哈希必须与上下文一致；这是实际字节对应声明坐标的核对，不代表工具已核验设备、进程或当前加载实例。`runtime_identity_verified=false` 保留这个差别。需要真实 Linux 进程 maps/PT_LOAD 观察时可按适用范围使用已有 `worker_snapshot.py`。

结果保留全部段候选：重叠映射为 ambiguous，没有段为 unmapped，不能取第一项冒充唯一。BSS 没有原文件字节，file_offset 为 null；也不对 JIT、DEX、匿名代码猜原文件偏移。地址用十六进制字符串保留精度，溢出不掩码。Thumb、tag/PAC 等保留原值和规范化依据，本工具不自动剥位。

同一原始映像的不同 Ghidra 项目可能 rebase 不同；项目身份与映射依据随交接保留。模块重载、重新注册 Native 方法或代码变化后，先核对新实例/代码版本再复用探针；旧事件与产物仍可保留为历史。

## 已保存证据的封存与重查

这是本地文件副本和来源声明，不接管 task/job 状态，不从设备取件：

```json
{"backend":"observed-backend","run_id":"明确运行引用","source_kind":"observed","task_ref":"已有任务引用或null","interventions":["实际干预与限制"]}
```

```bash
python3 scripts/re_lab.py seal --store /your/private/evidence --file saved-output.bin --provenance provenance.json
python3 scripts/re_lab.py verify --store /your/private/evidence --record 返回的record_id
```

source_kind 可为 original、derived、observed、synthetic；其余 JSON 元数据按当前问题附加，不要求每个简单查询创建完整实验书。首次 seal 创建私有 store，内容按 hash 保存，记录按包含 provenance 的完整元数据 hash 定位；不同运行可共享相同内容但保留不同来源。

复制检查普通文件、字节数与读前后身份，不覆盖已有对象，检测来源变化。verify 可在新进程、原来源文件丢失、后端未运行时重查记录与完整内容 hash。它不会把本地完整副本自动判为设备事件流完整或原目标接受；`stream_completeness=unknown`、`target_accepted=null` 保留。

这些“不可覆盖”约定由工具执行，不是 OS 防篡改隔离。磁盘损坏会由 verify 明确失败；对象已封存而元数据未完成时可能留下孤儿对象，不能据此假造完成记录或自动删除其他证据。现有 analysis-session 可按需登记已封存文件引用；没有另建权威任务库，也没有自动改写主状态。

## 显式 MCP 宿主握手

只对已审查、信任的本地后端运行。descriptor 示例：

```json
{"argv":["/your/node","/your/backend/dist/index.js"],"cwd":"/your/backend","env":{"KAHLO_CONFIG_PATH":"/your/private/config.json"}}
```

```bash
python3 scripts/re_lab.py inspect-stdio --descriptor backend.json --timeout 30
```

这会真的启动外部程序。客户端只发送 initialize、initialized 通知和 tools/list，不调用任何工具，不提供模型采样、文件 roots 或设备操作。外部程序启动自身可能有副作用，环境变量筛选不构成文件系统隔离。不要用它运行未知脚本。

握手采用 MCP 2025-03-26 stdio，拒绝不支持的版本、协议异常和重复游标；完整读完工具目录后报告 advertised only。支持的名称不表示 attach/spawn、持久恢复或清理已经验证。stderr 只返回大小和 hash，未把日志原文灌入上下文；调用者仍需保护自有后端日志。

客户端收尾自己的临时子进程；POSIX 会收尾自建进程组，Windows 当前只保证直接子进程，不适合宣称已拥有外部派生后台 job。真实受管后端仍需 task/work/child 归属、operation_id、失联对账及 cleanup_unknown 等完整生命周期。

输入大小、每条协议消息与本次握手等待可显式调整；超限清楚失败，不静默丢候选，也不成为解题任务、方法或思考轮数的上限。
