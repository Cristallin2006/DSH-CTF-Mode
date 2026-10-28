# 已保存观察与只读静态关联

需要把一次观察定位回原始二进制/DEX 和 Ghidra 时按需使用。模型继续自主选择路线；普通查询无需建图、索引或持久实验。入口为 scripts/re_correlate.py，DEX 索引见 android-re/references/dex-static-index.md。

## 生成精确请求

native 请求使用已有 ELF/PT_LOAD 坐标核对，显式保留进程、加载实例与 rebase 条件：

```bash
python3 scripts/re_correlate.py native-request --image libsample.so --context context.json \
  --from runtime_addr --value 0xYOUR_ADDRESS --evidence saved-observation.json --output request.json
```

context 格式沿用 re-workbench.md：image_sha256、process_identity、load_instance_id、load_bias、ghidra_rebase_delta。不隐式去除 Thumb/PAC/tag，也不猜测 rebase。BSS 等无文件字节的区域保留未定位；多个 PT_LOAD 候选保留歧义。--span 指定本次原始字节核对范围，不证明整个函数均相同。

DEX 请求使用精确静态方法 ID：

```bash
python3 scripts/re_correlate.py dex-request --index case-index.sqlite3 --method METHOD_ID \
  --evidence saved-observation.json --output request.json
```

可用 --runtime 指定已保存的 process_identity、load_instance_id、class_loader_id、dex_sha256、signature；缺失时保留 unknown，冲突时不升级关联。即使字段齐全也只是声明完整，不是经过实时认证的运行绑定。native/abstract 无字节码时记录无可核对文件跨度。

--evidence 是显式选择的原件；请求记录其完整哈希、大小与引用，解释仍由调用方负责。--basis 可保留任务/目标依据，属于数据而非权限。需要持久原件时可用已有 re_lab.py seal；不要求每项简单查询都封存。

## Ghidra 的真实映射与当前字节

在已打开的对应程序中运行 ghidra-static/scripts/ReEvidenceSnapshot.java，参数为 request.json 与一个新的 snapshot.json。也可在独立 headless 项目中将它作为 postScript 使用。脚本只读 Program，不重命名、不注释、不打补丁、不创建事务。

例如使用新建、专用的项目目录，不对正在使用的共享工程做 import/analyze：

```bash
"$GHIDRA_HOME/support/analyzeHeadless" /your/case/new-project EvidenceCase \
  -import /your/case/input.dex \
  -scriptPath /your/dsh-home/skills/ghidra-static/scripts \
  -postScript ReEvidenceSnapshot.java /your/case/request.json /your/case/snapshot.json \
  -readOnly
```

脚本先核对 executable SHA256。native 通过 Ghidra 的文件字节映射找候选；DEX 通过 Ghidra 解码器核对完整 descriptor/方法索引，再读取实际 Dalvik method lookup 表。随后核对当前字节，记录地址空间、函数与函数体范围。不会对 DEX 猜一个固定基址，也不把相同程序名视为相同文件。导出前后修改计数变化时拒绝发布；使用时应选择已完成分析且无其他写入的程序。

单个查询默认读取预算 8 MiB，可在请求中显式设置 read_byte_budget；超过返回 not_read_budget，不用短读冒充相同字节。脚本支持的字节对应关系取决于实际 loader 是否保留文件映射，未映射就报告 unmapped，不能据此判断方法不存在。

快照是本地导出材料，不是密码学认证或 Ghidra 全局锁。程序导入时的文件哈希不证明当前字节未被改写，因此另核对查询字节。函数名和反编译原型仅作为当前静态视图，不证明运行时语义。

## 关联、冲突与引用

```bash
python3 scripts/re_correlate.py link --request request.json --snapshot snapshot.json \
  --evidence saved-observation.json --output association.json
```

可先省略 --snapshot，得到 awaiting_static_snapshot。link 检查精确请求哈希、原始程序哈希、空间和修改计数，再核对当前字节及 native 声明坐标。--evidence 会重新核对显式原件；省略时不读请求里的路径，也不声称重新核对了原件。

结果区分 matched_static_snapshot、ambiguous_static_locations、static_bytes_conflict、declared_coordinate_conflict、partial_static_snapshot 等。matched 只表示所选原件与保存的静态快照匹配；runtime_identity_verified 始终 false，target_accepted 始终 null。加载代次变化不能复用旧请求快照；虚调用、反射和 JNI 注册关联需各自证据。

关联输出不覆盖旧文件。大原件可按固定哈希完整读取：

```bash
python3 scripts/re_correlate.py read --file association.json --snapshot FILE_SHA256 \
  --offset 0 --max-bytes 8192
```

base64 页按字节连接，next=null 才表示读完。--max-document-bytes 可调整本次文件读取预算，拒绝超限而不静默截断。登记到现有任务/记忆时引用该产物与来源哈希，保留适用条件、覆盖和未知项；不另建事实库、不自动通过任务验收。
