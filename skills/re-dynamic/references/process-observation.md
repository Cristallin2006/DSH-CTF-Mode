# Worker 身份、模块地址与已有结果观察

fork-per-connection、多实例同名 worker 或地址归属不清时按需读。发现、观察、attach 和清理是不同动作；这里只增加只读/离线组件，不给 PID 列表附加变更权限。

## 只读 worker_snapshot.py

Linux/pidfd，显式 --pid PID... 或 --root-pid PID；后者只观察该根的后代，不扫描全机 argv。可按 --exe PATH、--argv-token=--serve、--socket-inode INODE 过滤，输出到 --out NEW_JSON。没有 --one，不自动选最新 PID，不 attach、不发信号。默认不输出完整 argv 或路径；结果仍含敏感运行地址，放在原任务私有范围。

绑定 boot ID+start time，读取前后核对进程/映像/映射。可执行文件用 dev/inode 和 hash，argv 按完整 token 匹配，cmdline 含子串/comm 同名不足以认定 worker。socket inode 可帮助区分连接，但可能被 fork 继承、共享，不单独证明应用 session。树和 /proc 快照非原子，退出、exec 改变、权限不足保持 unknown；多个匹配保留候选，不自行 attach。

模块读取限 ELF64 LE，把目标 exe 的 maps dev/inode、offset 与 PT_LOAD p_offset/p_vaddr 对照，多段核对 load bias。第一条 r--p/offset=0 不保证是主模块或 load bias。runtime=load_bias+ELF_VA；分析映像 VA 需要其明确重基址转换。映像布局不支持或歧义时保留未知，不退回“取第一行”。

pidfd 固定进程引用，不证明调用者有清理权。local_lab 目前仅管理本次直接子进程；本观察器不把 fork 后代接管为自有资源，也不改变 resource 预检。实际调试继续使用已有授权工具。

## attach 与跟随 fork 的观察边界

需要 attach/跟随 fork 时，先关联请求/连接与候选，再核对 PID boot/start、exe 与映像；最新 child、argv、pidfile 或共享 socket inode 都不单独证明归属。attach 会暂停/改变时序，不是无干预只读；前后重核身份/mappings，dump 保留地址域、范围、原始字节和不可读/退出/exec 缺口，不自动追指针或重选进程。GDB 默认跟随 parent，follow-fork-mode child、detach-on-fork off 与多 inferiors 的暂停方式不同，按观察命题选择。插件/commands 兼容故障可用 gdb -nx 或 Python Breakpoint.stop 诊断，不是全局禁用 pwndbg 的规则；停调试与停目标分开。依据：[GDB Forks](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Forks.html)。

## observation_receipt.py：整理既有输出

显式 --plan FILE --out NEW_JSON，不执行命令、不重跑目标、不默认覆盖 FLAG.txt。所有证据在计划目录（或显式 --root）内，保留原字节位置和哈希。计划为 {pattern:"明确 bytes-regex",runs:[{id,instance_id,connection_id,execution_status,exit_code,stdout,stderr?,input?,expected?,acceptance_evidence?:[]}]}；路径为已落盘文件。execution_status=completed/failed/interrupted/unknown，exit_code 可为 null。

pattern 是 UTF-8 编码后对 bytes 匹配的显式规则，不内置 flag 格式；每个完整匹配都保留，不取 stdout/stderr 最后一个充当答案。默认仅保存 hash/locator，--include-values 才保存 value_hex。expected 是明确预期文件的**完整字节**，不 strip 换行；仅比较候选是否匹配，不推断业务成功。

输出区分 observed_candidate/multiple_candidates、matches_explicit_expectation 与执行状态。input 中也出现的值标注可能回显；同/不同候选集合只描述结果，重复内容位置不证明同源或独立。instance/connection 标签是调用者声明，不证明新实例、ASLR 改变或独立执行。每实例动态结果不要求彼此相等。

program_accept/platform_accept 始终 unknown；提供 acceptance_evidence 文件只登记未经适配器验证的证据，不借文件名或文字升级接受。rc=0、正则、重复值均不能单独证明成功。输出文件 0600 且拒绝覆盖，CLI 不打印候选值，不自动发布秘密或方法。

一手接口：[proc maps](https://man7.org/linux/man-pages/man5/proc_pid_maps.5.html)、[pidfd](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)、[ELF 装载](https://gabi.xinuos.com/elf/07-pheader.html)。[GDB 调用目标函数](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Calling.html)会改变运行状态，确需使用时明确记录签名、初态和干预；它不是只读观察。
