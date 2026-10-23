# Windows 调试通道：按待验证命题选择

| 后端 | 可回答的问题与边界 |
|---|---|
| Qiling PE 函数实验 | 已支持架构/ABI 下的局部语义；依赖 rootfs、解释器和初始化，不替代原生 Windows 内核/加载器行为 |
| Wine / winedbg | 在 Wine 实现和前缀中的行为；版本、异常、堆、缓解和 API 可能与 Windows 不同 |
| 原生 Windows API 调试 | 本次明确启动的进程、异常、寄存器、模块和栈快照；调试器本身是干预，不等于未调试平台接受 |
| WinDbg/cdb/x64dbg | 需要更完整的符号、展开栈或交互断点时按实际可用通道选择，GUI 安装不代表可脚本化接口可用 |

这不是固定升级顺序。静态问题可留在 WSL，不必启动任何 PE；与实际 Windows 异常/缓解有关的问题优先取得相应原生证据。解释器、rootfs 和工具路径显式发现/传入，不写死作者机器路径。

## 原生最小适配器

使用 **Windows x64 上的 64 位 Python**：

```text
python windows_debug.py --describe
python windows_debug.py --check C:\LAB\sample.exe
python windows_debug.py --out C:\LAB\new-observation --timeout 15 C:\LAB\sample.exe input
python windows_debug.py --out C:\LAB\binary-input --stdin-file C:\LAB\input.bin C:\LAB\sample.exe
python windows_debug.py --pid 1234
```

`--describe` 离线查询；`--check` 读 PE/哈希并检查宿主条件，不执行目标或创建目录。`--pid` 仅对明确 PID 查询进程缓解策略，不附加/暂停/清理该进程。实际执行必须给 sample 与新的 --out 目录；所有适配器选项放在 sample 前，随后参数经 Windows argv 规则传入，不走 shell。输出目录已经存在时拒绝覆盖。

支持 x64 子进程和 x86/WOW64 上下文；ARM/32 位宿主未支持，不自动换后端。WSL 默认不隐式调用 Windows 互操作。确需从 WSL 访问原生 Windows 时，先明确宿主解释器、Windows 风格的样本/产物路径及原有工具授权，不能把 /mnt/c 路径原样当 Win32 路径，也不能借此绕过执行边界。

已有获准的 Windows 执行通道时，可用 wslpath -w 转换 adapter、样本和输出目录的路径，再把它们作为独立 argv 传给所选 Windows Python。/root 下脚本通常转换为 WSL UNC 路径，需确认宿主可读；不支持时将适配器放进明确授权的 Windows 工作目录。产物用对应路径映射或显式副本回到当前任务可读范围，不自动把宿主全盘或 Linux 私有路径加入授权。

工具以 DEBUG_ONLY_THIS_PROCESS 启动指定进程，限制继承到自建 I/O 句柄，不修改页面权限、寄存器、令牌、系统缓解或 Page Heap。记录 CREATE/LOAD/EXCEPTION/EXIT、异常码和 first/second chance、当前寄存器、模块基址以及有实际读取长度的栈字节；**栈字节不是已展开调用栈**。需要可靠展开时另用合适调试器，不能从栈上的可执行地址自动拼接调用链。

第一个 first-chance breakpoint 按常见调试器初始断点处理，回执明确保留该假设；其他异常使用 DBG_EXCEPTION_NOT_HANDLED 交给应用/系统，不一律吞掉崩溃。首次异常或 first-chance 不等于未处理缺陷。进程策略在创建事件时查询，仅代表那个快照；应用后续可变更策略，需要时重新只读查询。

## 完整材料与状态

stdout.bin、stderr.bin 和 receipt.json 保存到新目录。CLI 只返回短回执及完整材料路径；详情按文件工具完整读取，不信任被截断的终端输出。回执含输入 argv、样本前后哈希、事件、实际读数、干预与清理结果，不把敏感参数无必要复制进共享记忆。

默认 stdin 为 NUL；--stdin-file 显式复制完整只读输入快照到 stdin.bin，再重定向给本次子进程，核对源与快照哈希，不删改原件、不截断字节。重定向不等于控制台输入，已提供字节也不证明全部被目标消费；程序的 ReadConsole/编码/长度和协议条件仍须核对。

ok 表示观察完成且文件复核/本次进程清理确认；**异常退出也可能是完整观察**，需检查 exit_code 和 exception_code，不等于程序成功。target_accepted 始终为空。失效/缺失文件、无法读寄存器或栈、查询不支持保持显式未知/部分状态。

--timeout 默认 15 秒，0 为不限本次实验时间；--max-events 默认 1024，达到后明确中断并清理本次进程。它们是本次实验预算，不是宿主任务时限或强制换线规则。调用中断会尽力清理，宿主硬终止时不能凭没有新日志宣称已清理。工具不查杀同名进程，也不追杀或宣称清理了目标自行产生的后代进程；这些需原有资源管理单独确认。

原生执行不是安全沙箱，运行条件仍须适合样本。不会自动安装调试器、下载符号、修改 IFEO 或启动后台服务。Page Heap 等持久配置需要原值、精确映像身份和恢复验收，不能作为每题默认动作。

候选/负例的独立原始观察可按需用 windows_oracle_receipt.py 整理，整理器不运行程序或自动判断成功。原生调试与未干预运行的结论分别说明。

一手接口：[Debugging events](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events)、[CONTEXT](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-context)、[GetProcessMitigationPolicy](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessmitigationpolicy)。
