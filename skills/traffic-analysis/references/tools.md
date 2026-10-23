# 本 skill 工具入口

按当前问题选择工具，用 --help 查参数；工具是否可用以发现/功能探针为准。

| 脚本 | 用途线索 |
|---|---|
| `scripts/conflict_oracle.py` | conflict_oracle.py - 重复键字段冲突预言机：哪些字段在重复逻辑键上取值冲突，哪些算子组合能消除冲突。 |
| `scripts/decode_engine.py` | decode_engine.py - 声明式多轴全交叉解码引擎（oracle 硬门）。 |
| `scripts/dnscat2_reassemble.py` | dnscat2_reassemble.py - DNS 查询名列表 -> dnscat2 隧道 payload 重组。 |
| `scripts/hid_keyboard.py` | hid_keyboard.py - USB HID 键盘报告（8 字节）还原文本。 |
| `scripts/mouse_render.py` | mouse_render.py - HID 鼠标/数位板相对位移 -> 累加轨迹 -> PGM 灰度图。 |
| `scripts/pcap_triage.py` | pcap_triage.py - 纯 stdlib 的 pcap 开局分诊：协议分布 / 包长直方图 / top 会话对 / 每流字段一致性矩阵。 |
| `scripts/timing_decode.py` | timing_decode.py - pcap 元数据隐信道解码：时序分档 / 包长 / 单字节字段。 |


## 未知协议增量工具

| 文件 | 范围 |
|---|---|
| `scripts/field_infer.py` | 按有向五元组统计 payload 偏移分布；不恢复应用消息边界。 |
| `scripts/stream_reassemble.py` | 按首次捕获字节重组 IPv4 TCP，报告冲突、缺口及覆盖限制。 |

两者可 `--describe` 离线查询范围。复合协议与多层材料见 protocol-reversing.md；缺口零填充和高熵均不能独立证明解码正确。
