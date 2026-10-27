# CRC 与校验回显：模型、差分和可辨识性

看到 checksum expected/actual、已恢复的 XOR/旋转、错误分类或本地校验方程时按需读。未知二进制先由逆向提供位宽、变换顺序和覆盖证据；请求、目标代次和会话由原授权执行通道维护。普通 CRC 不作为安全 MAC，校验通过、命令执行和目标接受分开判断。

## 先明确观测模型

记录 width、poly 的表示方式、init、refin、refout、xorout、覆盖的原始字节与字段端序。CRC 数值和报文中的校验字节顺序不是同一配置。标准 normal poly 不包含最高次项，反射表示需显式声明；不要同时反转多项式与错误地重复处理输出。

以 ASCII `123456789` 为例：ARC 的 normal poly=0x8005、init=0、refin/refout=true、xorout=0，结果 0xbb3d；MODBUS 将 init 改为 0xffff，结果 0x4b37。名称相似不证明参数相同。

固定长度下通常应写 `F(x)=L(x) XOR b`，其中 `b=F(0)`：

```text
F(x XOR y) = F(x) XOR F(y) XOR F(0)
F(x) XOR F(y) = L(x XOR y)
```

不同长度、覆盖、解析路径或状态不能直接套用同一映射。相同长度时 init/xorout 可能互相吸收，多个模型都符合样本；“拟合通过”不等于参数唯一。

## 差分、绝对值和秘密恢复

同一密钥流、等长覆盖和线性编码下，共同 XOR 项可能在差分中消去；这可帮助定位变换/字段，不自动给出秘密。反之，不能泛化为所有差分都无助于恢复；先检查假设和测量矩阵。

已知前缀、绝对 CRC、可控长度或其他独立约束可能降低未知量，但不是通用保证。没有 hint 也不自动意味着 2^128 不可行。分开计算本地枚举与远程请求代价；保留零个、一个、多个候选，不凭“16 位 CRC”断言逐字节唯一。

区分重复掩码/密钥流、原始密钥与校验伪造；得到明文校验不意味着反推出生成秘密的哈希。握手短前缀相同不证明跨进程或重启不变。不要为重采观测静默重连、重放或扩大请求额度。

## 离线有限候选工具

`scripts/crc_candidates.py` 只处理保存的字节与调用者给出的参数，不接 URL、不自动取钥或枚举所有多项式。示例模型 JSON：

```json
{"width":16,"poly":"0x8005","init":"0xffff","refin":true,"refout":true,"xorout":0,"poly_representation":"normal"}
```

```bash
python3 scripts/crc_candidates.py calc --model model.json --hex 313233343536373839
python3 scripts/crc_candidates.py delta --model model.json --hex 616263 --right-hex 617863
python3 scripts/crc_candidates.py check --input samples.json
```

`samples.json` 包含 samples 与 candidates：

- 每个 sample 为 `{data_hex,crc,contract,partition}`。crc 为整数或 0x 字符串；partition 为 fit/holdout；contract 是同一目标代次、会话状态、变换与观测语义的引用。不同 contract 拒绝合并，引用一致仍只是调用者声明。
- 每个 candidate 为 `{id,model,coverage:{offset,length}}`，model 使用上述字段；length=null 表示剩余字节。覆盖越界明确记为反例，不截取到实际长度后假装匹配。
- 输出所有候选、fit/holdout 失败数量和首个反例、matches 及重复训练输入的留出警告。不自动挑第一名，不把调用者标记的留出当独立程序验证。

`--max-json/--max-bytes/--max-candidates/--max-work-bits` 是显式可调的本次计算资源边界；超限拒绝，不静默丢候选。字段不含目标 magic、命令字、密钥长度或固定轮数。`delta` 只核对声明模型的等长仿射关系，不证明已识别真实算法。

用已知向量、不同长度/覆盖、错误模型和独立留出验证，并保留不能区分的参数。相同逆向实现生成的 mock 可能重复同一错误，最终仍需原目标或独立来源证据。

资料：[CRC RevEng](https://reveng.sourceforge.io/crc-catalogue/16.htm)、[pycrc 参数](https://pycrc.org/models.html)。流量侧见 `traffic-analysis/references/protocol-reversing.md`；分层流与状态复用既有 `pwn-exploit/references/relay-session-contracts.md`。
