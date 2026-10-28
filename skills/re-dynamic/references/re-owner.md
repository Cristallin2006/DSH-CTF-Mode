# 可选持久实验：本地 owner 与共享资源

只有需要跨模型返回、连接中断或宿主重启保留的本地实验才使用本页。普通静态分析、前台调试和文件查询沿用已有工具。没有默认任务时限、累计实验数量限制、固定路线或强制实验清单。

## 范围与授权

Linux `scripts/re_owner.py` 和可选 `dsh_re_experiment` 独立于模型/DSH 连接。DSH 的 task/work/target 仍是唯一授权依据；模型不能传任意 executable、owner、realm、PID 或资源集合。专职编排 agent 查询、读产物、取消和对账；显式授权的 Solver 执行。

只管理配置好的本地进程组，协调声明的目录和宿主进程身份。目录使用真实路径与祖先关系；进程使用本机 PID 与 boot/starttime。backend、task、target generation、profile 不改变资源身份。多个 profile 必须连接**同一 owner root**并声明各自 realm；不同 root 互不协调，不声称全局独占。

这是声明范围的协调，不是操作系统沙箱：不拦截手工客户端、任意脚本的未声明副作用或自行脱离进程组的程序。进程资源声明也不授予杀该进程的权限；取消只作用于本实验启动的进程组。尚无 Android attach/spawn、Frida 句柄复活、远端取消、Ghidra 回写；宿主测试不能替代设备验收。

## 显式配置

后端由操作者审查和配置，示例路径须替换为真实绝对路径。`allow_arguments` 默认 false，启用时需审查参数能否扩大副作用范围。配置文件私有保存；勿把凭据放入 argv/env 或公开仓库。

```json
{
  "realms":{"preview":"/your/dsh-preview/analysis-state"},
  "backends":{
    "local-observer":{
      "argv":["/your/python3","/your/reviewed-observer.py"],
      "cwd":"/your/isolated-project",
      "resources":[{"kind":"directory","path":"/your/isolated-project"}],
      "allow_arguments":false,
      "output_bytes":8388608
    }
  }
}
```

cwd 自动列入目录协调，省略时使用私有 job 目录。可选 env 是显式环境，不转发 DSH 模型配置。output_bytes 是 stdout/stderr 合计保留预算，可按实验调整；超出会取消并标记观测/保留字节及不完整，不能默默截断后声称完整。它不是任务时长限制；其他文件的磁盘占用仍由操作者管理。

```bash
# 在 checkout 中；只安装文件、生成独立 overlay，不改已有 profile、不启动服务
python3 tools/setup.py --mode full --home /your/dsh-preview \
  --re-owner-root /your/shared-re-owner --re-realm preview --apply
# root 必须是当前用户所有的 0700 目录；服务 socket/token 为 0600
python3 /your/dsh-preview/skills/re-dynamic/scripts/re_owner.py serve \
  --root /your/shared-re-owner --config /your/private-owner-config.json
```

启动隔离 DSH 时按其 patch 用法同时加载原编排 patch 与生成的 launch/re-workbench.patch.json。默认安装不启用 bridge，不下载第三方工具，不配置可执行后端，不调用模型。

## 动作与续做

Solver 显式 tools 包含 dsh_re_experiment。resource 类型的 execution_plan 仅在 bridge 已加载且执行工具限于此工具及 skill/feedback 时通过；添加通用 shell 不获得资源控制保证。此适配器不计候选/请求额度，真实硬额度仍不能绕过。

```json
{"action":"submit","options":{"operation_id":"stable-experiment-key","backend":"local-observer","arguments":[]}}
```

同一 task/work/child 保持相同 operation_id。相同内容返回原 job；内容变化拒绝。连接丢失时查询同一操作，不换 ID 重开，没有自动重放。继续同一原生 child，通过原 job 查询。

| action | options |
|---|---|
| list | 可选 after 字符串、limit 1–100；仅显示有权查询的 job |
| status / cancel / reconcile | 精确 job |
| events | job，可选 after 序号、limit 1–100 |
| read_artifact | job、name stdout/stderr，可选 offset、max_bytes 1–32768、sha256 |

封存产物按二进制 base64 分页，next 是下一字节位置，sha256 固定快照。需要全文就读到 next=null，单页不是全文。事件仅为控制状态记录，不是目标/Frida 事件流。一次 RPC 的等待和传输预算不自动终止实验。

## 取消与恢复

Solver 普通返回不取消持久实验；取消 work、暂停编排、任务离开 running、解绑或目标代次变化会请求收尾。原任务检查复用 analysis_native_jobs；未确认收尾时不释放任务/目标。DSH 正常卸载若执行其原有编排暂停，也遵守暂停语义；单纯连接失联和 owner 服务重启不会重放。

cancel_requested 只是请求。工作者身份回执与产物通过核对后才进入终态并释放租约。worker 丢失、回执损坏、启动窗口不明或收尾不明进入 cleanup_unknown，租约不自动过期。

reconcile 在 worker 锁内核对、阻止迟到启动。证明未启动或已记录本地进程组不存在时，记录失败与证据不完整后释放；否则保留未知，不靠猜测 PID 杀进程，不删除记录冒充收尾。若死在创建进程与落盘身份之间，当前实现保守保留未知，需操作者检查。

finished/退出码 0 只表示受管本地程序完成，不证明结论正确、目标接受、事件流完整或外部任务完成。
