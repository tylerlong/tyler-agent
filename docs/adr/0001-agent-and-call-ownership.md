# Agent 与调用的数据归属

Chat 是持续对话的容器；每次被接纳的 prompt 创建一个执行一次任务的 Agent。Agent 取代 Turn，不再同时保留两个表达同一件事的概念。Model Call 属于 Agent，Tool Call 属于发起它的 Model Call；Tool Call 通过这条关系确定任务归属，不另存 Agent ID。当前阶段不实现 subagent，也不预设父子 Agent 字段。

模型和思考强度属于 Chat 的当前配置，选择修改后立即保存；目标文件夹属于 Project。每次 Model Call 开始时读取 Chat 的当前配置，每次工具执行前读取 Project 的当前目标文件夹。Agent 不复制这些配置；Model Call 的实际请求保留当次使用的选择，已经发出的请求不随配置修改而改变。

Chat 的模型选择允许为空。新 Chat 使用当前默认模型；每次进入可写 Chat，以及在 Settings 关闭后返回当前可写 Chat 时，若选择为空且有默认模型，就将默认模型保存为该 Chat 的选择。有模型的 Chat 不随默认模型变化。Chat 对模型的引用采用删除时置空的外键；删除所选模型后，同一补齐规则适用。进入可写 Chat 时，若没有 API Key 或系统没有任何模型，必须打开 Settings；API Key 已配置且至少有一个模型时才能关闭。接纳 prompt 前必须检查所选模型有效。

归档 Chat 及所属 Project 已归档的 Chat 都维持只读。隐藏整个 prompt 输入区域，包括模型、思考强度和提交控件；不因进入或查看它们而自动补齐模型或强制打开 Settings。保留现有只读规则：禁止新的用户编辑或提交，允许查看、恢复，已经开始的任务继续完成。

未要求改变的行为沿用现状，不逐项重新确认。手动切换模型时保留新模型仍支持的思考强度，否则恢复模型默认；删除所选模型时清空模型与强度。后续 Agent 的历史输入只包含此前成功任务的 prompt 和可读回答；失败任务及其部分输出仍可查看，但不进入后续上下文，历史思考与工具协议不跨 Agent 传递。同一 Agent 内的工具续接继续保留完整协议上下文。

可读的思考和回答输出只保存在所属 Model Call 中，以该调用的稳定本地 ID 确定归属；Agent 的展示输出和后续对话使用的回答从有序 Model Call 输出派生。Agent 不再重复保存聚合输出或回答。通信记录与可读输出分别用于协议排查和内容展示，保留两者是有明确用途的表示差异。

各层保留各自的执行状态：例如第五次 Model Call 成功返回工具请求时，Agent 仍可因调用次数上限而失败，Tool Call 则未执行。模型调用的错误码和错误文本由 Model Call 保存，Agent 的失败展示通过所属调用读取它们；调用次数上限、任务中断等任务本身的错误由 Agent 保存，不复制下级调用的错误。Chat 与 Project 的最近活动时间从所属 Agent 的接纳时间派生，移除 Chat 中重复保存的 `last_question_at`，保持接纳 prompt 才改变活动排序的行为。

这次调整统一替换术语、数据库、代码、HTTP 与事件中的 Turn 命名。实施时重建开发数据库并舍弃旧数据，不提供旧数据迁移或旧接口兼容路径；文档记录本身不执行数据库重建。这个本地应用优先保持明确的归属与最小数据模型，不为配置并发或罕见的保存失败添加配置快照、恢复实体或付费调用自动重试。

数据库保持八张表；`turns` 由 `agents` 取代，其余实体沿用现有结构，只调整已经明确的归属。

| 表 | 所属关系与保存内容 | 本次结构调整 |
| --- | --- | --- |
| `projects` | 用户的项目名称、创建时间、独立归档状态 | 保留 |
| `folders` | `project_id` 与目标路径 | 保留；目标范围由 Project 拥有 |
| `managed_models` | 用户添加的模型 ID、名称与能力元数据 | 保留；Chat 和 Settings 引用模型 ID |
| `settings` | 单一用户的全局偏好、凭据与 `default_model_id` | 保留；模型默认值不复制到 Agent |
| `chats` | `project_id`、名称、创建时间、归档状态及当前模型与强度 | 增加可空的 `model_id`、`reasoning_effort`；删除 `last_question_at` |
| `agents` | `chat_id`、prompt、接纳时间、任务状态与任务自身错误码 | 取代 `turns`；输入列采用 `prompt`；删除聚合回答、聚合输出及未使用的错误详情列 |
| `model_calls` | `agent_id`、实际通信记录、调用状态、可读输出及调用错误 | 用 `agent_id` 取代 `turn_id`；接收 `output_json` 与调用错误码 |
| `tool_calls` | `model_call_id`、协议 call ID、名称、参数、顺序、状态、结果与未执行或中断原因 | 删除 `turn_id`，不增加 `agent_id` |

本地行 ID 用于实体身份与归属；服务方的输出 item ID 和工具 call ID 用于协议处理，不替代本地外键。Model Call 按本地创建顺序读取，调用内输出保留原有 item/part 顺序；输出不再携带跨调用的 `callOrdinal`。Tool Call 保留调用内的工具顺序。Tool Result、Reasoning、Answer 是所属调用中的数据，不新增独立表或执行主体。

Agent 不另存完整历史上下文：当前 prompt 属于 Agent，既有成功历史由 Chat 中更早的 Agent 派生；每次实际发送的完整输入已经包含在 Model Call 的请求记录中。接口和界面可以返回按归属关系派生的任务 ID、回答、错误或活动时间，这些读取结果不再作为重复数据库字段保存。凭据继续按现有安全规则处理，不进入通信记录。

实施按以下顺序进行，当前阶段仅记录计划：

1. 完成统一术语与新建数据库结构，调整外键、查询及派生读取，去除旧 schema 和接口兼容路径。
2. 将模型和强度的保存、有效性检查、删除清空与默认补齐接入 Chat；删除模型时同步清空受影响 Chat 的强度。
3. 按 Model Call 保存有序输出及调用错误，按单一外键读取 Tool Call；执行循环逐次读取当前配置与工具范围。
4. 统一代码、HTTP、事件、界面、测试和 README 中的 Agent 命名；只读 Chat 隐藏输入区域并避免入口补齐写入。
5. 使用临时数据库和假的模型响应验证归属、顺序、默认补齐、只读界面及既有工具循环；实施阶段再重建已获授权的开发数据库，不调用付费模型进行验证。

统一 Agent 接口使用 `/api/agents/:id` 及其 calls、tools、reasoning 读取入口，接纳返回 HTTP 202 与 `agentId`，历史集合使用 `agents`，实时事件使用 `agent`，选项使用 `chatOptions`。Tool Call 只保存 `model_call_id`；读取时沿 Model Call 派生任务 ID。活动取最近 Agent 接纳时间，无任务的 Chat 与无 Chat 的 Project 保留创建时间兜底及 ID 排序；不因完成或编辑更新。新 schema 要求空数据库；普通启动拒绝未知 schema，不自动删除或升级。实施验证使用临时数据库，开发数据库在收尾时单独重建。
