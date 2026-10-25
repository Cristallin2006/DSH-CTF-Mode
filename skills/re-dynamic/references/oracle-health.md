# 原程序 oracle：先证明程序真的运行

结构化状态与模型比较、原始/派生字段和受限实验副本见 [状态指纹差分](state-fingerprint-oracle.md)。原始样本在 Wine 下输出判定只支持该后端/条件，不能补记原生 Windows 验证。空输出可来自缓冲/崩溃但不能单独定因；切 PTY、插入 fflush 或改调用点都需记录干预，不能自动当原始目标接受。

WSL 内 ELF 直接执行（必要时先 `chmod +x`）；PE 用 `wine <exe>`，不要让 WSL 的 Windows 互操作把 PE 转交给 `cmd.exe`。GUI PE 先启动 Xvfb，使用独立 Wine 前缀；每个测试用例重新启动程序。缺 Debug CRT 时先取消 `WINEDEBUG=-all` 读加载错误，再逐题决定补运行库或转静态路线。DLL 转发 stub 改变环境语义，不能默认视为原始程序 oracle。

`scripts/program_oracle.py` 对同一个目标文件做三次独立运行，记录 SHA-256；三次共用顶层 `argv`（`{target}` 代入目标绝对路径），各用例只改变输入。`expect` 检查运行健康，顶层 `success` 是接受判据，必须在正例成立、反例不成立。只看到不同输出不算接受；成功标记若直接出现在提交输入中，会按可能回显拒绝。JSON 例子：

```json
{
  "timeout": 15,
  "target": "sample.exe",
  "argv": ["wine", "{target}"],
  "success": {"stdout_regex": "Correct"},
  "baseline": {"stdin": "?\n", "expect": {"exit_codes": [0], "stdout_contains": "Input"}},
  "positive": {"stdin": "known-good\n", "expect": {"exit_codes": [0], "stdout_contains": "Correct"}},
  "negative": {"stdin": "known-bad\n", "expect": {"exit_codes": [0], "stdout_contains": "Wrong"}}
}
```

`python3 program_oracle.py cases.json --out oracle.json`：exit 0 表示三项预期成立、正负可区分、且仅正例命中接受判据；exit 2 表示 oracle 无效；exit 1 表示配置错误。输出包含目标 SHA-256、每次的 stdout/stderr/退出码/耗时，日志可纳入 `ledger.py observe`。成功正则仍需人工核对语义；若没有已知正例，先做启动诊断，不能把输出标作接受证据。

GUI 驱动还须在每个用例前确认目标窗口和成功 MessageBox 不存在，输入后回读控件值，再触发校验。Windows 的 `win_gui_drive.py` 只负责 Win32 控件；Wine/Xvfb 下需用 xdotool 或 Wine API 另建驱动，不能把 Windows 脚本直接当 WSL 的 GUI oracle。

异常分流：`c0000135`/`import_dll not found` 是加载失败；空输出也可能来自 `_exit(0)`、长度门、缓冲区未 flush 或 GUI MessageBox。先看 stderr/退出码/耗时与已知基线，不从“静默”直接推出程序逻辑。
