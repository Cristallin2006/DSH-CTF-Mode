# 局部符号模型：初始化、反例与结论范围

适用于一个函数、基本块或明确路径的等价性/分支问题。Triton 的动态轨迹、angr 的状态探索和手工 SMT 各有成本；按已知状态和问题范围选择，不要求整程序符号执行。

## 建立能解释的模型

- 记录符号化输入、具体化内存、入口寄存器、位宽、ABI、库调用与输入终止条件。未初始化状态不要用任意零值悄悄补齐。
- angr 的 entry_state 从入口建状态；full_init_state 包含更完整的初始化过程；blank_state 适合状态已知的中间位置。起点越晚，越需要自行补齐之前产生的状态；函数入口还需正确调用约定。
- 动态轨迹说明已走路径。把非输入相关的值具体化能简化表达式，但由环境决定的常量、异常边或其他路径仍可能改变结论。污点未传播不自动证明无依赖。

## 查询与解释

先检查假设 A 可满足，再查询差异或分支；否则矛盾假设会产生空洞的“证明”。

| 查询 | 可作出的结论 |
|---|---|
| A ∧ (f ≠ g) 为 SAT | 模型内存在反例；将见证值代回并按需要运行目标 |
| A ∧ (f ≠ g) 为 UNSAT | 当前语义和 A 内等价；不证明漏掉的状态也等价 |
| A ∧ p 和 A ∧ ¬p 均为 SAT | 分支两向都可能；不属于当前模型内的常量谓词 |
| 仅一向 UNSAT，另一向 SAT | 在 A 内固定走向；是否能删机器码仍需核对异常、标志位和副作用 |
| UNKNOWN、超时、执行失败 | 结论未决；空模型、空输出和非零退出均不能改写为 UNSAT |

## 可用的局部辅助器

`scripts/local_bv_check.py` 是独立编写的 Z3 JSON 辅助器，不依赖 Triton/angr。用已确认含 z3-solver 的解释器运行，输入走 stdin、结果走 stdout；缺依赖会报告 capability_unavailable。

```json
{"width":8,"variables":["x","y"],"assumptions":[],"query":{"kind":"equivalence","left":{"op":"add","args":["x","y"]},"right":{"op":"add","args":[{"op":"xor","args":["x","y"]},{"op":"shl","args":[{"op":"and","args":["x","y"]},1]}]}}}
```

命令示例：`"$PY" "$SKILL/scripts/local_bv_check.py" --timeout-ms 5000 < model.json`，其中 PY 是已选解释器，SKILL 是本 skill 目录。求解预算覆盖假设检查和后续查询，进程硬上限由调用层设置；返回 ok=true 表示完成结果报告，具体结论看 status，仍可能为 unknown。

支持同一位宽的 add/sub/mul/and/or/xor/not/neg/shl/lshr/ashr，eq/ne/ult/ule/slt/sle，以及布尔 land/lor/lnot。常数按声明位宽编码；ult/ule 为无符号比较，slt/sle 为补码有符号比较。移位遵循 SMT 位向量语义；目标若会屏蔽移位计数，需显式加入对应掩码。

辅助器只检查用户声明的模型，不读取机器码，也不模拟内存、异常、浮点、隐含标志位或外部 API；机器语义的恢复仍由分析者完成。脚本没有任意表达式求值、网络、外部命令和结果文件写入接口。

来源核验 2026-10-14：[Triton 等价性实例](https://github.com/JonathanSalwan/Triton/blob/bc84cf745e99768e07d51dcd734eba35c59f1b3e/src/examples/python/proving_equivalence.py)、[谓词实例](https://github.com/JonathanSalwan/Triton/blob/bc84cf745e99768e07d51dcd734eba35c59f1b3e/src/examples/python/proving_opaque_predicates.py)、[angr 状态示例](https://github.com/angr/angr-examples/blob/c98733fb5351e314d515e230b15c12aa99201291/examples/fauxware/solve.py)。吸收其方法，未复制其脚本。Z3 辅助器及错误/预算处理为本地适配；其测试不构成 Triton/angr 后端已验证的证据。
