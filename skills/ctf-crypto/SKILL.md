---
name: ctf-crypto
description: 分析已明确的密码学/数学结构、攻击条件与求解方法：RSA、分组模式、ECC、格、PRNG、约束。二进制算法尚未恢复时由逆向分析提供语义；HTTP 交互按需由 Web 协助。
---

# ctf-crypto

## 输入与输出

输入为数学对象、来源证据、编码/位宽/模数和 oracle 条件；输出为攻击前提、求解结果、数学验证与目标接受情况。

根据已知条件选方法：检查参数域、可用泄漏、nonce/密钥复用和攻击适用范围，按下面专题读取。聚合工具可用于验证假设，不能以遍历全部攻击代替理解条件。用可复算的方程/已知向量校验结果，padding、字节序和编码与原任务输入契约一致。

SMT、剥离、代数化简、枚举按结构与代价选择，无统一固定顺序。Sage/fpylll/sympy 等以当前解释器可用性为准，缺工具可选择等价方法并说明限制。oracle 请求预算与实例身份留在任务状态。二进制里的算法恢复交 ghidra-static，纯编码交 ctf-misc。

## 会话与交接

按当前问题选方法，可静态先行、动态先行或直接建模。连续实验没有新增证据时盘点前提和可区分解释的实验；时间盒用于复查，可说明价值后继续原路线。

简单单点查询记录最小证据即可；多阶段、恢复或协作任务按需使用 analysis-session，记录关键结论、目标代次、实验干预和未决问题。普通工具事件由运行层记录。候选与外部接受分别说明，可交付限定范围的未完成报告。共享项目写操作协调所有权；未获变更权时先只读。


## 决策表(已知条件 → 读哪个文件)

| 已知条件/症状 | 读 |
|---|---|
| [攻击条件与校验](references/crypto-attack-contracts.md) | 调用密码攻击实现或测试向量时：前提、接口与结果验证 |
| RSA:n、e、c、公钥、dp/dq 泄露、多组密文 | `rsa-attacks.md`、`rsa-attacks-2.md` |
| AES/分组模式:ECB/CBC/CFB/OFB/GCM、padding oracle | `modern-ciphers.md` ~ `modern-ciphers-4.md` |
| ChaCha20/sponge(SHA-3/Ascon)/Trivium | `modern-ciphers-4.md` |
| LFSR/RC4/自研流密码 | `stream-ciphers.md` |
| ECC:曲线参数、ECDSA 签名、nonce 问题 | `ecc-attacks.md` |
| DH/离散对数:g、p、平滑阶 | `dh-attacks.md`;通用 DLP(BSGS/P-H)→ `advanced-math.md` |
| 格/LLL/BKZ/Coppersmith/HNP/LWE/NTRU/背包 | `lattice-and-lwe.md`、`advanced-math.md` |
| 后量子识别(Kyber/ML-KEM/Falcon) | `post-quantum.md` |
| PRNG:MT19937/LCG/xorshift/时间种子 | `prng.md`、`prng-attacks.md` |
| 古典密码:维吉尼亚/替换/OTP 重用/异或 | `classic-ciphers.md`、`historical.md` |
| ZKP/Shamir 秘密共享/配对/混淆电路 | `zkp-and-advanced.md` |
| 结构认不出来(辫子群/Paillier/热带半环…) | `exotic-crypto.md`、`exotic-crypto-2.md` |
| 需要 Z3 解约束 | `zkp-and-advanced.md` 的 Z3 指南 + `advanced-math.md` |

`quick-reference.md` 用于专题不明时的速查；只读取当前相关资料。
