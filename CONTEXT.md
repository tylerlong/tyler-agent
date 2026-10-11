# Tyler Agent

面向单人本机开发，核心目标是保持对模型 HTTP 与任务工作流的完整知情和控制：准确查看请求次数、发送与收到的数据和服务方用量，自主安排不同模型的主／子 Agent 并发协作。

保留自己的 Agent 和可观察的模型调用路径；在此底线之上，所有功能都可以与第三方实现公平比较并择优替换。设计取舍见 [docs/adr](docs/adr/)，实际接口以代码和测试为准。

## Language

| 术语 | 含义与区别 |
| --- | --- |
| Agent | 一次被接纳的任务执行，可包含多次模型和工具调用。统一使用 Agent，避免 Turn／Agent Run。 |
| Root Agent（主 Agent） | 用户在 Chat 中提交的任务，是任务树起点。 |
| Sub-agent（子 Agent） | 父 Agent 通过工具创建的任务；与根任务使用同一种执行主体。 |
| Background（委派背景） | 显式交给子任务的背景，区别于任务 prompt；空背景称为 blind。 |
| Model Call（模型调用） | 属于 Agent 的一次模型 HTTP 通信，拥有独立请求、响应、状态和错误。 |
| Tool Call（工具调用） | 属于 Model Call 的一次工具请求，具有独立执行状态。 |
| Tool Result（工具结果） | 工具实际返回的数据及错误，交给模型决定下一步。 |
| Command Output（命令输出） | 持久保存的实际 stdout／stderr，区别于有长度上限的模型工具结果。 |
| Provisional Content（暂存内容） | 调用尚未成功时收到的可读内容，不代表最终结果。 |
| Complete Response（完整响应） | 服务方实际返回并通过协议校验的完整响应，是成功调用的输出依据。 |
| Tool Access Mode（工具访问模式） | Chat 分别选择的文件／网络受限或完全访问模式。 |
| Project Grant（项目授权） | 同项目所有 Chat 和主／子 Agent 持续复用的额外权限，区别于一次批准。 |
| Pending Approval（待审批申请） | 某次 Tool Call 尚需用户决定的额外权限需求，等待不表示已执行。 |
