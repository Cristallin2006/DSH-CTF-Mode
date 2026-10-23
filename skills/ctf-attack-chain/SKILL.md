---
name: ctf-attack-chain
description: 分析授权 CTF/靶场中的凭据、立足点、跳板与内网服务、Linux 权限变化和分段 flag。按当前证据选择阶段；Web 漏洞细节交 ctf-web，二进制语义交 re-*，不负责宿主编排或授权决策。
---

# ctf-attack-chain

输入为目标与授权范围、当前身份、原始题面/附件和已有证据；输出为有出处的链路、各跳身份/服务/实例、已验证能力、未决前提和可继续的实验。

## 按当前问题选资料

| 问题 | 资料 |
|---|---|
| 只有目标入口，需确认服务与路由 | [目标侦察](references/recon-target.md) |
| 登录受阻，需核对凭据来源与服务 | [凭据](references/credential-access.md) |
| 已有账号或执行能力，需确认会话与身份 | [立足点](references/foothold-shells.md) |
| 需跨主机、跳板或解释异常端口响应 | [横移](references/lateral-movement.md) |
| 低权限身份，需研究权限边界 | [Linux 权限](references/linux-privesc.md) |
| 发现候选或分段产物 | [收集与验证](references/flag-collection.md) |

阶段可以跳过或交叉，单一漏洞也可能完成目标。按已有材料核对信息缺口，不强制先扫全环境、固定尝试次数或自动扩大字典。认证计数、弱口令提示和题面描述是线索，不能代替授权、锁定条件及成功判据。

候选凭据记录来源、适用主机/服务、账户域与验证状态。原始秘密按当前环境的凭据保存约定引用，不在交接摘要中无必要地复制。代理代答、缓存、实例更换可能改变观察；连接成功不等于应用服务可用。

多阶段任务可按需使用 analysis-session/analysis-memory，保留主机、身份、端点、输入、响应、目标代次和前提版本。简单实验记录最小证据即可。编排与工具权限由宿主及用户授权决定，加载本 skill 不增加执行或递归派单权限。

Web 注入、认证逻辑等细节按线索选 ctf-web；二进制转 re-triage/re-*；流量转 traffic-analysis。不要求把整个技能库装进上下文。
