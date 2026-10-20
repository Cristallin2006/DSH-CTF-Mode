# 可复现示例 / Runnable examples / 実行例

从仓库根目录运行。均为**合成机制演示**：不调用真实模型、不连接靶场、不读取个人配置或历史 session。示例通过不代表模型具备同样的真实解题能力。

| 示例 / Example | 要求 / Requirements | 验证内容 / Checks |
|---|---|---|
| 字节恢复 / Byte recovery | Python 3.10+ | 4 个有限参数路径、候选判据、SHA-256 校验和重放 |
| 证据复核 / Evidence review | Linux/WSL、Node.js 24+、已安装 DSH | 原生子代理、记录/原文分别授权、中立复核、同一子会话续做 |

## Byte recovery

```bash
python3 examples/recovery/run.py
# Optional: choose a NEW or empty directory for the generated files
python3 examples/recovery/run.py --output-dir /tmp/my-new-recovery-demo
```

输出 `ok: true`、`considered_paths: 4`，恢复公开样本 `ctf{local_replay_only}`。结果目录包含 `spec.json`、`recovery-report.json`、`candidate.bin`；已有文件不覆盖。Windows 可使用 `python`。

This is a known-answer fixture: an independently encoded byte sequence, four declared parameter paths, and a SHA-256 criterion. The result proves local replay, not target acceptance. It needs no DSH installation.

## Native evidence review

```bash
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 examples/evidence-review/run.py
```

它运行仓库已有的原生回归场景：主代理发布保留“推断/未验证”属性的记录；子代理只能召回被授权的记录；原文读取需单独授权；第二角度复核和后续续做保留原文边界；最后完整卸载。流程由确定性本地适配器驱动，不是自主模型演示。

Expected: `PASS`, `externalModelCalls: 0`, `externalTargetRequests: 0`, `fullTeardownCompleted: true`. It creates an isolated temporary DSH home and writes an ignored report under `.test-results/`. The walkthrough reuses `tests/collaborative-native.mjs` so its claims stay tied to exercised behavior.

**日本語:** 復元例は Python のみ、証拠レビュー例は Linux/WSL と DSH 原生ホストが必要です。どちらも合成データの仕組み確認であり、モデルの実力評価や実際のベンチマーク再現ではありません。

安装与维护 / Installation and maintenance: [QUICKSTART](../docs/QUICKSTART.md).
