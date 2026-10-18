# 工具接口与上游能力审查

2026-10-14 初次审查；#160 已恢复下述命令能力。其余接入的实现状态按各自 ticket 和代码确认。

## 结论

`exec_command` 与 `write_stdin` 已连接 Codex 0.162.0 的托管进程、PTY、输入与中断。模型决定运行、等待、续接和主动停止，完整 Command Output 归属启动它的 Tool Call；返回时事实与当前进程状态分别保存。

初次审查还发现字符串 Tool Result 与原生错误信息丢失的限制。#163 已接通原生图片结果数组；#160 保留原生错误 code/data 和后端错误事实。

并非所有工具都是第三方同名工具的包装。`read_file` 是文件 RPC 的组合，日志读取和子 Agent 工具属于 Weft 自己的数据与调度。它们不应被误报为删减了同名上游工具。

## 当前工具逐项检查

| 工具 | 实际来源与当前行为 | 差异与处理建议 |
| --- | --- | --- |
| `exec_command` | `src/command-tools.ts` 定义；`src/server.ts` 校验并调用 `CommandExecutor`；复用固定 `@openai/codex@0.162.0` 的 `exec-server`。 | 支持 `cmd/workdir`、`shell/login/tty/yield_time_ms/max_output_tokens`。默认交互模式；`session_id` 仅能由所属 Agent 使用。旧 `command/cwd/timeout_ms` 兼容为 OneShot，timeout 不能与 tty/yield 混用。 |
| `read_tool_output` | 读取 SQLite 中归属当前 Agent 的实际命令日志，通过行迭代器有界分页；保留 stdout/stderr/pty 顺序和 JavaScript 字符串偏移。 | 总字符数仍扫描全部行，模型侧仅保留当前行和请求页；完整日志 UI／API 显式收集为完整有序数组。不是上游 `process/read` 的替代品：后者读取有限期进程缓冲，前者读取持久历史。完整解码文本、流标签和顺序持久保存，不另存原始字节／base64；无效或未完成 UTF-8 字节显示替换字符。 |
| `read_file` | `fs/open` → `fs/readBlock` → `fs/close`；返回字节位置、base64、UTF-8 显示和 eof，单次最多 50 KiB。 | 没有发现被简化的同名上游模型工具。分页与句柄关闭有明确用途；不能将 base64 文件内容当作模型已看见图片。底层其他文件 RPC 的存在，也不意味着必须各注册一个 function tool：当前命令工具已承担发现、复制、移动和删除。 |
| `apply_patch` | 原 patch 字符串直接传给 `codex --codex-run-as-apply-patch`；支持 Add、Update、Move、Delete，没有本地重写语法。 | 上游可用 freeform/lark；Weft 使用 JSON `{patch,cwd,...}`。这改变外层格式，但未删减补丁能力。OpenRouter 跨模型 freeform 兼容性未验证；保留 patch 原文，不能据此武断要求所有模型改用 freeform。 |
| `create_sub_agent` | Weft 自己的 Agent 执行核心；支持明确背景、模型和 reasoning 覆盖，立即返回身份，终态主动通知父任务。 | 不是 Codex spawn-agent 工具的包装。上下文不自动继承、通知和等待规则是 ADR 0002 已确定的产品行为，不是第三方参数被删。没有依据为“直接 expose”而更换调度框架。 |
| `cancel_sub_agent` | Weft 自己的取消逻辑；父模型可取消直接子树，等待清理并返回实际结果。 | 不是上游工具包装。保留归属校验、部分结果和真实取消事实。 |

工具注册全集见 `src/openrouter.ts:277`；命令和文件分派见 `src/server.ts:1038`，子 Agent 分派见 `src/server.ts:1249`。未发现额外隐藏注册的 MCP 或浏览器 function tools。

## 命令侧应恢复的内容

Codex 同版本已有两层接口：

- 后端 RPC：`process/start/read/write/signal/terminate`、`processId`、输出与退出通知。
- 面向模型的工具：`exec_command`、`yield_time_ms`、返回 `session_id`、`write_stdin`；空输入可继续等待输出。

优先参照上游模型工具，不直接把原始沙箱参数和跨 Agent 进程句柄交给模型。npm 包提供原生后端程序，没有可直接导入 Node 的完整 unified-exec 模型工具实现；所需适配应仅连接现有参数校验、Agent 身份、输出记录和模型协议。

Codex 本身也提供 OneShot 模式；初次审查时 Weft 只接入这种行为，#160 已恢复交互式会话能力。后端还支持非 PTY 的可写 stdin，但 Codex 上层工具并不直接开放该开关；不能声称照抄上层参数就自动覆盖全部底层 RPC。

#160 实际接线：

- 不带 `timeout_ms` 为交互模式，默认等待 10000ms，按上游夹至 250–30000ms；到期返回存活 `session_id`，不终止进程。
- `write_stdin` 有输入时等待 250–30000ms，空输入等待 5000–300000ms。PTY 直接接收文字和 Ctrl-C；非 PTY 沿用上游只接受 Ctrl-C，调用原生 `process/signal`，不开放后端专用 `pipeStdin` 参数。
- 显式 `timeout_ms` 保留旧 OneShot 行为，等待完成、超时终止、不可续接；拒绝同用 `tty:true` 或 `yield_time_ms`，避免混淆两种生命周期。
- 原生 JSON-RPC 错误保持 `error` 可读文本，并保留 `error_code/error_data`；原生 `sandboxDenied`、退出码、部分输出、取消及后端断开事实不靠文本推测。
- Tool Result 保存返回当时的事实；`commandState` 是同一启动 Tool Call 上的当前进程状态，完成时更新，服务重启时标记中断。详情页 Refresh 能读取新输出和状态；不重放或恢复旧句柄。
- 输出预算仅限制交给模型的文本；默认 16000 字符，显式 token 预算使用 4 字符/token 的估算。交互续接返回新输出，超出预算的原记录仍能通过 `read_tool_output` 按字符有界补读。此估算不同于模型实际 tokenizer。
- `shell` 为绝对可执行路径，默认 `/bin/sh`；`login` 在交互模式默认 true，旧 OneShot 保留默认 false。固定清洁环境和 scratch HOME 仍有效，shell 和配置文件读取使用 Full Access。不同于 Codex 按宿主配置选择默认 shell，Weft 不读取宿主 shell 配置来推导默认值。
- 取消等待原生清理；Agent 结束时释放其所属进程，服务关闭先排空 Agent 后关闭执行后端。无命令内容识别、开发服务器策略或跨应用重启恢复。

已用现有 HTTP → 受控模型 → 实际固定版原生执行器测试 PTY 早返回后使用其他工具、写入、非 PTY 中断、输出预算与持久日志、归属及取消。上游 README 的 `process/write` 例子遗漏 `writeId`，实际 0.162.0 协议要求它；已按协议源文件和真实执行验证接线。

命令环境与 scratch 的区别见 ADR 0004；句柄归属继续保留。上游后端的 `env` 字段不等于上游面向模型的工具允许任意继承 Weft 服务环境，不能为接口对齐泄露服务凭据。

过滤凭据也不要求固定 `/bin/sh` 或禁止选择 login 行为；这些选择应独立核对上游约定及实际执行兼容性，不能以环境隔离为笼统理由取消。

## 其他接入与边界

| 接入 | 应保留的上游能力 | 接线边界 |
| --- | --- | --- |
| MCP Tools | 使用服务发现到的 description、inputSchema 和实际调用参数，不维护手写的 Jira 工具子集；保留结果内容、顺序、structuredContent 和 isError。 | 必要时做可逆工具名映射以区分服务；MCP 与 Responses 字段形状不同，按协议映射，不改参数含义。服务 metadata 与实际结果保留记录；不支持的内容明确报告，不能静默丢失。Resources/Prompts/OAuth 等延期仍按已同意范围。 |
| Playwright CLI | 直接使用上游 CLI 与 skill，包括会话、profile、页面操作、console、网络详情、请求/响应 body、截图、trace、run-code。 | 复用固定 Playwright 1.63.0 安装，仅给 `playwright cli` 完整参数提供可执行别名；官方 skill 与参考资料走现有发现。命令统一使用 ADR 0004 的 Full Access 无沙箱路径；受控网站的实际诊断／截图／会话／关闭记录见[兼容性验证](browser-tools.md)。 |
| 图片工具结果 | OpenRouter `function_call_output.output` 支持字符串或 `input_text`/`input_image`/`input_file` 数组。 | 扩展当前字符串结果约束，按原生多模态格式传输图片并保存实际内容；不伪装成用户消息或 base64 文本。模型不支持时明确报告。 |
| Skills | 上游 SKILL.md 与随附脚本、参考资料按需使用；CLI 参数不重写成自己的操作列表。 | Skill 是指导，不是 function tool；发现、显式选择和来源读取仍按 ADR 0007，不能把 skill 的权限声明当作扩大系统权限的授权。 |

## 实施影响和验证边界

命令能力恢复涉及工具 schema、`server.ts` 校验/分派、执行器进程句柄、取消清理、输出持久化、日志读取、工具结果及 UI。图片结果涉及 `ToolExecution`、模型续接、记录和展示。不能只扩展 schema，却让后续校验拒绝新参数，或让执行器继续忽略它们。

相关已有保护在 `test/command-tools.test.ts`、`test/command-lifecycle.test.ts`、`test/command-shutdown.test.ts`、`test/sub-agents.test.ts` 及命令输出 E2E。#160 新增真实原生测试已验证早返回后继续读写、PTY 输出、中断/取消、Agent 隔离、退出与错误事实以及持久记录；现有归属和关闭清理测试继续保留。

命令侧已运行真实 macOS 原生测试；浏览器、MCP 和付费模型的实际验证不由 #160 证明。数据库按既有不兼容时拒绝启动规则更新 schema，无迁移、自动重置或用户数据删除。

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
