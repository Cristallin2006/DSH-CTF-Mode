# 已保存状态指纹：字段级差分与补丁实验

目标能报告状态、需要核对本地模型或中间检查点时按需读。字段不固定为五元组，摘要相同不等于完整 VM/程序等价，首个不同字段不等于执行中最早的分歧。执行、解析和比较分别说明。

## 离线 state_fingerprint_diff.py

```text
python state_fingerprint_diff.py --plan plan.json --out NEW_JSON
```

计划包含 fields=[{name,type,unit,bits?,parse?}] 与 cases=[{id,left,right}]，left/right 是根目录中的已保存 JSON 文件；默认根为计划目录，可显式 --root。type=uint/sint/bool/string/bytes；整数 bits=1..4096，parse=native/hex/decimal，bytes 为精确 hex。单字段支持范围不是任务/累计材料上限，文件不截断、不覆盖。

每条记录包含 target_sha256（两侧比较的同一目标）、input_sha256、implementation_sha256/ref（各侧实际实现的声明身份）、input_contract、backend、initial_state_ref、execution_status、stop_reason、observations。例：

```json
{"name":"pc","type":"uint","bits":32,"unit":"byte_offset","parse":"native"}
```

observations.pc={state:"observed",value:24,unit:"byte_offset"}。state 为 observed/derived/missing/unsupported；观测值越界不 mask，单位不同不自动换算，缺字段不补零。missing==missing 不是匹配；derived 的等值仍保留证据缺口。数值文本解析需显式选择，CRLF 不会被通用 strip。原始输出保留在来源文件，解析契约由调用者提供。

execution_status=completed 只表示该次观察完成；业务拒绝、accepted opcode、预算耗尽、invalid_pc、host_crash、backend_unavailable 和输入递交失败应记录真实 stop_reason。不能把 status=-1 自动打印成 FAIL opcode。记录身份/状态是调用者声明，工具只核对已保存数据，不替原执行提供可信证明。

目标/input/输入契约或必要初态不同为 not_comparable；字段/直接观察有缺口为 partial。otherwise comparable_under_declared_contract 仍只覆盖所选字段。输出保留各字段、停止原因、后端、实现声明及干预；root_cause 和 target_accepted 不自动填写。模型/环境/读数/输入差异是竞争解释，比较工具不自动选择根因。

首版不运行两条命令、不生成随机输入。确需采样时另用已授权执行通道，传 argv 数组和明确 bytes/文件/stdin，不拼 shell {input}；新进程还是同连接由目标状态契约决定，不固定每个用例重启。参数、目标和环境变化需记录，不为取相同指纹静默 patch 目标。

## patch_call.py：只生成受限实验副本

首版 PE32+ AMD64，复用相邻 pwn-exploit 的严格 PE 解析器；缺该组件会拒绝，不自动安装。显式 --addr-is=rva/va/file-offset，--at 调用点、--expect 原 callee、--to 新目标都用该域，不按数值大小猜 RVA。默认只输出预览，可 --report NEW_JSON。

写副本必须额外给 --source-sha256、--boundary-record RECORD、--out NEW_EXE 和 --report NEW_JSON。record 包含 sample_sha256、instruction_rva、instruction_length=5、instruction_hex、basis_kind="caller_reviewed_disassembly"、evidence_file、evidence_sha256、locator；证据文件留在 record 目录范围。它是调用者复核声明及 hash/字节一致性，不是工具独立证明指令边界，更不是变更授权。只有 E8 字节/执行节而无边界记录时可预览，不生成副本。

核对完整范围、唯一文件映射、可执行节、旧目标与有符号 rel32；新目标也限同一映像文件支持的可执行范围。`disp=target-(site+5)` 超 signed32 则拒绝，不截断。虚拟零填充、跨节、多义映射、其他调用形式/架构和偏好 ImageBase 以下的 VA 不猜测处理。不支持任意字节覆盖或在原件上 restore。

输出独立副本和 0600 报告，记录原/新/实际 hash、地址域、文件偏移、前后字节及变更范围；原件复核不符时不会宣称 unchanged。checksum/签名、ABI、初态和运行策略仍未验证。生成不执行；原始程序接受、原始可达性和 BOF 成功均不能由补丁输出代证。

PTY、调试器调用、fflush 或替换 CALL 都是干预选择，没有默认顺序。Windows 的 DYNAMICBASE 是文件声明，不替代实际加载基址；RSP 对齐/shadow space 依真实链路核对，静默失败不能自动归因 ASLR/对齐/缓冲。[x64 ABI](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention)、[PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)。
