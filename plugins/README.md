# dsh 宿主插件

| 插件 | 作用 |
|---|---|
| `analysis-control` | 宿主授权的请求控制：策略导入后,受控会话仅可经 `dsh_control` 发 HTTP(S),shell/浏览器/MCP/代码工具被原生拒绝;请求预算/速率/在途上限按任务原子扣减;凭据经 vault 引用 |
| `analysis-memory` | 结构化分析记忆(`dsh_memory_read/write`)与 `dsh_handoff` 完整材料交接、`dsh_evidence` 只读子任务 |
| `analysis-hooks-sandbox` | 钩子执行沙箱 |

## 注册方式

复制到 `~/.dsh/plugins/` 后,在所用 profile(如 `~/.dsh/profiles/web/cordis.patch.yml`)的 loader 条目中加入:

```yaml
    - id: analysis-memory
      name: file:///root/.dsh/plugins/analysis-memory/index.mjs?revision=handoff-1.0
      config:
        enabled: true
    - id: analysis-control
      name: file:///root/.dsh/plugins/analysis-control/index.mjs?revision=1.0.1
      config:
        enabled: true
        stateRoot: /root/.dsh/analysis-state
```

路径按实际 `DSH_HOME` 替换。策略导入与字段说明见 `skills/analysis-session/references/controlled-requests.md`。
**注意**:analysis-control 是 opt-in——不导入策略时普通会话不受任何网络约束。
