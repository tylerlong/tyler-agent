# 工具接口与上游能力审查

2026-10-14。检查当前六个内置工具的定义、执行分派、结果续接与相关测试，并检查已讨论的 MCP、Playwright 和图片接入设计。本文记录审查结果及修正建议，不表示已经实现。

## 结论

当前最明确的能力损失在 `exec_command`：Codex 执行后端已有托管进程、输入与 PTY，Weft 却只暴露等待进程结束的调用。应恢复这些上游能力，沿用成熟的模型工具约定，而不是重新设计一套进程管理工具。

另一个共用限制是 `ToolExecution.result` 只能是字符串；它不能直接承载 OpenRouter 已支持的多模态工具结果。错误处理还丢失了有诊断意义的原生字段。

并非所有工具都是第三方同名工具的包装。`read_file` 是文件 RPC 的组合，日志读取和子 Agent 工具属于 Weft 自己的数据与调度。它们不应被误报为删减了同名上游工具。

## 当前工具逐项检查

| 工具 | 实际来源与当前行为 | 差异与处理建议 |
| --- | --- | --- |
| `exec_command` | `src/command-tools.ts` 定义；`src/server.ts` 校验并调用 `CommandExecutor`；复用固定 `@openai/codex@0.162.0` 的 `exec-server`。 | 丢失 yield 后返回、会话续接、stdin、PTY 和中断信号能力；shell 固定 `/bin/sh -c`，输出上限固定。应参考同版本 Codex 模型工具恢复接口和语义，避免另起命名与管理方案。 |
| `read_tool_output` | 读取 SQLite 中归属当前 Agent 的实际命令日志，有界分页；保留 stdout/stderr 顺序。 | 不是上游 `process/read` 的替代品：后者读取有限期进程缓冲，前者读取持久历史。保留日志入口；恢复 PTY 时需支持实际 `pty` 流。 |
| `read_file` | `fs/open` → `fs/readBlock` → `fs/close`；返回字节位置、base64、UTF-8 显示和 eof，单次最多 50 KiB。 | 没有发现被简化的同名上游模型工具。分页与句柄关闭有明确用途；不能将 base64 文件内容当作模型已看见图片。底层其他文件 RPC 的存在，也不意味着必须各注册一个 function tool：当前命令工具已承担发现、复制、移动和删除。 |
| `apply_patch` | 原 patch 字符串直接传给 `codex --codex-run-as-apply-patch`；支持 Add、Update、Move、Delete，没有本地重写语法。 | 上游可用 freeform/lark；Weft 使用 JSON `{patch,cwd,...}`。这改变外层格式，但未删减补丁能力。OpenRouter 跨模型 freeform 兼容性未验证；保留 patch 原文，不能据此武断要求所有模型改用 freeform。 |
| `create_sub_agent` | Weft 自己的 Agent 执行核心；支持明确背景、模型和 reasoning 覆盖，立即返回身份，终态主动通知父任务。 | 不是 Codex spawn-agent 工具的包装。上下文不自动继承、通知和等待规则是 ADR 0002 已确定的产品行为，不是第三方参数被删。没有依据为“直接 expose”而更换调度框架。 |
| `cancel_sub_agent` | Weft 自己的取消逻辑；父模型可取消直接子树，等待清理并返回实际结果。 | 不是上游工具包装。保留归属校验、部分结果和真实取消事实。 |

工具注册全集见 `src/openrouter.ts:277`；命令和文件分派见 `src/server.ts:1038`，子 Agent 分派见 `src/server.ts:1249`。未发现额外隐藏注册的 MCP 或浏览器 function tools。

## 命令侧应恢复的内容

Codex 同版本已有两层接口：

- 后端 RPC：`process/start/read/write/signal/terminate`、`processId`、输出与退出通知。
- 面向模型的工具：`exec_command`、`yield_time_ms`、返回 `session_id`、`write_stdin`；空输入可继续等待输出。

优先参照上游模型工具，不直接把原始沙箱参数和跨 Agent 进程句柄交给模型。npm 包提供原生后端程序，没有可直接导入 Node 的完整 unified-exec 模型工具实现；所需适配应仅连接现有权限、Agent 身份、输出记录和模型协议。

Codex 本身也提供 OneShot 模式；问题在于 Weft 只接入了这一种行为，隐藏了上游的交互式会话能力。后端还支持非 PTY 的可写 stdin，但 Codex 上层工具并不直接开放该开关；不能声称照抄上层参数就自动覆盖全部底层 RPC。

当前具体损失：

- `src/command-tools.ts:7` 明确只能等待结束，参数缺少 yield、tty、shell 和输出预算等上游选择。
- `src/command-executor.ts:494` 固定 `/bin/sh -c`，`:509` 与 `:510` 固定关闭 tty 和 stdin；`:560` 始终等待完成，`:578` 随调用结束丢弃本地句柄。
- `src/command-executor.ts:199` 只保留 RPC 错误 message，丢失 code/data；`:217` 只取退出码，未保留 `sandboxDenied`。应保留实际错误和诊断信息，不靠退出码或日志文本猜测失败类别。
- 当前输出解码与 SQLite 流类型只接受 stdout/stderr。恢复 PTY 必须贯通执行、存储、续读和展示，不能只把 `tty` 参数开放后忽略实际输出。

上游交互模式和 OneShot 模式的等待、超时语义不同；不能机械地把 `yield_time_ms` 和现有“超时杀进程”拼在一起，宣称等同上游。实现前对照固定版本行为确定映射。命令的启动、等待、续接和主动停止由模型通过工具选择，本地不根据命令内容或用途制定策略；职责遵循 ADR 0005。

环境过滤、独立 HOME/scratch、沙箱和句柄归属来自 ADR 0004；应保留。上游后端的 `env` 字段不等于上游面向模型的工具允许任意继承 Weft 服务环境，不能为接口对齐泄露服务凭据。

过滤凭据也不要求固定 `/bin/sh` 或禁止选择 login 行为；这些选择应独立核对上游约定及实际权限兼容性，不能以环境隔离为笼统理由取消。

## 尚未实现的接入

| 接入 | 应保留的上游能力 | 接线边界 |
| --- | --- | --- |
| MCP Tools | 使用服务发现到的 description、inputSchema 和实际调用参数，不维护手写的 Jira 工具子集；保留结果内容、顺序、structuredContent 和 isError。 | 必要时做可逆工具名映射以区分服务；MCP 与 Responses 字段形状不同，按协议映射，不改参数含义。服务 metadata 与实际结果保留记录；不支持的内容明确报告，不能静默丢失。Resources/Prompts/OAuth 等延期仍按已同意范围。 |
| Playwright CLI | 直接使用上游 CLI 与 skill，包括会话、profile、页面操作、console、网络详情、请求/响应 body、截图、trace、run-code。 | 不再另做只允许少数浏览器动作的包装或自行采集 console/network。本地安装的 Playwright 1.63.0 已包含 CLI 实现、帮助与 skill；能否在现有沙箱内完整使用尚需验证。 |
| 图片工具结果 | OpenRouter `function_call_output.output` 支持字符串或 `input_text`/`input_image`/`input_file` 数组。 | 扩展当前字符串结果约束，按原生多模态格式传输图片并保存实际内容；不伪装成用户消息或 base64 文本。模型不支持时明确报告。 |
| Skills | 上游 SKILL.md 与随附脚本、参考资料按需使用；CLI 参数不重写成自己的操作列表。 | Skill 是指导，不是 function tool；发现、显式选择和来源读取仍按 ADR 0007，不能把 skill 的权限声明当作扩大系统权限的授权。 |

## 实施影响和验证边界

命令能力恢复涉及工具 schema、`server.ts` 校验/分派、执行器进程句柄、取消清理、输出持久化、日志读取、工具结果及 UI。图片结果涉及 `ToolExecution`、模型续接、记录和展示。不能只扩展 schema，却让后续校验拒绝新参数，或让执行器继续忽略它们。

相关已有保护在 `test/command-tools.test.ts`、`test/command-lifecycle.test.ts`、`test/command-shutdown.test.ts`、`test/sub-agents.test.ts` 及命令输出 E2E。修正后应验证早返回后继续读写、PTY 输出、中断/取消、Agent 隔离、退出与错误事实以及持久记录；现有权限和关闭清理行为不能回退。

本次仅做静态代码、测试内容和官方资料审查；未运行原生后端、浏览器、MCP、付费模型或整个测试集，未修改运行代码、依赖或数据库。

## 对照来源

- [Codex 0.162.0 exec-server 协议文档](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/README.md)
- [Codex 0.162.0 unified-exec 参数](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/tools/handlers/unified_exec.rs)
- [Codex 0.162.0 exec_command 处理](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
- [Codex 0.162.0 write_stdin 处理](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs)
- [Codex 0.162.0 patch 工具定义](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)
- [Codex 0.162.0 独立 patch 执行入口](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/apply-patch/src/standalone_executable.rs)
- [Playwright CLI 官方说明](https://github.com/microsoft/playwright-cli)
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [OpenRouter Responses 工具与多模态结果](https://openrouter.ai/docs/api_reference/responses/tool-calling)
