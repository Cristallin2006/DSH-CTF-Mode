# CTF 预设：启动交付与主动路由

可按会话选择原生 Agent 预设，也兼容旧的独立 profile 方式。宿主在主会话模型调用前交付 ctf-mode 与 analysis-session 完整正文，并核对本会话实际成功的启动/最近钩子回执。

## Web 原生卡片（main，DSH 0.1.5-rc.3 验收）

```bash
export DSH_HOME="$HOME/.dsh-ctf"
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tools/setup.py --mode full --native-preset ctf
python3 tools/setup.py --mode full --native-preset ctf --apply
DSH_ANALYSIS_STATE="$DSH_HOME/analysis-state" python3 "$DSH_HOME/runtime/analysis-v1/session.py" health
```

安装生成 `.agent-presets/ctf/` 和独立宿主补丁 `launch/ctf-native.patch.json`，不会写现有 profile 或设置默认 Agent。先将该补丁的插件行合并到 Web profile 的 `cordis.patch.yml` 后再运行 `dsh web`。已有状态适配器、记忆和编排插件时只补 `dsh-ctf-ui` 行，沿用原有配置；不要把同一插件注册两次。新版 `dsh web` 不接受父命令的 `--patch/--profile` 参数。

原生卡片位于 **设置 → Agent 预设 → 自定义 → CTF 模式**，也可在新会话的预设菜单选择。现有会话仍保留原预设。旁边的 **CTF 模式** 设置页提供新会话默认偏好；原生卡片自身没有配置扩展槽，因此未替换原生管理页。

会话标题旁 **CTF · 实际模式** 可查看 Hook 与知识材料送达、修改本会话偏好、显式切换单兵/编排。默认偏好仅在一个主会话运行状态首次创建时读取，之后修改不追改已有状态。它与原生 Agent 默认预设是两项独立设置。运行状态目前不跨宿主重启保存；恢复会话会重新读取默认偏好并要求重新选择实际模式、重新校验回执。

“自动判断 / 优先单兵 / 优先编排”是软偏好，实际模式只有单兵、编排或待判断。切换使用原生空闲维护阶段与修订号校验，不打断当前轮、不自动派单或取消任务；编排转单兵仍须先通过原接口收尾、disable。没有选专业技能时，UI 选路不代替 Agent 的任务分析与后续技能声明。

界面读取不恢复冷会话，仅返回精简状态；通过 DSH 自带认证传输与 Typert Remote 调用。浏览器与宿主分别校验输入。全局普通会话和子代理不会获得主会话模式控件。安装器从本机 Standard 预设复制组装并解析本机包路径，不将官方组合源文件或本机绝对路径预置进公开仓库；升级 DSH 后应维护重新生成并验收。旧 `--preset ctf` 是进程级入口，两种方式不要叠加。

操作者的任务模板、途中建议、同一 Solver 续做和暂停恢复示例见 [Agent 操作手册](AGENT-OPERATIONS.md)。

## 安装和启动（Linux/WSL）

在仓库根目录、Linux 原生文件系统上的独立 DSH_HOME 中执行。升级已有安装前先暂停并确认子代理/后台资源收尾，预览有冲突时按现有维护流程判断是否 --replace；不要叠加两套钩子桥接。

```bash
export DSH_HOME="$HOME/.dsh-ctf"
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tools/setup.py --mode full --preset ctf
python3 tools/setup.py --mode full --preset ctf --apply
python3 tools/doctor.py --mode full --preset ctf
DSH_ANALYSIS_STATE="$DSH_HOME/analysis-state" python3 "$DSH_HOME/runtime/analysis-v1/session.py" health
python3 "$DSH_HOME/launch/ctf.py" --check
# 仅首次创建这个 profile 时使用 --from-default-profile
python3 "$DSH_HOME/launch/ctf.py" --profile ctf --from-default-profile web
# 后续启动始终加载相同预设
python3 "$DSH_HOME/launch/ctf.py" --profile ctf
```

模型服务仍按 DSH 正常方式配置。启动器不写现有 profile、不自动安装 DSH 或模型，也不携带凭据。原有插件 profile 请手动合并，而不是再套完整 overlay。该预设需要包含 per-session hook_session 回执的 adapter 1.1.3；旧适配器即使文件齐全也会被拒绝。默认完整安装仍生成旧的独立编排补丁，只有 --preset ctf 才生成/启用新 CTF overlay。

## 单兵与编排

默认 --ctf-mode auto：agent 根据目标、依赖、证据共享和交接成本，主动调用 dsh_ctf select。单题一般可单兵，题库一般值得编排，但复杂单题可分工，题库也可串行；宿主不按题数或关键词猜测。

- solo：直接执行已有工具，按声明加载所需专业技能。
- orchestrated：额外交付 analysis-orchestration，主会话计划/交接/监督/复核，由原持续型 Solver 机制执行。

可在安装预览时明确固定 --ctf-mode solo 或 --ctf-mode orchestrated；固定模式不允许 agent 自行反向选择，需改用 auto 或调整 profile 配置。选择模式不创建分析任务、不自动 enable/dispatch，不增加工具权限或默认次数/时间额度。

```json
{"action":"select","mode":"solo","reason":"单题附件先做格式与数据观察","skill_plan":{"required":[{"name":"ctf-misc","reason":"附件分析"}]}}
```

模式工具是 dsh_ctf。技能正文与所选参考/技能自带必读参考在下一模型步重新交付；不能在选择后的同批工具调用中绕过准入直接执行。纯说明/规划可用 required:[] 与具体 none_reason，但基础 CTF 材料始终保留。

单兵转编排后，按既有接口 init/bind、打开记忆并 enable。编排转单兵前先通过原编排接口停止、确认资源收尾并 disable；CTF 模式工具不会暗中取消工作。插件重载后重新选择；Solver/Observer 使用原编排交付边界，主会话预设不会向子代理额外授予工具。

## 检查与故障

- dsh_ctf status：当前选择、材料摘要与当前上下文交付状态。
- analysis_session health：实际状态健康、hook_session 的本会话启动/最近钩子回执。
- dsh_orchestration health：本主会话 current_run，仅用于判断既有编排是否尚未解除。

缺失/禁用 skill、必读参考缺失、超过材料大小限制、上下文未包含完整材料或钩子故障时，不准入模型步/执行工具。主机日志记录 [CTF preset blocked] 原因；状态与 schema 诊断仍可用。修复材料或配置后维护重载，再用新输入继续；不把日志故障当成已执行或已解题。

自动交付每次重算当前内容和参考哈希；压缩移除后在下一次组装恢复，仍须经实际上下文可见性检查。交付证明材料可见，不证明模型理解、应用正确、原目标接受或全部钩子回调永远成功。用户约束、原生权限、审批及请求控制仍各自生效。

## 验证范围

`node tests/ctf-mode.mjs` 检查准入、角色、当前材料、钩子隔离和切换边界；`python3 tests/ctf-preset.py` 检查隔离预设生成、安装/启动参数和旧模式兼容。两者不调用外部模型/目标。

在支持的真实 DSH 宿主另运行 `node tests/ctf-mode-native.mjs`（先设置 DSH_NATIVE_PACKAGE_ROOT），用本地确定性 adapter 验证实际启动钩子、首步正文及专业参考交付。离线单元检查不能替代这一层兼容性验收，也不等于解题能力评测。
