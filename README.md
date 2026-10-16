# DSH-CTF-Skill

面向 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness)的 **all-in-one CTF agent skill 合集**：六大题型知识库 + 逆向工程工具链 + 跑分编排与请求控制平台层。

All-in-one CTF agent skills for dsh: web / misc / crypto / pwn / forensics(traffic)/ reverse, plus an orchestration & controlled-request platform layer that prevents runaway brute force, info-loss handoffs and out-of-scope retrieval.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Platform: dsh](https://img.shields.io/badge/platform-dsh-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh)

**前置要求**:dsh · Python 3.10+ ·(可选，仅逆向/pwn)Ghidra 12.x + JDK 21+

## 结构

| 层 | 内容 | 说明 |
|---|---|---|
| `skills/ctf-web` | Web 综合 | 认证/注入/SSTI/反序列化;含「登录受阻优先查信息缺口」参考卡 |
| `skills/ctf-misc` | Misc/平台操作 | 含 hint 购买与容器槽位的机会成本决策卡 |
| `skills/ctf-crypto` | 密码学 | RSA/ECC/格/侧信道攻击配方 |
| `skills/traffic-analysis` | 流量取证 | pcap 分诊、隐信道、USB HID、WPA/TLS |
| `skills/ghidra-core` `skills/ghidra-static` | Ghidra 工具链 | Ghidra 12.x headless RPC daemon,~0.2s/命令 |
| `skills/re-*` `skills/vuln-audit` `skills/android-re` `skills/pwn-exploit` | 逆向 + pwn(原创主力) | 八场景方法论;与 [ghidra-skill-for-dsh](https://github.com/Cristallin2006/ghidra-skill-for-dsh) 同源 vendored |
| `skills/analysis-session` + `skills/analysis-memory` | 编排与记忆 | 任务/目标代次/证据/租约;结构化记忆与有限协作 |
| `runtime/analysis-v1` | 运行库 | 上述 skill 的运行时(session.py / hook.py / legacy_ledger.py / guarded_run.py) |
| `plugins/` | dsh 宿主插件 | **analysis-control**：宿主授权的请求控制(预算/速率/来源白名单/凭据 vault);analysis-memory、analysis-hooks-sandbox |
| `dsh-hooks/` | 钩子 | 会话卡注入(遥测),含 hooks.json 片段与合并脚本 |

## 实测战绩

**TSecBench v1（63 题 / 74 flag / 23000 分满分）——2026-10-14 实测**:

| 指标 | 数值 |
|---|---|
| 获得点数 | **21215 / 23000** |
| 综合得分 | **91.94** |
| 完成率 | **93.2%**(61/63 题） |
| 答对 Flag | **69 / 74** |

本地跑分结果，未托管、未上官方榜单。丢分集中在多阶段渗透题的入口凭据环节(详见下节);这套平台层正是从那 1785 分的教训里长出来的。

## 为什么有平台层

那次跑分复盘发现：丢分不在解题能力，而在信息流程——题目描述被截断导致子代理盲爆破约 30 万次请求、入口凭据其实写在题面原文里；与之对照，二进制题（pwn 5/5 + 逆向 8/8）按机制推演全清、几乎零浪费。本仓库的应对：

- **dsh_handoff**：完整原文分块交接（块级 SHA-256、覆盖度可查、超限显式报错），杜绝"摘要当原文"。
- **analysis-control**：宿主显式导入策略后，该会话的 shell/浏览器/MCP/代码工具被原生拒绝，HTTP(S) 只能经受控执行器——按任务原子扣减请求预算、速率与在途上限、origins 白名单、凭据经 vault 引用不落明文。普通会话不受全局拦截（opt-in)。
- **决策卡**：登录受阻先穷尽被给与的信息；hint/槽位按机会成本评估；进展以"新增可利用事实"计，不以请求数计。

## 安装(WSL / Linux)

**1. skill 与运行库**

```bash
cp -r skills/* ~/.dsh/skills/
mkdir -p ~/.dsh/runtime && cp -r runtime/analysis-v1 ~/.dsh/runtime/
```

**2. 钩子**——幂等合并进 `~/.dsh/hooks/hooks.json`,冲突时报错而不覆盖：

```bash
python3 dsh-hooks/install.py
```

**3. 宿主插件**(可选,请求控制/记忆)——cp 后在 profile 的 `cordis.patch.yml` 注册,条目示例见 [plugins/README.md](plugins/README.md):

```bash
cp -r plugins/* ~/.dsh/plugins/
```

**4. 逆向引擎**(可选,仅逆向/pwn 需要)——见 `skills/ghidra-core` 内说明,自检:

```bash
python3 ~/.dsh/skills/ghidra-core/scripts/doctor.py
```

文档中的 `/root/.dsh`、`/opt/node24/bin/node` 为示例路径,按你的 `DSH_HOME` 与 node 实际路径替换。

## 许可与致谢

本仓库代码以 [MIT](LICENSE) 发布。直接收录/衍生内容、设计参考与知识归纳来源分层列于 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md),感谢所有上游作者。
