# 密码攻击：条件、接口和独立检查

数学结构已明确但需要选择实现或核验结果时读取。二进制语义未恢复仍由 ghidra-static/re-dynamic 处理；这里不把算法名称识别当成攻击前提成立。

## 调用攻击实现前

记录参数含义、来源、模数/群/域、长度与编码；分别列出已知值、推断值和未知量。确认 oracle 实际返回内容、实例身份与预算后再调用；预算管理沿用当前运行层。

例如所读 Boneh–Durfee 实现的入口使用 N、e、factor_bit_length、delta、m、t，并可利用已知低位。factor_bit_length 指因子位长，不是 N 的位长；delta 是私钥指数界的建模假设。m/t 影响格规模和成本，默认值不保证得到因子。None、超时和不满足攻击条件分别说明。

这一接口依赖 Sage 的对象和项目内模块；不能因脚本是 .py 就宣称普通 Python 可运行。先检查解释器和依赖，缺少后端时可交付条件模型或改选方法，不自动安装大环境，也不无上限提高格维数。

## 结果分层核验

1. 用原关系校验候选，例如因子相乘等于 N、参数域和逆元关系有效；需要时检查候选因子的性质，而非只信任函数返回类型。
2. 按任务核对 padding、编码、字节序、长度和真实验证方程。数学候选与服务端接受分开记录。
3. 实现一致性问题可使用独立测试向量。Wycheproof 是已知实现边界与异常输入向量库，不是任意 CTF 的万能求解器；valid/invalid/acceptable 的解释要按对应算法和 schema 处理，不统一折成一个成功值。

不依赖“同一脚本加密再解密成功”宣布模型完整；保留与原程序、已知向量或不同实现的具体对照。向量通过只支持相应算法接口和输入范围，不涵盖整套协议与所有侧信道。

来源核验 2026-10-14：[攻击接口](https://github.com/jvdsn/crypto-attacks/blob/d42a3df980bf029f682f218fa2893ed2d6af98d8/attacks/rsa/boneh_durfee.py)、[Wycheproof 范围与用法](https://github.com/C2SP/wycheproof/blob/7a325932231bd7a724c791c8b0d65ea4d6d2f435/README.md)、[RSA 测试边界](https://github.com/C2SP/wycheproof/blob/7a325932231bd7a724c791c8b0d65ea4d6d2f435/doc/rsa.md)。本卡为条件和接口归纳，未引入攻击脚本或大规模向量依赖。
