---
name: traffic-analysis
description: 对 pcap/pcapng 做协议重组、取证、隐信道与解密分析。输出可复现的包/流证据；提取文件后的二进制语义交逆向分析。
---

# traffic-analysis

## 输入与输出

输入为抓包、捕获条件、协议线索与可用密钥；输出为包/流定位、重组产物、变换、证据与适用范围。

先检查格式、链路类型和截断，再按协议/会话重组。scripts/pcap_triage.py 可轻量分诊，tshark/editcap/scapy 按需发现。包长、TTL、IPID、时序等分布是候选信号，可打印分布不能单独证明隐信道。

字段组合搜索说明字段、顺序、打包与后变换轴，估计候选数、耗时和判定信号。重复键冲突可能来自重传或复合字段，不预设正确组合一定消除冲突；键的确定函数也可能参与抵消。conflict_oracle.py/decode_engine.py 的建议按实验选择。

提取产物保存 hash、流/包范围和解码步骤；文件魔数与可打开性是格式证据，不自动证明解码正确。脚本可用已知向量或第二实现对照。pcap+binary 按待回答问题合作，不强制先完成某一种附件。TLS/WPA 解密按已有密钥条件选择专题。

## 会话与交接

按当前问题选方法，可静态先行、动态先行或直接建模。连续实验没有新增证据时盘点前提和可区分解释的实验；时间盒用于复查，可说明价值后继续原路线。

简单单点查询记录最小证据即可；多阶段、恢复或协作任务按需使用 analysis-session，记录关键结论、目标代次、实验干预和未决问题。普通工具事件由运行层记录。候选与外部接受分别说明，可交付限定范围的未完成报告。共享项目写操作协调所有权；未获变更权时先只读。


## 按需资料

| 文件 | 何时读 |
|---|---|
| `references/protocol-reversing.md` | 未知协议、字段边界、重复键冲突、pcap 与二进制互证 |
| `references/pcap-triage.md` | pcap 修头/pcapfix、`--export-objects` 文件提取、流重组、明文凭据与 NTLMv2、strings 碰运气 |
| `references/tunnels.md` | DNS（dnscat2/尾部字节/TXT/oracle）、ICMP、TCP flags、时序隐信道配方 + 通用元数据直方图方法论 + pcap+二进制复合题载体判定 tells |
| `references/usb-hid.md` | USB 键盘 8 字节报告、鼠标/数位板画图还原、LED Morse、蓝牙 RFCOMM 重组 |
| `references/wifi-tls.md` | WPA eapol 破解+airdecap 二次分析、TLS 解密三途径、SMB3.1.1 会话密钥推导 |

## 补充专题入口

- [tools](references/tools.md)：当前问题涉及文件名对应专题时按需读取。
