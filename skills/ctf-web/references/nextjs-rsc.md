# Next.js / React Server Components：版本、解析链与观察

用于发现 Next.js、RSC Flight 或 Server Action 线索后的定向研究。实现随版本、路由模式、适配器和部署配置变化，以下是待核对的攻击面，不是当前目标漏洞已成立的证明。

## 指纹和入口

响应头、/_next/static/ 构建工件、客户端 chunk、Flight 响应和依赖清单可以共同定位框架/版本。头部可隐藏或伪造，buildId 不是框架版本号。/_buildManifest.js 中的路由或 rewrites 是部分构建信息，空 __rewrites 不能排除 middleware、代理或服务端动态改写。

RSC 请求常见 `RSC: 1` / `text/x-component`，Server Action 可有 `Next-Action` 头和 Flight 编码体；具体格式、action 标识及校验顺序按同版本实现确认。404/500、HTML 大小与 Flight 树差异可帮助区分落点，不能单靠响应形状确定处理器或是否发生副作用。

## RSC 解析研究

按目标版本选择 react-server-dom-webpack、react-server-dom-turbopack 或 react-server-dom-parcel 等实际依赖，核对 decodeReply、thenable 处理函数与引用解析器；函数名和内部组织也可能随版本变化。

明确攻击者可控字段、chunk 引用规则、属性查找、thenable 处理、this 绑定、参数约定及 action 校验顺序。解码是否先于 action ID 校验必须在具体路径证明；无有效 action 也不自动等于无解析面或存在执行原语。

错误 digest 可能受输入值、异常位置、版本和生产配置影响；相同 digest 不证明同一 gadget，不同状态也不证明 then 已被调用。若朴素候选没有区分解释，读取同版本解析器/构建产物可能比继续枚举更有信息量，是否获取源码遵循当前网络、来源和用户约束。

## 验证信号

优先选择能对应待验证命题的日志、受控本地复现、响应内容或允许的外部观察。耗时实验需要重复对照、基线波动和超时记录；一次未延迟不能排除所有执行路径，固定 N 秒也不是通用可靠阈值。带外观察缺失可能来自网络或回连条件。记录请求身份、完整体、响应、目标版本与干预，候选 gadget 与目标接受分开。

## 其他框架相关入口

- 图片优化器 `/_next/image?url=`：区分相对 URL 的内部处理、绝对 URL 的请求路径、remotePatterns 等配置和内容类型检查。Host 改动或一次非图片错误不足以证明是否联网、是否能读文件。
- middleware 鉴权：核对版本、header 处理和部署层；只凭框架名称或历史 CVE 类别不证明当前可绕过。
- rewrites/反代：比较客户端清单、服务器配置与实际路径，不从单一清单排除所有通道。
- Server Action 本体：参数约束、身份/权限验证、状态变化与重复调用；解析层成立不等于业务授权缺失。

保留未覆盖配置和未证实的调用边。需要协议/组件细节时回到具体版本源码或官方公告核验，而非把某次本地现象写成所有 Next.js 的行为。
