# 从一个本地示例开始 / Start here

[中文首页](../README.md) · [English](../README.en.md) · [日本語](../README.ja.md) · [示例说明 / Examples](../examples/README.md)

先下载 [v0.7.0 Preview](https://github.com/Cristallin2006/DSH-CTF-Skill/releases/tag/v0.7.0) 的源码包并解压，或克隆仓库；以下命令均在仓库根目录执行。安装器仅使用 Python 标准库，不下载 DSH、模型或专业工具。

2026-10-21 的四域核心卡与格式契约更新目前位于 `main`，不包含在上述旧标签下载包中；需要本次知识更新时使用当前分支源码。This knowledge update requires `main`. 今回の知識更新には `main` を使用してください。

## 1. 不安装，先运行

Python 3.10+，Windows、Linux、WSL 均可（Windows 将 `python3` 换成 `python`）：

```bash
python3 examples/recovery/run.py
```

预期输出 `"ok": true`、`"considered_paths": 4` 和 `ctf{local_replay_only}`。临时目录保存参数、候选报告和重放结果。它证明有限参数搜索及字节重放正确，不代表目标验收，也不是模型做题演示。

## 2. 选择安装方式

| 模式 | 得到什么 | 还需要什么 |
|---|---|---|
| `skills`（默认） | 专业技能和 references | 自行安装 DSH；实际分析还需模型和对应工具 |
| `full`（实验性） | 技能、状态运行库、钩子、记忆与编排插件、独立启动补丁 | Linux/WSL 原生目录、Node.js 24+、Python 3.10+、DSH 原生宿主 |

仅安装技能不会启用 `analysis_session`、记忆或编排工具。按需使用专业技能即可；需要这些运行时能力时再选择完整模式。

### 仅技能

```bash
python3 tools/doctor.py --mode skills
python3 tools/setup.py --mode skills
python3 tools/setup.py --mode skills --apply
```

默认目标为 `DSH_HOME`，未设置时为 `~/.dsh`；可通过 `--home /your/dsh/home` 明确指定。第二条命令只读预览，不创建目标目录。doctor 不读取个人 profile、密钥或 session；它检查先决条件，不保证模型配置或专业工具可用。

### 完整编排（WSL / Linux）

本次验证宿主：DSH **0.1.5-rc.3**、Node.js **24.21.0**、Python **3.10+**。其他版本需先验证兼容性。状态目录不能放在 `/mnt/`；建议初次体验使用独立 home：

```bash
export DSH_HOME="$HOME/.dsh-ctf-preview"
# 非 npm 全局安装时，填写包含 DSH package.json 的实际目录
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tools/setup.py --mode full
python3 tools/setup.py --mode full --apply
python3 tools/doctor.py --mode full
# 显式初始化状态表：安装器自身不创建数据库
DSH_ANALYSIS_STATE="$DSH_HOME/analysis-state" python3 "$DSH_HOME/runtime/analysis-v1/session.py" health
```

doctor 成功后，先运行不调用真实模型的原生机制示例：

```bash
python3 examples/evidence-review/run.py
```

正常使用时，在上述同一终端创建一个**尚不存在的新 profile**，加载独立补丁：

```bash
dsh --profile ctf-preview --from-default-profile web --patch "$DSH_HOME/launch/ctf-orchestration.patch.json"
# 后续启动使用已经创建的 profile
dsh --profile ctf-preview --patch "$DSH_HOME/launch/ctf-orchestration.patch.json"
```

按 DSH 的正常方式在新 profile 中配置自己的模型服务。源码包不附模型配置或密钥。启动后先确认 `analysis_session`、`dsh_memory_read` 和 `dsh_orchestration` 可用，再让主代理读取 `analysis-orchestration` skill，初始化任务并按需启用编排。插件加载不等于已创建任务或自动派发 Solver。

补丁不包含 `analysis-control` 请求控制策略，不提供全局 HTTP 计费或配额拦截；需要该策略时参考[插件文档](../plugins/README.md)，它与可执行 Solver 的兼容边界保持不变。专业工具如 Ghidra/JDK 仍需自行安装，见 [TOOLSET.md](../TOOLSET.md)。

## 可选 CTF 启动预设

需要主会话主动选择单兵/编排、并在模型调用前强制交付相关 skill 与验证本会话钩子时，使用 `python3 tools/setup.py --mode full --preset ctf` 预览。应用后用 `python3 "$DSH_HOME/launch/ctf.py" --profile ctf` 启动；首次新建 profile 加 `--from-default-profile web`。完整命令、auto/固定模式和故障边界见 [CTF 模式](CTF-MODE.md)。已有 profile 请先按维护流程合并，避免重复注册桥接。

## 升级已有安装

先暂停编排、确认所有子代理和原生后台任务已收尾，再维护升级。安装器会检查默认状态库中的在途/收尾未确认记录并拒绝写入；它无法发现其他状态目录或宿主之外的进程，因此不能代替维护检查。

已有文件内容不同会被拒绝；检查预览后可显式使用 `--replace --apply`。被替换的文件及清单保存在目标 home 的 `setup-backups/<timestamp>/`，应按个人配置保密保存。钩子配置保留其他条目，同名不同命令会拒绝自动合并。脚本不删除无关文件、不覆盖状态库、不改现有 profile，也不重启服务。

已经注册这些插件的 profile 应按[插件文档](../plugins/README.md)合并现有条目，**不要叠加两套桥接或重复插件**。回退前同样先暂停并确认收尾，按备份清单恢复变更文件并移除本次新增文件；不要恢复旧数据库覆盖新状态。脚本写入失败会回退已完成的文件写入，备份仍保留。

## English / 日本語

**English:** Run the Python-only recovery example first. `setup.py` previews by default; add `--apply` to install, with `skills` or Linux-only `full` mode. Full mode creates a separate overlay and leaves existing profiles untouched. Initialize the state database with the explicit `session.py health` command above **before** starting a new profile. Configure your own model separately. `doctor.py` checks prerequisites, not activation or solving quality. Pause/drain existing work before replacing files. Both examples use synthetic inputs and make zero external model calls. Detailed skill material is primarily Chinese.

**日本語:** 最初に Python だけで動く復元例を実行してください。`setup.py` は既定ではプレビューのみで、`--apply` で適用します。`skills` と Linux 専用の `full` を選べます。完全モードは既存 profile を変更せず独立したパッチを生成します。新しい profile を起動する**前に**、上記の `session.py health` で状態 DB を初期化してください。モデル設定は各自で用意します。更新前には既存の作業を停止・収束させてください。両例は合成データを使い、外部モデルを呼び出しません。詳細なスキル資料は主に中国語です。
