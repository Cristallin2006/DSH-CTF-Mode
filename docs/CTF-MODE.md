# CTF 预设：启动交付与主动路由

这是显式选择的 DSH profile 预设。宿主在主会话模型调用前交付 ctf-mode 与 analysis-session 完整正文，并核对本会话实际成功的启动/最近钩子回执。不是仅追加一条“记得加载技能”的提示。

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
