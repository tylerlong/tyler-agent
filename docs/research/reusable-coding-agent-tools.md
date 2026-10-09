# 可复用的 Coding Agent 工具、执行后端与权限体系

研究日期：2026-10-09。本文合并两轮调查，按用户最新明确的选型底线重新评估；覆盖公开源码、发行包接口、许可证和无模型的本机实验。研究对象是可组合的组件，不是寻找另一个完整 Agent 来替代 tyler-agent。

后续针对 Pi + SRT 的网络、完整工具链、依赖和取消深验见 [聚焦验证报告](./pi-sandbox-feasibility.md)：17 项中 16 通过，detached 后台进程取消仍失败。下面按两轮调查的历史证据阅读。

Codex 后续同类深验见 [exec-server 验证与对比](./codex-exec-server-feasibility.md)：27 项中 26 通过，detached 回收同样失败；修正共享 tmp 和元数据默认规则后，当前更推荐它作为统一执行底层。以下保留早期调查结论与证据。

## 结论与选型原则

**可以整体复用文件和命令工具，并统一约束它们的真实文件与网络访问；不必只借一个 Bash executor。** 当前证据最充分的两个候选是：

1. **Pi 工具套件 + 整个 worker 的 sandbox-runtime 隔离**：直接获得 read/write/edit/ls/grep/find/bash，最适合比较“替换整套现有工具”能减少多少代码。两个并发 worker 已完成 28 项联合断言。
2. **Codex exec-server**：独立的文件、进程和权限 RPC，不启动 Codex Agent 或模型循环。每请求读写范围已完成 10 项检查；更适合复用统一执行与权限底层，模型工具 schema 和编辑／搜索体验仍需接线。

OpenHands 独立执行器、整进程沙箱化的 MCP server、Gemini CLI core 工具也是有效候选；不能因现有工具已经实现、参数不同或默认权限不同而直接排除。下面区分已运行的事实、静态源码事实和接入推论。

**唯一不可让出的底线是自己的 Agent 产品、模型通信知情控制和工作流自主权。** 需要知道每一次实际模型 HTTP 请求发了什么、收到了什么、返回多少用量，并能自行安排不同模型的并发主／子 Agent、实现与 review。现有工具、权限模块、UI、HTTP 客户端实现本身均没有保留优先权；第三方实现只要同样满足这条底线，也可以替换对应模块。[项目目标](../../CONTEXT.md)

具体比较标准：

- 比较功能质量、可删掉的代码、接线量和长期维护成本；旧工具名称、分页、编辑匹配及链接语义的差异是需要评估的迁移选择，不是自动否决条件。
- 区分工具的参数检查、用户审批和 OS 隔离。支持 approval 不等于限制任意 shell 子进程的实际 I/O；反之，工具库不自带 approval UI 也不等于不能安全复用。
- 工具内部的模型纠错、输出摘要、安全分类、自动 retry 都必须关闭或经过我们可记录的 transport。只有 turn/step callback 或可设置 provider endpoint，不足以证明每个 HTTP attempt 可见。
- 允许 best efforts；已有跨范围 hardlink 等已接受限制继续如实披露。不给普通读写成功实验赋予“完全安全”的含义。
- 不把安装升级、上下文优化或外部 watcher 纳入本次工作。依赖数量仅用于比较维护与运行成本，不作为单用户场景的自动排除项。

## 候选比较

版本固定为本轮查阅或实验的版本，表格不宣称它们永远是最新版。

| 候选 | 可独立复用的部分 | 文件与命令统一权限的路线 | 实际证据与主要代价 |
| --- | --- | --- | --- |
| Pi 1.1.0，MIT | 七个工具工厂、schema、文件编辑／搜索、Bash 输出与取消 | 整个 Node worker 放进 SRT；文件 API、rg/fd、shell 都继承边界 | 28 项联合断言通过；需 worker/结果映射、网络与取消接入；完整包仍有未使用的 Agent/provider 依赖 |
| Codex CLI 0.162.0，Apache-2.0 | exec-server 的 fs/process RPC、OS 沙箱、每进程网络代理 | 每个 RPC 携带可信的独立 sandbox context | 10 项检查通过；需模型工具接口与编辑／搜索适配；exec-server API 标为实验 |
| OpenHands SDK 1.53.0，MIT | TerminalExecutor、FileEditorExecutor、Action/Observation；独立 REST/TS client | 整个 Python worker 放 OS 沙箱，或容器内工具共用 mount/network | 固定源码核查；未验证组合；Python/RPC 或 Linux 环境成本，完整编辑器不等于现成 TS REST API |
| SWE-ReX 1.4.0，MIT | 纯执行 HTTP/Python runtime、持久 shell、文件 R/W | 整个 worker 沙箱或 Docker runtime | 先前本机／HTTP 8 类检查通过；容器及网络未测，文件编辑算法覆盖少于 OpenHands |
| 官方 filesystem MCP 2026.8.31 + 独立 shell | 工具发现、文件读写编辑、目录／路径搜索／移动 | 整个 server/worker 放 OS 沙箱；按 Agent 固定 Roots | 包与源码核查；无组合实验；内容搜索／删除需同边界命令补齐，不能共用可变全局 Roots |
| Desktop Commander 0.2.52，MIT | 文件、编辑、搜索、进程、输入／输出与 session MCP tools | 整个 MCP server 放 OS 沙箱 | 固定源码核查；目录限制自身不是 OS 沙箱；需收窄配置修改工具、验证后代清理及输出 |
| Gemini CLI core 0.62.0，Apache-2.0 | 公开文件／Shell tools、审批 MessageBus、PolicyEngine、工具级 sandbox | 已有 sandboxed filesystem + shell；必要时定制 policy/backend | 固定源码核查；Config/模型辅助耦合较多，Mac 默认临时范围和布尔网络不直接匹配我们的策略 |
| OpenCode，MIT | TS 工具、权限规则、审批与 Project grants 设计 | 可抽取工具服务并接 OS 沙箱；其普通 host shell 本身没有该边界 | 固定源码核查；Effect／会话上下文适配成本，不能直接用整个 Agent SDK 代替工具库 |
| Goose，Apache-2.0 | Developer 实现、工具审批、MCP transport/container placement | stdio MCP 有容器路径；当前 Developer 是另一条 host Platform 路径 | 固定源码核查；当前没有独立 Developer MCP CLI 入口，抽取 Rust/wrapper 成本较大 |
| Mastra Workspace core 1.75.0，非 EE 部分 Apache-2.0 | 独立 Workspace、filesystem、process/sandbox backend 与工具 | 定制 backend 或整个 worker 再隔离 | 固定源码核查；默认隔离及 Mac read-all、布尔 network 是产品策略，需适配更细权限 |
| Vercel bash-tool 1.3.19 / just-bash 3.6.0，MIT / Apache-2.0 | 独立 bash/read/write tools、模拟 shell 与虚拟 FS | 虚拟 FS／VM 或自定义 Sandbox | 固定源码核查；默认不执行任意宿主 git/pnpm/node，适合受控计算或愿意改变执行环境时 |

许可证仅对应固定来源；复用仍须保留必要许可／NOTICE。filesystem 仓库在 MIT 到 Apache-2.0 迁移中，旧贡献可能保留 MIT，不能笼统称为全 MIT。[filesystem 许可说明](https://github.com/modelcontextprotocol/servers/blob/5abed86c5317b833dd59907492d56c65981642aa/LICENSE)

## Pi：整套工具替换已经有联合运行证据

固定 `@earendil-works/pi-coding-agent@1.1.0`，源码 `abe508e1b89912adde45528136c3221eb69acdd7`。根入口导出 `createReadTool/createWriteTool/createEditTool/createLsTool/createGrepTool/createFindTool/createBashTool`。工厂接受 cwd，提供工具描述、schema、execute、signal 和更新回调，不要求 AgentSession。[公开导出](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/index.ts)、[工具集合](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools/index.ts)

推荐的组合是 **可信父服务决定权限 → SRT 包装启动 Node worker → worker 调用原生 Pi 工具 → 结果回到我们的模型循环**。这是本项目提出并实验的接法，不是宣称 Pi 默认提供这些权限。Pi 官方明确其默认继承进程权限，并提供整环境容器化建议；它的官方 SRT extension 只演示 Bash 包装。[官方隔离说明](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/README.md#L88-L96)、[容器路线](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/containerization.md)、[Bash extension](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/examples/extensions/sandbox/index.ts)

整 worker 隔离具有实际价值：grep 内部直接启动 rg，其 Operations 接口不包含搜索进程执行 hook；逐个替换文件 API 不能自动覆盖这条路径。整 worker 隔离后，Node fs、rg/fd 和 Bash 都受同一 OS 策略约束，不需重写每个工具的路径检查。[grep 实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools/grep.ts)、[Bash 实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools/bash.ts)

### 联合实验

macOS arm64、Node 24.21.0、SRT 0.0.78。临时安装固定包，使用已有 rg 和校验发行 SHA256 的 fd 10.3.0；`PI_OFFLINE=1`，没有启动 Pi Agent/CLI 模型循环。两个不同 scope 的 worker 并发运行，每个 14 项断言：

| 每个 worker 的检查 | 结果 |
| --- | --- |
| read/write/edit/ls/grep/find/bash 在目标内运行（7 项） | 全部成功 |
| 直接范围外 read、链接指向范围外的 read（2 项） | 拒绝 |
| 范围外 write、链接指向范围外的修改、另一个 worker 目标的 write（3 项） | 拒绝 |
| worker 直接 Node fs 读取范围外（1 项） | 拒绝 |
| Bash 写入另一个 worker 目标（1 项） | 非零退出、写入被拒绝 |

两 worker 都退出 0，合计 28 项。父进程另查 outside 原文件未变、所有被拒写入文件不存在。读取策略拒绝 `/Users` 与实验根，再只读放行运行时、工具代码和各自目标；SRT 默认非设备 scratch 写路径被显式拒绝，没有为通过测试开放整个 Home。

第一次初始化遇到 SRT Unix socket 路径过长导致 `listen EINVAL`；改用更短的自有临时路径后运行，未修改断言或放宽策略。因此未来 `/tmp/tyler-agent/<id>` 的代理 socket 名还要验证平台长度。原始结果中的 `network_model_calls:0` 是脚本未主动调用模型的说明字段，**不是抓包或 HTTP 拦截统计**。

移动／删除可先由受限 Bash 的 mv/rm 提供；是否保留结构化工具由使用体验决定。文本和图片结果、工具 schema、错误与流更新需映射到我们的模型协议和数据库，不能只把接口名字换掉就认为接入完成。

### 模型透明性及运行代价

所核查的七个直接 execute 路径执行本地文件、搜索、shell 和格式转换，没有启动模型、自动摘要或模型 retry。根 import 会注册 provider/stream 函数等内存状态，不等于发出模型 HTTP；不创建 AgentSession/ModelRuntime，也不调用 stream/complete/compact。[直接工具源码](https://github.com/earendil-works/pi/tree/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools)、[SDK 顶层](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/sdk.ts)、[provider 注册](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/compat.ts)

缺少 rg/fd 时工具管理器可能下载二进制，应预置并使用 `PI_OFFLINE=1`；`PI_TELEMETRY=0` 可显式关闭其交互模式安装 telemetry。后续深验修正了临时目录接法：SRT 会覆盖 worker TMPDIR，必须在独立 manager 中设置 CLAUDE_CODE_TMPDIR=own Agent tmp，才能让 Pi 长日志落入该范围。[工具管理器](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/utils/tools-manager.ts)、[telemetry](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/telemetry.ts)、[输出日志](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/utils/output-files.ts)

固定包有 23 个直接依赖，本次安装展开为 121 个 package；这不是排除理由，应与能删掉的文件／命令算法一并比较。其模块内文件 mutation queue 不跨 worker，不能宣称已解决多个 Agent 同时编辑同一文件。默认 Bash 没有总超时；应用取消还需要真正传入 worker signal 并验证进程树清理。[mutation queue](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools/file-mutation-queue.ts)

## Codex：独立 exec-server 比 App Server 更符合统一权限需求

固定 CLI 0.162.0，源码 `c1382380de69521303b416720a52f42d51af6248`。下载官方 Mac arm64 release 到临时目录并校验 SHA256；没有更新系统 CLI。`codex exec-server --listen stdio:// --concurrent-requests 4` 在独立 CODEX_HOME、无模型凭据、未登录状态下运行；initialize 后直接调用 fs/process，没有 thread/turn/model。[官方发行](https://github.com/openai/codex/releases/tag/rust-v0.162.0)、[独立执行器 README](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/README.md)

### 每请求权限及实际实验

每个 fs/process RPC 接受 sandbox context。实验使用 managed + restricted filesystem entries：minimal 平台只读运行权限，以及 A 或 B 的字面 Path write 权限，network restricted。write 同时允许 read；普通 Path 与 GlobPattern 分开表示，不需要把目录当 glob。可明确添加 toolchain read、Targets/own tmp write，不必采用 read-all preset。[文件系统 context](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/file-system/src/lib.rs#L180)、[协议](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server-protocol/src/protocol.rs)

| 10 项检查 | 结果 |
| --- | --- |
| 无登录启动／握手 | 成功 |
| A context 读 A、写 A | 成功（2 项） |
| A 读 outside、写 outside；B 读 A | RPC `Operation not permitted`（3 项） |
| A 内 symlink 指向 outside，跟随读取 | 拒绝 |
| A process 读 outside | exit 1，sandboxDenied true |
| A process 写 A | exit 0，sandboxDenied false |
| B process 写 A | exit 1，sandboxDenied true |

三个 process 同时派发，输出与退出按各自 processId 归属；fs context 切换顺序检查。拒绝写入的文件确实不存在。sandboxType 返回 macosSeatbelt。已验证 sh/cat，未验证完整 Node/pnpm/git 编译工具链，也未测含特殊字符的目录名。

fs RPC 覆盖整文件／分块读写、目录创建／枚举／有界遍历、元数据、真实路径、删除和复制；process RPC 覆盖启动、输入输出和终止。它没有独立文本搜索、rename、replace-edit/apply-patch RPC，可用同一受限 process 执行 rg/mv/patch，或另选现成编辑工具层。模型工具定义、结果适配、总超时与输出预算仍属接入工作。[fs handler](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/server/file_system_handler.rs)、[process handler](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/server/process_handler.rs)

### 域名权限是独立的每进程配置，尚未动态验收

process/start 的 networkProxy 接受本次 domains 与代理配置，实际实现会创建独立代理 state、监听、子进程 proxy env 和 managed sandbox context；这比修改全局命名 profile 更贴合并发 Agent。`mode:full` 表示允许 HTTP 方法与 CONNECT，不代表忽略域名规则；全域名还要通过域名 wildcard 表达。[代理配置](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/network-proxy/src/remote_config.rs)、[domains/mode](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/network-proxy/src/config.rs)、[真正的启动路径](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/process_sandbox.rs)

只有设置 policyDecisionTimeoutMs 时 LocalProcess 才安装 network/policyRequest 回调。可以不启用执行中自动询问，只用已批准的固定策略，并收集 network/policyDecision 的 host/port/protocol/decision/reason，再由远程模型决定新的权限申请。这是静态源码结论；未知域名失败的实际返回、wildcard、代理并发和直连拒绝均未动态验证。[回调与事件](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/local_process.rs#L310)、[事件类型](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server-protocol/src/network_policy.rs)

文件 unrestricted 与网络 restricted/enabled 可分别表达，不必一起关闭隔离；混合模式未运行验收。0.162.0 虽是稳定 CLI release，exec-server 子命令仍标 EXPERIMENTAL，没有承诺兼容的独立 TS tools SDK，应固定协议版本。

普通 fs/process 请求没有模型或 prompt 参数，也不运行 Codex 模型循环。CLI 仍可能加载 OTEL/config，因此应使用应用自有 CODEX_HOME、本地 stdio、过滤环境、analytics false、trace/exporter none，不继承用户日常配置。这次没有全网抓包，不能由无登录推出“零其它 HTTP”。[CLI 入口](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/exec_server_command.rs)、[默认 analytics](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/exec_server_telemetry.rs)、[OTEL 初始化](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core/src/otel_init.rs)

**修正第一轮结论**：App Server 的 fs 接口不带 sandbox，不能原样当作受限文件工具；这个入口的限制不能推广成 Codex 底层没有能力。第一轮 0.150.1 的 8 项检查及越界发现保留，但本轮 exec-server 已提供更直接、实际验证的统一上下文入口。

## OpenHands / SWE-ReX：工具与执行环境都可独立复用

OpenHands 1.53.0 的 TerminalExecutor 和 FileEditorExecutor 公开导出，conversation 可为 None；独立执行不需 Agent/Conversation 模型循环。FileEditor 覆盖 view/create/str_replace/insert/undo，Terminal 提供持久终端。Action/Observation 的 to_llm_content 是格式转换，不是调用模型。[Terminal](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-tools/openhands/tools/terminal/impl.py)、[FileEditor](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-tools/openhands/tools/file_editor/impl.py)、[ToolDefinition](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-sdk/openhands/sdk/tool/tool.py)

两条可行路线：

- **每 Agent 一个 Python stdio worker，整体放入 SRT**。薄 RPC 接公开执行器，复用文件编辑和终端逻辑。应显式选 terminal_type=subprocess，避免默认 tmux 路径接到沙箱外既有 daemon。这是可行性推论，未做 OpenHands + SRT 联合实验。
- **容器内工具共用 mount/network 边界**。DockerWorkspace.volumes 支持多个 ro/rw mount；没有挂载的宿主目录不会因使用文件 API 而可见。容器自己的 root filesystem 通常仍可写；network 字段只选择 Docker 网络，不实现逐域名 allowlist。域名限制另配受限代理／网络，不能只设置 HTTP_PROXY 就当作阻止直连。[DockerWorkspace](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-workspace/openhands/workspace/docker/workspace.py)、[Docker mount](https://docs.docker.com/engine/storage/bind-mounts/)、[Docker network](https://docs.docker.com/engine/network/drivers/bridge/)

官方 TS BashClient/FileClient 可独立连接执行 REST；文件上传／下载不是完整 FileEditor 的 str_replace/undo 远程 API，RemoteConversation.execute_tool 仍 NotImplemented。因此最大复用完整编辑器需要薄 RPC。宿主上传 convenience 方法和宿主目录选择 API 不能直接暴露为模型读取入口，否则可能在容器外读取 source；这是接入边界，不是容器文件工具绕过了 mount。[BashClient](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/clients/typescript/src/client/bash-client.ts)、[FileClient](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/clients/typescript/src/client/file-client.ts)、[RemoteConversation](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-sdk/openhands/sdk/conversation/impl/remote_conversation.py)

SWE-ReX 1.4.0 是更小的独立执行框架。DockerDeployment 可用 docker_args 指定 mount、network、user/read-only 等；runtime/server 的文件和命令都在容器内。发布版本机 execute 使用同步 subprocess.run 收集完整输出，session 另有 pexpect interrupt；需要评估输出、取消与进程树生命周期。第一轮本机／随机 localhost HTTP 的 8 类检查通过，不证明容器或域名边界已验收。[runtime](https://github.com/SWE-agent/SWE-ReX/blob/v1.4.0/src/swerex/runtime/local.py)、[server](https://github.com/SWE-agent/SWE-ReX/blob/v1.4.0/src/swerex/server.py)、[Docker deployment](https://github.com/SWE-agent/SWE-ReX/blob/v1.4.0/src/swerex/deployment/docker.py)

选独立 OpenHands 执行器无需 LLM security analyzer、condenser、delegate/task 或其他模型辅助组件。薄 worker 不传模型 key、不构造 LLM/Agent/Conversation；如需这些辅助能力，另接我们的可观察模型调用。Agent Server telemetry 可用 DO_NOT_TRACK=1、exporter none 明确关闭；尚未抓包验证整个 import/依赖的网络副作用。[LLM analyzer](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-sdk/openhands/sdk/security/llm_analyzer.py)、[telemetry policy](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-agent-server/openhands/agent_server/telemetry/policy.py)

## Gemini CLI core：真实工具级沙箱与审批，但要拆开默认策略

固定 `@google/gemini-cli-core@0.62.0`，源码 `b460678f3db508407554afd604cc9d6635becb2a`。公开导出文件／Shell 工具、PolicyEngine、MessageBus、Scheduler/ToolExecutor 与 SandboxManager 接口。工具构造依赖 Config/MessageBus，比 Pi 的独立工厂更重，但不是只能运行完整 CLI。[公开入口](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/index.ts)

它的工具级沙箱有真实执行路径：sandboxed filesystem 的 readTextFile/writeTextFile 经 SandboxManager 包装 cat/sh，Shell 使用相同 manager；不是只靠类名或 cwd。Mac 使用 Seatbelt，Linux 使用 bubblewrap，配置也可禁用。其他元数据／发现路径不一定经过上述两个方法，不能只据此断言所有文件访问都已统一隔离。[SandboxedFileSystemService](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/services/sandboxedFileSystemService.ts)、[manager factory](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/services/sandboxManagerFactory.ts)

与我们已定策略的差异：

- Mac profile 允许广泛系统／运行路径读取，whole /tmp、/private/tmp 等写入；工作区和批准路径再加入。SandboxPermissions.network 为布尔值，没有本次域名列表。普通路径可按 literal/subpath 表达，但权限策略需要适配 own tmp 和 domains。[Mac profile](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/sandbox/macos/baseProfile.ts)、[SandboxPermissions](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/services/sandboxManager.ts)
- MessageBus/PolicyEngine 有确认和可信 subagent 身份处理；SandboxPolicyManager 的 session/persistent grants 按命令和用户 policy 文件存储，不直接等同于我们的 Project 路径／域名授权。[MessageBus](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/confirmation-bus/message-bus.ts)、[SandboxPolicyManager](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/policy/sandboxPolicyManager.ts)
- 默认 Scheduler 遇到 SANDBOX_EXPANSION_REQUIRED 会改 additional_permissions、等待审批并再次执行同一次调用。我们已决定远程模型主导新的申请／重试，所以不能直接采用该自动重放流程；可复用较低层的执行能力。[Scheduler 扩权／重放](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/scheduler/scheduler.ts#L835)

确有可选模型辅助：edit 失败可走 LLM correction，shell 可 summarize 输出，ToolExecutor 可 distill 大输出。0.62.0 的 disableLLMCorrection 默认 true，不能说默认 edit 必然暗中请求模型；但 write-file 即使禁 correction，非 JSON 路径仍求值 Config.getBaseLlmClient，未初始化鉴权时会耦合到 runtime。独立工具接入需要实测／适配这些 Config 路径，不能只因类是 public 就宣布纯工具已开箱可用。[Edit](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/tools/edit.ts#L745)、[Write](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/tools/write-file.ts#L200)、[Shell](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/tools/shell.ts)、[distillation](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/scheduler/tool-executor.ts#L207)、[Config](https://github.com/google-gemini/gemini-cli/blob/b460678f3db508407554afd604cc9d6635becb2a/packages/core/src/config/config.ts)

本轮只读源码，没有安装 Gemini 包或运行其工具、模型、沙箱。它是权限架构和工具实现的有效候选；暂排在已有直接组合实测的 Pi/Codex 后面，原因是接线证据与策略匹配，不是实现归属。

## 其他项目也需要权限，但选择了不同信任边界

**OpenCode** 的 allow/ask/deny、once/always/reject 为纯规则审批；普通 Shell 先 tree-sitter 扫描已知命令／路径，随后直接 spawn host process，没有在该路径建立 OS 文件／域名限制。Python/Node 程序真实 I/O 不能靠扫描保证。这个实现适合其产品信任模型，不能把它的 external_directory approval 误认成我们的 OS 访问范围。[权限规则](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/packages/opencode/src/permission/index.ts)、[Shell](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/packages/opencode/src/tool/shell.ts)

OpenCode 同一固定 HEAD 的 V1 always 授权是实例内存；新 V2 从 Project DB 读写 saved grants，不能混称现有所有 UI 已使用 Project 持久授权。它的 child Agent 可指定模型，否则继承父当前模型，所以“其他项目不能多模型 subagent”不成立。[V2 Project grants](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/packages/core/src/permission.ts)、[Task/model](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/packages/opencode/src/tool/task.ts)

**Goose** 的 Approve 可以纯规则询问；SmartApprove 未决判断会调用模型 classifier，该函数忽略返回 usage，不能把主模型记录当全部 token 账本。可不使用 Smart；adversary 也可关闭。活跃持久权限按全局工具名保存，不直接等于 Project 路径／域名 grants。[PermissionInspector](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/permission/permission_inspector.rs)、[classifier](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/permission/permission_judge.rs)、[PermissionManager](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/config/permission.rs)

Goose 的 stdio MCP provider 有 docker exec 路径；当前 Developer 已是 host Platform extension，先走 client_factory，跳过 container 分支。当前 goose mcp CLI 没有 Developer 入口，不能直接声称可调用独立 Developer MCP 二进制。可以抽取／wrapper，只是接线成本较高。Goose task/recipe 也可选 provider/model，核查的 foreground child 默认 Auto；复用工具不必继承这个调度和权限默认。[stdio Docker](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/agents/extension_manager/stdio.rs)、[Platform 分支](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/agents/extension_manager/mod.rs#L833)、[CLI](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose-cli/src/cli.rs#L1614)、[child/provider/model](https://github.com/aaif-goose/goose/blob/903743ee066bc4d38892f6d617e18015805b0f9f/crates/goose/src/agents/platform_extensions/summon.rs)

**实践归纳**：审批约束是否启动某项动作，OS sandbox 约束动作实际能做什么，容器／VM 约束执行环境能看见什么。常见产品默认 read-all/workspace-write、按工具审批或整容器边界，都是选择，不代表不存在更严格的底层能力。我们的需求并非没人做过；Project 授权 UI 和模型主导申请属于产品策略，应与可借用的执行机制分开。

## MCP 与其他独立工具的复用边界

MCP listTools/callTool 不要求模型，可接任意模型循环。可整套换用 filesystem 或 Desktop Commander，同时把整个 server 放进 OS sandbox；不是只给 shell 加沙箱而让文件 API 留在宿主。官方 filesystem 的 allowedDirectories 是 server 全局状态，Roots 更新改变整个实例，空或全部无效 Roots 保留旧范围；每 Agent 固定范围实例可行，不能用共用实例反复切 Roots 或空 Roots 撤权。[工具协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[filesystem 工具](https://github.com/modelcontextprotocol/servers/blob/a40bc270fb5ece62673f8a1196f57116d885c5eb/src/filesystem/index.ts)、[Roots 更新](https://github.com/modelcontextprotocol/servers/blob/a40bc270fb5ece62673f8a1196f57116d885c5eb/src/filesystem/index.ts#L724-L751)

客户端不提供 sampling，避免 server 获得隐式模型调用通道；未来若要提供，应经自己的 Model Call transport。server 自己也可能联网，所以 protocol/model-agnostic 不等于无网络副作用。Desktop Commander 自己的 allowedDirectories/黑名单不是 OS 沙箱，timeout_ms 是初次等待窗口而不是强制结束；配置修改工具需从模型暴露列表中移除。[sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、[Desktop Commander security](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/ea3ed35a7be9f2a3ea3e89185ff9bbb03fe5ab57/SECURITY.md)、[终端生命周期](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/ea3ed35a7be9f2a3ea3e89185ff9bbb03fe5ab57/src/terminal-manager.ts)

Mastra 独立 Workspace 和 process backend 提供流输出、timeout/abort、后台进程等，仍值得比较；其默认 isolation:none、Mac read-all 和布尔网络要更换或包在外层边界里。[Workspace 导出](https://github.com/mastra-ai/mastra/blob/b10b70fd775598c52d35b4417a0dc3449aea0723/packages/core/src/workspace/index.ts)、[LocalSandbox](https://github.com/mastra-ai/mastra/blob/b10b70fd775598c52d35b4417a0dc3449aea0723/packages/core/src/workspace/sandbox/local-sandbox.ts)、[Mac policy](https://github.com/mastra-ai/mastra/blob/b10b70fd775598c52d35b4417a0dc3449aea0723/packages/core/src/workspace/sandbox/native-sandbox/seatbelt.ts)

Vercel bash-tool/just-bash 提供独立工具而不必采用 ToolLoopAgent；默认是模拟 shell/虚拟 FS，改变为宿主 backend 后仍要自己接进程生命周期和 OS policy。它是执行环境选择不同的候选，不是现有文件工具值得保留的证据。[bash-tool](https://github.com/vercel-labs/bash-tool/blob/70ba5ad4d01be465e76acb5b6bd0c6221a2af1b9/src/tool.ts)、[Sandbox 接口](https://github.com/vercel-labs/bash-tool/blob/70ba5ad4d01be465e76acb5b6bd0c6221a2af1b9/src/types.ts)、[just-bash](https://github.com/vercel-labs/just-bash/blob/58d1ecf31b768ea9834e151b166cf4cea32046ba/packages/just-bash/README.md)

Claude Agent SDK 的公开调用运行 Claude Code 模型循环，没有受支持的独立内置 Bash/Read/Edit 工具入口，TS SDK LICENSE 受 Commercial Terms 且保留所有权利；不能把它当 MIT/Apache 工具包拆用。独立开源 SRT 按自己的许可判断。[SDK 定位](https://code.claude.com/docs/en/agent-sdk/overview)、[TS SDK 许可](https://github.com/anthropics/claude-agent-sdk-typescript/blob/da321bbe62ed45d10a1ff0e77a948253d9eee3e0/LICENSE.md)、[SRT](https://github.com/anthropics/sandbox-runtime)

## 接入现有 Agent/Sub-agent 的边界

当前 `src/openrouter.ts` 注册文件和 create/cancel subagent schemas，并接收 ToolExecutor；`src/server.ts` 的 runAgent 已有可信 agentId、Chat/Project 关系、Tool Call 记录及 AbortController。这里是执行后端接点，不必为了第三方工具更换整套 Agent。[模型循环](../../src/openrouter.ts)、[可信执行闭包](../../src/server.ts)、[当前文件实现](../../src/file-tools.ts)

接入关系应为：

```text
我们控制的模型 HTTP → 模型工具参数 → 记录 Tool Call、确定所属 Agent
  → 读取 Project grants + Chat 模式 + 本次批准
  → 创建本次不可变权限快照 → 第三方工具／executor
  → 保存真实结果与事件 → 回到我们控制的模型循环
```

这是接入推论，不是已经完成的代码。必要工作包括：

1. 将 tools schema 注册与 executor 接入统一后端；接受选中的新工具契约和结果类型，不要求旧七工具名字不变。
2. 在可信 runAgent 闭包／context 绑定身份、roots、own tmp 与授权。模型只能提交业务参数、额外权限和理由，不能直接给 executor 自由传 sandbox policy、Agent/Project ID 或未授权 mount。
3. 本地生成、绑定 process/session IDs；取消仅操作所属 Agent 的进程／后代。共享 RPC 连接不代表共享权限，整 worker 模式也不能共用全局可变 cwd/grants。
4. 将 AbortSignal、流事件、超时、输出预算和最终结果接回现有记录。MCP abort 或前端显示 cancelled 不足以证明 OS 后代已清理。
5. 不把模型 API key 交给工具 worker；显式关闭／接管 telemetry、自动下载、模型辅助和 SDK retry。工具批准联网与库自行调用模型／telemetry 分开记录。

工具后端不需要知道主／子模型叫什么。我们可以分别为实现 Agent 和 review Agent 发自己的模型请求，并让它们并发调用独立工具上下文。OpenCode/Goose 自己也支持模型覆盖，选择依据是我们对 workflow 和 HTTP 的掌控，不是它们没有这项功能。

**审批继续遵守已定方案**：模型在命令参数中明确申请；本地校验并让用户选拒绝／本次／项目持续允许；执行拒绝只返回事实。没有本地自动扩权、申请、重放或任务恢复。Project Edit 管 grants，Chat 文件／网络模式分别选择，全局值仅初始化新 Chat；运行中保持启动策略，改动用于之后的调用。[ADR 0004](../adr/0004-command-tool-isolation-boundary.md)

whole-worker 的 OS policy 在启动后不变。永久授权变更可在下次启动／重启 worker 应用，本次扩权可用短生命周期 worker；持久 shell 状态的保留是要比较的成本。SRT 网络代理具有进程级 singleton，不能在服务进程中靠改全局配置隔离并发 Chat，应使用独立受控 manager/worker 生命周期。Codex 原生每请求 context 则无需改共享全局权限。这些策略均需网络组合实验验证。

系统／工具链只读例外会对该统一 OS 边界内的文件工具也生效，可能比现有结构化文件工具的目标范围更广。若选择这种契约，应明确更新规格；若必须更窄，可保留工具层检查或使用不同 policy。现有 ADR 不是禁止替换的理由，也不能在未讨论时默默改变权限语义。

同一项目多个 Agent 编辑同一文件仍可能竞争。隔离访问范围不等于版本隔离或跨 Agent 文件锁；不为未遇到的问题先建复杂协调层。

## 证据强度、剩余实验与建议

| 已完成的运行检查 | 证明了什么 | 没有证明什么 |
| --- | --- | --- |
| SRT 0.0.78 原始 32 项，29 符合、3 失败 | 动态根、进程后代、链接、基本 Git/离线 pnpm；暴露 glob 与 hardlink 边界 | 逐域名、生产审批、完整工具链及绝对安全 |
| Pi 1.1.0 首轮 10 类接口检查 | 独立 factory、Bash 参数／输出／取消／超时接线可运行 | 整个应用的 IPC 取消与全部后代清理 |
| Pi + SRT 第二轮 28 项 | 两 scope 并发，全七工具及实际文件／命令边界 | 网络 scope、审批撤销、长输出和生产接入 |
| Codex App Server 0.150.1 首轮 8 项 | 独立命令可运行；发现该入口 fs 与启动 cwd 边界 | 不能代表 exec-server 权限能力 |
| Codex exec-server 0.162.0 第二轮 10 项 | 每请求 fs/process 读写上下文及越界链接拒绝 | 域名代理、特殊目录名、完整构建工具链 |
| SWE-ReX 1.4.0 首轮 8 类 | 独立 Python/HTTP、文件、输出、session/timeout | Docker/OS sandbox、域名及生产取消 |
| 其他候选 | 固定源码、公开接口／执行路径与许可 | 未动态执行，不计为通过的隔离实验 |

SRT 原始失败未被改写为成功；可复现脚本及原始 32 项结果仍在仓库。[原始研究](./command-execution-security.md)、[脚本](./sandbox-runtime-probe.mjs)、[结果](./sandbox-runtime-probe-results.json)。本轮新 smoke 结果以本文逐项表格归档；临时依赖、二进制和 fixtures 已清理，没有改应用依赖、用户配置或运行真实模型。

**建议优先比较 Pi 整套工具 + SRT 与 Codex exec-server 两条路线。** 前者已经替我们实现了面向模型的文件／命令工具，最有机会删掉现有重合算法；后者每请求权限原生可传且已有统一 fs/process，最有机会少写权限／执行底层。两者不是因为工具数量或品牌优先，而是已有联合证据和接线范围最清楚。不先引入所有候选，不预先决定保留自己的文件工具。

下一轮最小免费实验应比较：相同 Target/own tmp/extra-path 与 read-deny 策略；域名 deny/allow/wildcard 及不同 Agent 并发；批准后新调用与未批准失败；真实 Node/pnpm/git；取消、长输出和后代清理。用受控模型 transport/HTTP spy 验证工具执行、失败和辅助流程没有绕开记录，并区分模型、批准的工具网络与 telemetry。最后比较实际能删除的代码和剩余 glue，而不是仅比较下载包大小。

尚未实现 tyler-agent 后端适配，尚未决定采用某个工具契约，也未修改已有工具 ADR。网络、审批 UI／存储、权限撤销及应用级取消仍未联合验收；Codex 实验接口稳定性、SRT 已知 glob/hardlink 限制是当前主要边界。
