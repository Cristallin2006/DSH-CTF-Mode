# Elixir / BEAM Web：入口、权限与制品证据

看到 Cowboy/Plug/Phoenix、Postgrex/Ecto、ETS 或 BEAM 制品时按需读。它们是栈线索，不凭一个 Server 头或报错确认部署，更不直接推断漏洞。先核对实例/映射入口、会话、请求解析和响应来源；Web 通用约定见 [核心观察](core-observations.md)，过滤差异见 [WAF/白名单](waf-allowlist-differentials.md)。

## 从可见证据选择下一步

- 错误页、公开元数据、已有源码或制品可以揭示模块、路由、字段或调试条件。找到调用者和实际消费位置后做最小验证；字符串列表不等于完整路由表。自定义调试头不能变成每题必喷字典。
- 看似固定输出可来自静态响应、缓存、分支未触发、解析前失败或环境差异。记录已测输入与条件，考虑能区分解释的实验；不从固定输出直接宣布整条路线不可用。
- 本地文件/错误配置中的凭据先核对来源、服务、代次和实际接受。名字像诱饵不是反证，文本中出现 secret 也不是有效认证。

## Ecto / Postgrex 与数据库权限

参数绑定与 SQL 文本拼接分别判断，不把 Repo.query! 本身当成漏洞。若错误指向 prepared statement 的多语句限制，核对该调用是否采用扩展协议；PostgreSQL 的单个 Parse 不接受多个 SQL 语句，但简单查询协议不同，不能推断其他单语句能力也被排除。

数据库文件读取需要相应角色/函数授权，还受服务器进程的 OS 权限约束。数据库超级用户、容器身份、应用身份与系统 root 是不同权限域。能读文件不授予执行取回的代码、运行时或启动脚本的权限。

## ETS、求值与分布式服务

ETS 的 public/protected/private、表 owner 和调用进程决定访问条件；表名字符串或泄露的条目不证明其他进程可读取。区分 Erlang term、inspect 展示和真实二进制，不能把显示转义当原字节。

动态求值入口应核对输入如何到达求值器、认证条件、返回通道和执行进程权限。返回一个值、读取文件、执行命令与系统提权分别验证。Erlang cookie 是分布式认证材料，不是自动获得 OS 权限的证明；不默认 epmd/分布式端口可达。

## 同一解题上下文的跨专业路由

取得 .beam/release 后按需加载 `re-triage` 的 `references/beam-artifacts.md`；出现明确 XOR/旋转、CRC expected/actual 或其他校验关系后，加载 `ctf-crypto` 的 `references/crc-oracle-contracts.md`。同一 Solver 可连续使用这些方法，确有独立验证或并行收益时再拆 work。

原始协议字节、目标代次、worker/连接和参数来源随交接保留。摘要不代替选定 skill/reference 的完整交付。多次短 hint 相同只支持观察范围内稳定，不能证明完整值、跨 worker 或重启后不变。普通网络工具的请求预算仍按实际运行层覆盖判断。

资料：[PostgreSQL 15 消息流](https://www.postgresql.org/docs/15/protocol-flow.html)、[ETS](https://www.erlang.org/docs/27/apps/stdlib/ets.html)、[beam_lib](https://www.erlang.org/docs/27/apps/stdlib/beam_lib.html)。具体行为以目标版本和已核对调用为准。
