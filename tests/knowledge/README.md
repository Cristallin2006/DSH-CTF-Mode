# Knowledge checks / 知识检查

Run from the repository root (Python 3.10+, Node.js 24+):

```bash
python3 tests/knowledge-contracts.py
python3 tests/knowledge.py
node tests/knowledge-package.mjs
# Optional: installed native DSH, validated on 0.1.5-rc.3
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
node tests/knowledge-package.mjs --native
```

三种结果分开解释：

- **格式与诊断回归**：12 项黑盒格式检查和 2 项受控对拍检查，覆盖 Base64 字母表/填充、保留二进制、显式 ASCII/正则、换行处理及“规律差异不确定根因”。
- **18 个公开合成样本**：8 个调用现有工具/生产 preflight，10 个仅验证人工编写的判断样例和评分器。每个都同时测试正确与错误答案。后者不是自主方法选择、真实 ABI 探测或生产流量解码；结果中的 `measurement` 明确区分。
- **知识包**：默认仅查真实卡、v1 声明、路由与安装清单。`--native` 在新临时 home 中用原生 provider 和确定性本地适配器验证四域单独/组合交付、实际组装字节、同 child 更新与其他 skill 可调用。未选专题不自动进入必需区块。已有上下文替换、坏材料、超限和取消检查继续由 `tests/run.py --native` 覆盖。

`cases/offline.json` 保存输入及适用范围，`answers.json` 保存已知答案与反例；`checkers/registry.py` 只允许固定检查器，不从样本导入任意模块或执行 shell 字符串。示例判断可以有多个允许的选择。复用相同内容自洽通过不等于模型具备对应能力。

测试不调用外部模型或目标，不读取真实 session/模型配置。合成用例中的预算只约束实验，不改变生产默认无时限；运行器不是宿主级断网机制。报告位于忽略的 `.test-results/`，临时 fixture 保留便于排错。公开样本不是盲测，也不产生新的跑分成绩。

## crypto_sanity.py compatibility

Existing options and successful output keys remain. Base64 still defaults to standard alphabet and required padding. Use `--alphabet url --padding omitted` only for an established matching protocol; `--padding unknown` returns **3 / inconclusive**. `--custom-table` validates shape only and does not claim decoded bytes were verified.

诊断失败现在返回 JSON，不再输出强制重读/禁止求逆的文字；依赖旧错误文案的外部调用者需改为解析 `ok/status` 和退出码。仓库核查未发现解析旧文案的程序调用者，文档调用已同步。原有 0/1/2 退出用途保留，3 仅用于显式未知契约。

`check-result` preserves raw bytes in `result_hex`; invalid UTF-8 is not replaced to satisfy a text regex. Terminal LF/CRLF is now kept for checks by default. If the caller intentionally validates line content without its terminator, pass `--strip-final-newline`. `--require-printable` remains opt-in; existing `--allow-binary` override is preserved. Passing local format checks does not establish target acceptance or a complete inverse model.

## Dynamic tool regressions

`python tests/dynamic-tools.py` checks executable-header/ABI rejection, call-frame layout, UTF-8 argument separation, Qiling worker stop classification with a test double, Frida failure/cleanup/hit semantics, fresh/partial dump provenance, and offline CLI descriptions. Windows additionally runs a known Python child through the native suspended-process/capture helper. This is not a real Qiling/Frida/GDB integration or an agent solve-rate measurement.

## Protocol tool regressions

`python tests/protocol-tools.py` runs generated classic-pcap fixtures through the parser and CLI, checking directed-flow separation, VLAN/padding boundaries, truncation/fragment reporting, sequence wrap, first-captured overlap policy, gaps, span bounds and input preservation. These checks do not establish a real unknown protocol or hidden-channel solution. New cards remain optional references, not current-target facts.
