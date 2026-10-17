# Weft

面向单人本机开发，核心目标是保持对模型 HTTP 与任务工作流的完整知情和控制：准确查看请求次数、发送与收到的数据和服务方用量，自主安排不同模型的主／子 Agent 并发协作。

后续方向是可复用于不同 prompt 的可视化 workflow：节点可代表 Agent、Sub-agent 或小任务，分别选择模型与思考强度；通过流程图监控执行，点击节点追查实际执行详情及通信，支持任务、review 与修正循环。此方向不属于当前第一版实施范围，执行框架尚未选定。

保留自己的 Agent 和可观察的模型调用路径；在此底线之上，所有功能都可以与第三方实现公平比较并择优替换。设计取舍见 [docs/adr](docs/adr/)，实际接口以代码和测试为准。

项目指令、Skills、MCP/Jira、浏览器与图片输入及工具能力恢复的实施规格见 [#159](https://github.com/tylerlong/tyler-agent/issues/159)；项目指令、Skills 发现、显式选择与可信只读资料源、图片输入、本地读图、stdio／Streamable HTTP MCP（含 Jira stdio）与官方 Playwright CLI 浏览器诊断已实现；各子票的交付状态与验证边界仍以实际结果为准。

设计优先采用成熟约定、现有实现和少量统一的默认规则；只有具体需求证明默认规则不足时，才增加配置、例外或依赖。

接入第三方工具时，优先保留上游公开接口的参数、结果与能力，只做协议兼容、权限、归属和记录所需的接线；不得为简化封装而静默删减能力或改变语义。具体差异须说明原因并对照固定版本验证。

## Language

| 术语 | 含义与区别 |
| --- | --- |
| Agent | 一次被接纳的任务执行，可包含多次模型和工具调用。统一使用 Agent，避免 Turn／Agent Run。 |
| Root Agent（主 Agent） | 用户在 Chat 中提交的任务，是任务树起点。 |
| Queue（排队） | Chat 服务端内存中的未开始输入；不是 Agent，成功 Root 清理后按 FIFO 启动，失败／Stop／上限后等待新 Root 或继续队列。服务重启清空。 |
| Sub-agent（子 Agent） | 父 Agent 通过工具创建的任务；与根任务使用同一种执行主体。 |
| Background（委派背景） | 显式交给子任务的背景，区别于任务 prompt；空背景称为 blind。 |
| User Instructions（用户级指令） | 用户为所有 Project 的 Root Agent 与 Sub-agent 提供的共同工作规则，区别于某次任务的具体要求。 |
| Project Instructions（项目指令） | 对指定目录范围内的工作生效的项目规则，区别于按任务需要读取的参考文档；同一 Project 的不同目录可有不同规则。 |
| Skill | 针对某类任务的可复用工作指导，可附带脚本和参考资料；实际能力由工具提供。 |
| Model Call（模型调用） | 属于 Agent 的一次模型 HTTP 通信，拥有独立请求、响应、状态和错误。 |
| Tool Call（工具调用） | 属于 Model Call 的一次工具请求，具有独立执行状态。 |
| Tool Result（工具结果） | 工具实际返回的数据及错误，交给模型决定下一步。 |
| Command Output（命令输出） | 持久保存的实际 stdout／stderr／PTY 流，区别于有长度上限的模型工具结果。 |
| Provisional Content（暂存内容） | 调用尚未成功时收到的可读内容，不代表最终结果。 |
| Complete Response（完整响应） | 服务方实际返回并通过协议校验的完整响应，是成功调用的输出依据。 |
| Tool Access Mode（工具访问模式） | Chat 分别选择的文件／网络受限或完全访问模式。 |
| Project Grant（项目授权） | 同项目所有 Chat 和主／子 Agent 持续复用的额外权限，区别于一次批准。 |
| Pending Approval（待审批申请） | 某次 Tool Call 尚需用户决定的额外权限需求，等待不表示已执行。 |
