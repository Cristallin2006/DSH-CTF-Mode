# 函数级 Oracle

`oracle.py` 在 Qiling 中构造函数调用，返回实际停止原因、寄存器和可选内存观察。它是仿真实验，返回值不等于原平台接受。

## 配置与调用

在 Linux/WSL 内默认直接执行所选解释器，不再调用嵌套 wsl。通过 `--python` 或 `DSH_QILING_PYTHON` 选择含 Qiling 的解释器，通过 `--rootfs` 或 `DSH_QILING_ROOTFS` 指定与样本匹配的 rootfs。没有作者机器路径或 root 用户默认值。

```bash
python3 "$ORACLE" --describe
python3 "$ORACLE" ./sample 0x201100 1 str:test \
  --image-base 0x200000 --abi sysv64 --rootfs /path/to/rootfs \
  --python /path/to/venv/bin/python --check
# 去掉 --check 才执行目标；可添加 --out result.json（兼容 @result.json）。
```

Windows 默认使用 WSL transport；可指定 `--wsl-distro`，否则使用 WSL 默认发行版和用户。rootfs 与解释器路径必须是后端路径；样本和回执使用宿主路径。`--transport native` 可显式选择本机后端，是否能运行由后端决定。

`--check` 验证格式、参数和依赖导入/rootfs 目录，不运行目标。成功仅表示这些检查通过，不证明 libc、动态链接器、设备或运行时初始化兼容。

## 当前支持范围

| 项目 | 契约 |
|---|---|
| 格式/架构 | little-endian ELF x86/x86-64；PE i386/AMD64；损坏头和其他 machine 拒绝 |
| ELF x64 | SysV64，最多六个整数/指针参数 |
| PE x64 | Win64，最多四个整数/指针参数，预留 shadow space |
| i386 | cdecl 栈参数；调用方须确认实际 ABI，不自动识别 stdcall/fastcall/thiscall |
| 参数 | 整数或 `str:` UTF-8 C 字符串；不支持浮点、结构体、可变参数函数或 x64 栈参数 |
| 地址 | 分析 VA，按运行时 image base 换算；`--image-base` 可覆盖默认分析基址 |
| PIE | 默认分析基址保留 0x100000 兼容约定；若 Ghidra 项目使用不同基址必须显式覆盖 |
| 初始化 | 需要 CRT/全局状态时使用 `--init-until VA`；未到达该地址则不调用函数 |

不为绕过参数检查丢弃参数或改变 ABI。超出支持范围时按当前问题选择专门 harness 或实际进程调试。

## 观察与结果

`--break VA --dump rax --dump rbp-0x20:32` 可记录断点寄存器/内存；`--max-hits` 控制最大记录次数。地址是分析 VA，寄存器相对表达式使用运行时寄存器。函数入口处帧指针未必已初始化。

`retval_valid` 只有确认进入函数并到达返回哨兵时为真；否则 `retval=null`。请求断点却未命中、dump 失败、异常或停止但未返回均不算完整实验。`stopped_without_return` 不武断归因为超时；保留最终 PC。`target_accepted` 始终为空。

每次 worker 在 rootfs/tmp 下使用独立暂存目录并清理，保留源样本哈希。ELF stdout 仅捕获实际 write 的字节；缓冲未刷新、其他输出机制和 PE stdout 不在该捕获范围。

仿真时间预算与宿主 worker 超时分开；硬终止或 WSL transport 中断可能阻止 worker 的 finally 执行，此时不能声称远端清理已确认。工具不会自动切换后端或重放实验。
