# DSH 宿主插件（WSL / Linux）

| 插件 | 作用 |
|---|---|
| `analysis-hooks-sandbox` 1.1.2 | 钩子与 `analysis_session` 的专用状态目录能力，原生后台任务归属 |
| `analysis-memory` | 结构化记忆、`dsh_handoff` 材料交接，以及独立的只读有限协作 |
| `analysis-control` | 按宿主导入策略控制 HTTP(S) 预算、速率、origin 与 vault 引用 |
| `analysis-orchestration` 0.7.0 | 实验性专职编排、持续型 Solver、重要前提失效、受限记忆召回与第二角度复核 |

要求 Linux 原生文件系统上的独立状态目录（不要放到 WSL `/mnt/` 盘）。验收宿主为 DSH 0.1.5-rc.3、Node.js 24.21.0，需原生 SQLite 和持续型子代理接口。

## 准备文件与路径

从仓库根目录执行，运行库与 skill 先按[主 README](../README.md)复制。已有安装应先备份、暂停编排并确认收尾，再升级和维护重启；以下步骤不停止服务，也不覆盖数据库。

```bash
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
# 非 npm 全局安装时，改为包含 DSH package.json 的实际目录
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
mkdir -p "$DSH_HOME/plugins" "$DSH_HOME/analysis-state"
chmod 700 "$DSH_HOME/analysis-state"
for plugin in analysis-hooks-sandbox analysis-memory analysis-control analysis-orchestration; do
  cp -R "plugins/$plugin" "$DSH_HOME/plugins/"
done
python3 dsh-hooks/install.py --home "$DSH_HOME"
DSH_HOME="$DSH_HOME" python3 "$DSH_HOME/runtime/analysis-v1/session.py" health
```

钩子安装脚本保留其他配置，检测到同名不同命令时拒绝覆盖；它会复制入口脚本，`--dry-run` 仅预览配置，并非完全无写入。

`DSH_NATIVE_PACKAGE_ROOT` 必须传到启动 DSH 的进程；从其他终端或服务启动也要配置。它用于加载宿主已有模块，不安装或修改 SDK。Node.js、DSH 可执行文件与该包目录应来自同一安装。

## 注册 profile

在所用 `profiles/web/cordis.patch.yml` 或 `profiles/headless/cordis.patch.yml` 中合并以下**顶层 YAML 数组项**。将 `/ABSOLUTE/DSH_HOME` 替换为实际绝对路径，`file://` 使用合法文件 URL；YAML 不会自动展开占位符或 `$DSH_HOME`。

```yaml
- insert:
    - id: hooks-claude-code
      name: file:///ABSOLUTE/DSH_HOME/plugins/analysis-hooks-sandbox/index.mjs?revision=1.1.2
      config:
        dshHome: /ABSOLUTE/DSH_HOME
        pluginRoot: /ABSOLUTE/DSH_HOME/hooks
        configPath: /ABSOLUTE/DSH_HOME/hooks/hooks.json
        selfTest: false
    - id: analysis-memory
      name: file:///ABSOLUTE/DSH_HOME/plugins/analysis-memory/index.mjs
      config:
        enabled: true
        stateRoot: /ABSOLUTE/DSH_HOME/analysis-state
    - id: analysis-orchestration
      name: file:///ABSOLUTE/DSH_HOME/plugins/analysis-orchestration/index.mjs?revision=0.7.0
      config:
        enabled: true
        stateRoot: /ABSOLUTE/DSH_HOME/analysis-state
        maxParallel: 3
```

若已有 `hooks-claude-code`，更新既有条目，不重复插入或同时运行两套桥接。保留原钩子配置内容；适配器委托 DSH 原生桥接调用。`selfTest` 为维护探针，当前含特定工作目录假设，通用配置关闭该启动探针，不关闭钩子；兼容性可用仓库原生测试检查。

可选请求控制另加：

```yaml
- insert:
    - id: analysis-control
      name: file:///ABSOLUTE/DSH_HOME/plugins/analysis-control/index.mjs?revision=1.0.1
      config:
        enabled: true
        stateRoot: /ABSOLUTE/DSH_HOME/analysis-state
        vaultRoot: /ABSOLUTE/DSH_HOME/control-vault
```

注册不自动导入请求策略，也不将普通会话流量纳入计量。策略由宿主显式导入，见[受控请求](../skills/analysis-session/references/controlled-requests.md)。严格 HTTP 模式目前拒绝执行型编排，保持已有控制边界。

## 启动与检查

维护重启后，在新会话检查 `analysis_session health`、`dsh_memory_read health` 和 `dsh_orchestration health/schema`。不可见时先核对实际 profile、模块路径、环境变量和启动错误，不以配置文件存在判断加载成功。

新任务依次 `analysis_session init/bind` → `dsh_memory_write open` → `dsh_orchestration enable`。安装插件不会将所有会话改为编排模式，流程见[编排 skill](../skills/analysis-orchestration/SKILL.md)。

升级后已有任务保持原状态；恢复前检查目标、授权与资源，再明确 `resume/followup`。回退代码前确认子代理收尾，保留当前状态库，不用旧数据库覆盖。
