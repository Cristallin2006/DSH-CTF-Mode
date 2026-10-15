# 函数级 Oracle

能力与 rootfs/ABI 支持以当前脚本实测为准，示例不证明本机已安装所有后端。

## 2. 函数级 Oracle（oracle.py）

给定二进制 + 函数地址（Ghidra listing 里的地址）+ 参数，真实调用该函数并返回 JSON（retval/stdout/regs/stop_reason）。CTF check 函数验证的标准动作：喂候选输入，看返回 0/1。

```bash
python "$ORACLE" <binary> 0x101064 1 0x20              # 整参（SysV 前 6 / Win64 前 4）
python "$ORACLE" <binary> 0x1020a0 str:flag{guess}     # 字符串参数（自动写内存传指针）
python "$ORACLE" <binary> 0x1020a0 str:test @out.json  # @out 落盘约定
```

**能力与边界（v2，实测）**：

| 场景 | 状态 |
|---|---|
| 静态链接 ELF，任意函数（含 libc 调用） | ✅ 加 `--init-until <main 的 Ghidra 地址>` 先跑 CRT 初始化 |
| 动态链接 ELF，**leaf 函数**（不调 libc：XOR/比较/数学） | ✅ 直接调（PIE/非 PIE 地址自动换算） |
| 动态链接 ELF，调 libc 的函数 | ⚠️ `--init-until` 供使用，但 glibc 版本与 rootfs 不符时初始化可能崩（UC_ERR_FETCH_UNMAPPED）→ 升 Frida/gdb |
| **i386 ELF（32 位）** | ✅ v2 已支持（参数按 cdecl 压栈；rootfs x86_linux） |
| PE（qiling windows rootfs） | 实验性：leaf 函数可调；复杂 PE 可能撞 API stub 缺失 → 升 Frida |
| 浮点参数 / 结构体参数 | 未支持（整型+字符串） |

**中间态取证（`--break` + `--dump`，v2 新增）**：在指定 PC 停下 dump 内存表达式，不用手写 gdb 脚本抓流水线中间态（base64 产物、XOR 中间值、比较前的密文缓冲区）：

```bash
python "$ORACLE" ./encode 0x804887c --init-until 0x804887c \
    --break 0x8048a10 --dump ebp-0x8c:28 --dump 0x804a020:32 --dump eax
```

dump 表达式：`reg+/-0xoff:len`（寄存器相对）、`0x地址:len`（Ghidra 地址，自动换算运行时）、裸 `reg`（只读寄存器值）。`--max-hits N` 控制断点命中几次后停录（默认 1）。断在函数入口时 prologue 尚未执行——`ebp` 还是调用者的，栈参数用 `esp+4:8`（32 位）/寄存器（64 位）读。

已知行为：libc stdout 全缓冲——oracle 的 `stdout` 可能为空但 retval 正确，需要输出证据时在函数里找 write/puts 直接调用或看 retval。
