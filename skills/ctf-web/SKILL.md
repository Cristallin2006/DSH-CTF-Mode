---
name: ctf-web
description: 分析 HTTP 服务、认证、接口数据流与服务端缺陷；适用于 Web 题或授权的 HTTP 分析。语言能力隔离归 ctf-misc，数学问题归 ctf-crypto，文件分析按当前问题交接。
---

# ctf-web

## 输入与输出

使用本技能的请求身份、响应解释与验证约定见 [核心观察卡](references/core-observations.md)。编排 Solver 由宿主完整交付此卡；普通模式从该入口读取。具体漏洞与协议资料仍按线索选择。

输入为服务实例、HTTP 入口、授权/请求约束和当前问题；输出为请求/响应、会话条件、数据流、验证结果与适用范围。

建立最小基线，按响应/源码/协议线索选择专题；认证 cookie、token 与服务实例关联。脚本统计状态码、长度、时间与内容差异。banner/CVE 只作线索，目标版本和条件需核验。会话改变后异常、框架入口疑似可利用或多服务链路受阻时，读取 [差异诊断](references/differential-diagnostics.md)，选择能区分解释的实验；不根据单次 500、版本号或未发现端口直接判断根因。

工具由 analysis-session 的 discover 按需发现，Python import 在对应解释器测试。网络代理按请求作用域选择，不清空全局代理。scripts/async_fuzz.py 的并发需显式提供 --threads，依据目标响应与任务约束决定；429/超时后先评估速率。

JS 沙箱的 HTTP/cookie/输入输出归这里，宿主对象访问与能力隔离问题交 ctf-misc，双方保留服务身份与入口证据。JWT 的 HTTP/认证语义归这里；已明确数学结构可由 crypto 协助。平台地址/提交规则只留在当前任务。

## 会话与交接

按当前问题选方法，可静态先行、动态先行或直接建模。连续实验没有新增证据时盘点前提和可区分解释的实验；时间盒用于复查，可说明价值后继续原路线。

简单单点查询记录最小证据即可；多阶段、恢复或协作任务按需使用 analysis-session，记录关键结论、目标代次、实验干预和未决问题。普通工具事件由运行层记录。候选与外部接受分别说明，可交付限定范围的未完成报告。共享项目写操作协调所有权；未获变更权时先只读。


## 决策表(症状 → 读哪个文件)

| 症状/线索 | 读 |
|---|---|
| SQL 注入(含盲注生成器、WAF 绕过、二阶) | `sql-injection.md` |
| WAF / 过滤器 / 白名单 / 401/403 解析差异 | `references/waf-allowlist-differentials.md` |
| SSTI / SSRF / PHP 特性 / LFI(php://filter) | `server-side.md` |
| XXE / XML 注入 / 命令注入 / GraphQL | `server-side-2.md` |
| 上传转 RCE / LaTeX 注入 / 直接代码执行 | `server-side-exec.md`、`server-side-exec-2.md` |
| 反序列化(Java ysoserial / Python pickle / PHP) | `server-side-deser.md` |
| 高级 SSRF / 路径遍历 / 解析器差异 / 框架特性 | `server-side-advanced.md`、`server-side-advanced-2.md`、`server-side-advanced-3.md`、`server-side-advanced-4.md` |
| XSS / CSRF / 缓存投毒 / 请求走私 / admin bot | `client-side.md`、`client-side-advanced.md` |
| 认证绕过 / IDOR / 隐藏端点 / 子域接管 | `auth-and-access.md`、`auth-and-access-2.md` |
| JWT/JWE(弱密钥、密钥混淆、头部注入) | `auth-jwt.md` |
| OAuth/OIDC / SAML / CORS / IdP | `auth-infra.md` |
| 原型链污染 / Node HTTP 链；语言隔离交 misc | `node-and-prototype.md` |
| 智能合约 / Web3 | `web3.md` |
| 按 banner/header/依赖版本匹配已知 CVE | `cves.md` |
| Next.js、RSC、Server Action 或 Flight 解析 | `references/nextjs-rsc.md` |
| 跨主机凭据、跳板、权限边界或分段产物 | 按需选 `ctf-attack-chain` |
| 不知道打什么 / 要多阶段链参考 | `field-notes.md`(长案例集) |
| 写 HTTP 发包/fuzz 脚本 | `python-requests.md` + `scripts/async_fuzz.py` |

`quick-reference.md` 用于专题不明时的速查；只读取当前相关资料。

## 补充专题入口

- [tools](references/tools.md)：当前问题涉及文件名对应专题时按需读取。

## 登录受阻与请求成本

认证信息不完整、准备候选尝试、响应同质或服务退化时，读取 [login-evidence.md](references/login-evidence.md)。受控任务使用 dsh_control，普通网络脚本不自动受其预算约束。
