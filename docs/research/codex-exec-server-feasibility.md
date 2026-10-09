# Codex exec-server 深度验证与 Pi + sandbox-runtime 对比

日期：2026-10-09。固定 Codex CLI **0.162.0**，官方源码 `c1382380de69521303b416720a52f42d51af6248`；macOS arm64、Node 24.21.0、pnpm 11.22.0。使用独立临时 CODEX_HOME、过滤环境、自有 sentinel 和下载二进制，未登录、调用真实模型、更新系统 Codex 或修改应用依赖。

## 判断

**可行；在我们已经接受的首版 best efforts 范围内，没有发现必须放弃的 deal breaker。两条路线中，更推荐 Codex exec-server 作为统一文件／命令执行底层。** 它可直接给每次文件请求和命令启动传入独立权限快照，同一个常驻服务支持并发 Agent；无需接管我们的模型 HTTP、root/sub-agent 或远程 AI 的决策。Pi 更省面向模型的工具定义和输出整理；Codex 更省独立 manager/worker 的权限接线。[独立执行器](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/README.md)、[执行路径](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/process_sandbox.rs)

不能原样套用默认权限：`:minimal` 给命令隐式开放共享 tmp，而宽 Target write 默认保护 `.git/.agents/.codex/.aws`。本轮发现并通过正式配置修正了这两点，未 fork 上游或删失败断言。主要剩余成本是 **实验性协议、较大的原生二进制，以及模型 tool/result 适配**，不是要求使用 OpenAI 模型。

## 实际实验结果

本轮最终 **27 项检查，26 通过、1 失败**。失败仍是主动新建 session/process group 的 detached 后台进程在 terminate 后存活；和 Pi 一样，它继承沙箱，属于回收限制。当前项目尚无命令工具，现有取消承诺指 Agent/Sub-agent 树；任意 OS daemon 必须回收尚未定为发布门槛。实验 finally 主动停止了自有残留 daemon，不把清理计为上游能力。[进程组清理](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/utils/pty/src/process_group.rs)

| 检查 | 最终事实 |
| --- | --- |
| 无账号 initialize，直接 fs/process RPC | 成功，没有 thread/turn/model |
| 同一服务并发 A/B 文件权限与不同域名列表 | 各用本次范围，没有串用 |
| `[*?]`、Unicode 等字面 Target Folder | 文件与命令均成功，不把普通路径当 glob |
| 范围外 symlink、文件读取／写入、另一 Agent tmp | 拒绝；own tmp 可读写 |
| 本次 extra Target、下一次撤销 | 新请求拒绝，已启动进程保留旧快照 |
| 未批准 HTTPS | 拒绝，有 `network/policyDecision` 的 host/reason，未触发审批 callback |
| 获批域名、`*.npmjs.org` | HTTPS 成功 |
| 全域名 `*` + 文件 restricted | 两个公开域名成功，范围外文件仍拒绝 |
| 文件 full + 网络 restricted | outside fixture 可写，未批准网络拒绝 |
| 删除 proxy 环境变量尝试直连 | 拒绝，不能绕开 OS 网络边界 |
| 8 MiB 单行输出 | 通知完整流出，字节数／SHA256 准确；replay 有界 |
| pipe stdin、PTY 输入 | 均成功 |
| terminate 普通后代、兄弟继续运行、客户端 timeout、stdio EOF | 均成功 |
| 主动 detached daemon 的 terminate | **失败：进程仍存活** |
| pnpm 在线安装 is-number 7，再 Node assert／artifact | 成功，真实下载依赖并验证 |
| Git init/add/commit/修改后的 diff | 成功 |
| rg 搜索；内置 apply_patch 添加／编辑／移动／删除 | 成功 |
| apply_patch 编辑 outside 绝对路径或跟随 outside 链接 | 拒绝，outside 原文保留 |

[首次结果](./codex-exec-server-initial-results.json)保留配置不正确时的失败；[最终结果](./codex-exec-server-probe-results.json)保留 detached 失败。[复现脚本](./codex-exec-server-probe.mjs)因此正常预期退出 1。测试使用自有 fixture，不读取真实私人文件，不执行真实模型请求；这不是生产安全认证。

## 三处必须正确配置的边界

**共享 tmp 的默认权限必须收窄。** Codex 的 macOS `:minimal` 在 Process profile 下另外添加 `/private/tmp`、`/private/var/tmp` 读写；fs helper 不加这个默认，所以最初文件 RPC 拒绝 outside，而普通命令可以读写 tmp 中的 outside。这与 network full 无关。正式修复是在这两根设置 `access:"deny"`，再给更具体的 Targets/own tmp 设置 write；最终普通命令和网络代理命令均通过拒读／拒写检查。[触发条件](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/sandboxing/src/seatbelt.rs#L903)、[scratch lowerer](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/sandboxing/src/seatbelt_scratch.rs)

**Target 的元数据目录不能悄悄变成只读。** 宽 write 默认不允许修改 `.git/.agents/.codex/.aws`，即使目录还不存在。本轮 Git init 因此失败。按我们的“Target 整目录可读写”语义，显式加入各 Target 的这四个子路径 write；Git init/add/commit/diff 随后通过。这是上游支持的具体权限覆盖，不需要 fork。工作树／子模块的真实 gitdir 在 Target 外时仍需把实际目录列入批准范围，不能由本次普通仓库成功推出所有 Git 布局免配置。[元数据判定](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/protocol/src/permissions.rs#L1063)、[Seatbelt 判定](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/sandboxing/src/seatbelt.rs#L610)

**最小平台许可不等于完整开发工具链。** 本机 Node 启动还需 `/System/Library/OpenSSL` 只读；`/usr/bin/git` 是开发工具发现入口，本轮改用已安装 CommandLineTools 的真实 git，并只读放行该工具链、设置相应 DEVELOPER_DIR。pnpm 用已安装的程序目录只读和 Node 直接调用，避免 Corepack shim 读取范围外父 manifest。没有安装 Xcode、请求 sudo 或开放整个 Home。Pi + SRT 的真实 pnpm 实验也需要明确工具链入口。[平台默认读范围](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl)、[Pi 实验](./pi-sandbox-feasibility.md)

`:minimal` 的只读基线仍包括系统库、配置和 Process 的 `/Applications`，不能描述成“只有 Target 可读”。本轮核对未发现任意 Home 的默认读写 grant；可能越过文件读取范围的 Preferences IPC 只在 full-disk-read 时启用。这是源码边界核对，不是所有系统 IPC 的安全审计。[profile 拼装](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/sandboxing/src/seatbelt.rs#L1047)

## 与自己的 Agent、HTTP 和审批的关系

入口是本地 `codex exec-server --listen stdio:// --concurrent-requests 8`，initialize/initialized 后直接执行 fs/process。普通 RPC 不包含 prompt/model/assistant turn；它启动的是 OS 进程或受限文件 helper，不创建 Codex Agent loop。[路由](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/server/registry.rs)、[进程 schema](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server-protocol/src/protocol.rs#L329)

可信适配层只需把我们已确定的 Agent/Project/Chat 与本次批准转换成 sandbox/network 快照；模型提交 command/cwd/业务参数和申请理由，不能自由提交权限字段或其他 Agent 的 processId。**省略 sandbox 本来允许无沙箱执行**，因此不能把原始 RPC 当模型工具直接暴露。processId/句柄由本地生成并绑定所属 Tool Call；不同模型主／子 Agent 共用服务不改变 HTTP 所有权。[缺省 sandbox 路径](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/process_sandbox.rs#L138)

每次 process/start 的 networkProxy 创建独立策略 state 和 OS 代理边界；`domains:{"*":"allow"}` 原生支持全域名。`mode:"full"` 是 HTTP 方法／CONNECT 模式，不能代替域名规则，也不意味着任意协议、Unix socket 或监听权限。省略 policyDecisionTimeoutMs 不安装权限请求 callback，仅返回允许／拒绝事实；由远程 AI 决定是否发起新调用申请权限，无须本地推断、自动扩权或自动重放。[网络启动](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/process_sandbox.rs#L347)、[wildcard](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/network-proxy/src/policy.rs#L208)、[callback 条件](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/local_process.rs#L297)

本地 CLI 仍会加载 config 并初始化 OTEL。本轮使用自有 CODEX_HOME、中性启动 cwd、过滤环境，显式 analytics.enabled=false、otel exporter/trace_exporter 为 none；metrics 由 analytics=false 的代码分支关闭，生产配置可另外显式写 metrics_exporter=none。不使用 remote registration、不继承模型 keys 或日常 Codex `.env`。本轮未全网抓包，因此 **“fs/process 不调用模型”有源码和无登录实测支持；“绝无其它 HTTP”没有动态测量证明**。获批 curl/pnpm 的工具网络与我们自己的模型 HTTP 分开。[CLI 配置](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/exec_server_command.rs#L281)、[遥测默认](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/exec_server_telemetry.rs#L6)、[exporter 条件](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core/src/otel_init.rs#L68)

## 工具接线和协议成本

文件 RPC 提供读写／流式句柄、目录、元数据、真实路径、walk、复制和删除；进程提供 start/read/write/signal/terminate、PTY 和异步输出。没有独立文本搜索、rename 或 patch RPC，但**官方同一个 binary 自带 apply_patch**：通过受限 process 调用 `--codex-run-as-apply-patch`，不必自己写编辑算法；搜索可运行 rg，移动也可由 patch 或 mv 完成。模型工具说明、schema、UTF-8/base64/图片等结果适配仍归我们。[RPC 列表](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server-protocol/src/protocol.rs#L35)、[patch invocation contract](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/apply-patch/src/lib.rs#L46)、[实际 dispatch](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/arg0/src/lib.rs#L119)

process/start **没有总 timeout 字段**；本轮客户端 timer 调 terminate 验证通过。服务每进程 replay 保留最多 1 MiB/50,000 chunks，退出后保留 30 秒；process/read.maxBytes 是一次读预算，不能代替完整日志归档或给模型的输出上限。适配层需持续接收通知、按自己的预算截断／存储，不能等命令结束只读 replay 然后声称日志完整。普通进程组取消和 detached 限制与 Pi 相近。[生命周期与缓存](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server/src/local_process.rs#L85)

CLI 是正式 release，但 exec-server help 仍明确 **EXPERIMENTAL**。固定 binary/protocol，升级时跑权限契约检查；不能依赖稳定 TS SDK 的兼容承诺。实验 initialize 的 executorVersion 返回 `0.0.0`，所以版本固定依靠已校验 release SHA/binary 及 CLI --version，不能仅信这个 metadata 字段。源码 Apache-2.0，可复用且无登录／OpenAI 模型义务。[实验标记](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/exec_server_command.rs#L31)、[metadata fallback](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/exec-server-protocol/src/protocol.rs#L143)、[许可证](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/LICENSE)

## 依赖代价：包数量少，字节数并不小

官方 macOS arm64 tar SHA256 与 release digest 一致：`98e9413a1bd167ae573723939ff178e6d44f1bb21d5cda960dbeb2fa65f49104`；解压 codex SHA256 `8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57`。npm 所含 codex 与此完全相同。仅调用原生 binary 可 **0 新 npm 包 + 1 原生运行资产**；不需 Rust 编译器、Node addon 编译或安装 SRT。macOS sandbox-exec 为已有系统工具；搜索需现有 rg 或提供 rg。[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.162.0)

| 口径 | Codex 实测 |
| --- | ---: |
| 裸 codex binary | **235.09 MiB**；246,508,160 bytes |
| 官方 binary tar 下载 | 93.55 MiB；98,089,521 bytes |
| npm 直接新增 | **1 项**：`@openai/codex@0.162.0` |
| 根包声明普通 JS dependencies／安装 scripts | **0／0** |
| 根包 optional 平台包 | 6 个平台 aliases |
| 本机实际 npm 安装 | **2 个 package 目录**：wrapper + macOS arm64 平台包 |
| 全平台 npm lock／当前项目 pnpm-lock 副本净增 | **7 个位置／7 个版本条目**；原版本无变动 |
| npm node_modules | **331.17 MiB** 磁盘占用；322.39 MiB 文件内容 |

npm 平台包除 codex 还带 code-mode-host、voice 资源及 rg；不是 exec-server 运行必需，却会随正常包安装。裸 binary 的 otool -L 仅链接 Apple `/System/Library` 和 `/usr/lib`，没有需要另外安装的第三方动态库。Rust 源码编译图在 binary 内，不应当作数百个需要 Node 项目安装的运行包。[npm manifest](https://registry.npmjs.org/@openai/codex/0.162.0)、[平台 manifest](https://registry.npmjs.org/@openai/codex/0.162.0-darwin-arm64)、[依赖测量](./codex-exec-server-dependencies.json)

## 公平比较和建议

| 我们关心的事项 | Codex exec-server | Pi 工具套件 + SRT |
| --- | --- | --- |
| 自己的模型 HTTP／并发不同模型／Agent loop | 保留；本轮无模型账号即可执行 | 保留；前轮工具 HTTP spy 路径尝试为 0 |
| 动态范围与并发权限 | 同一服务每请求传快照，原生支持 | 每权限快照独立 manager/worker，避免 SRT singleton 串用 |
| 文件／命令共同受限 | fs context + process OS sandbox；须修 tmp 缺省 | 整个 Pi worker 必须在 SRT 内，不能仅 wrap Bash |
| 模型工具 UX | 需定义 schema/result；内置 patch 可复用 | 七工具工厂已有定义、文本编辑／搜索／输出截断 |
| 交互进程 | PTY、stdin、长生命周期 handle 原生支持且已测 | 默认 Bash 非交互；额外会话能力另做 |
| 普通目录特殊字符 | 字面 Path 可用，已测 | SRT glob 限制，按已接受策略拒绝不支持的名字 |
| 普通取消／主动 detached | 普通通过／detached 残留 | 普通通过／detached 残留 |
| npm 本机安装／项目 lock 新增 | **2 个／7 个版本条目** | **126 个／143 个版本条目** |
| 独立安装占用 | 裸 binary 235 MiB；npm 331 MiB | 约 175 MiB；还需 rg/fd |
| 主要采用成本 | 实验 RPC + 原生资产 + tool/output glue | 整包 provider/TUI 依赖 + 多进程权限接线 |

Pi/SRT 数字来自[同机前轮固定版本验证](./pi-sandbox-feasibility.md)，不是只比较 package.json 行数；两者都需我们自己的授权存储、Project Edit、审批 UI、Tool Call 所有权及取消关联。二者均无需本地决定任务完成、自动申请权限或调用额外模型。

**建议选择 Codex exec-server 接统一执行底层。** 我们的重点是权限、并发 Agent 和完全掌握模型 HTTP；每请求 context 能减少权限 manager/worker 的生命周期接线，已有 patch/rg 又降低了补工具算法的成本。Pi 的开箱工具体验确实更完整；若优先省模型 schema 和文本结果整理，它仍是可行选择。选择 Codex 并不需要替换整个 Agent，也不意味着保留现有文件算法。

## 复现

在 macOS arm64 使用已校验的官方 0.162.0 binary。环境变量分别指向已安装 pnpm 11.22.0 包目录和 rg 可执行文件；本机 Node／CommandLineTools 路径应与脚本检测一致。输出文件用自有绝对路径，脚本另建并清理自己的临时 fixture，不要以真实项目替代 fixture。

```sh
CODEX_PROBE_PNPM_ROOT=/absolute/path/to/pnpm/11.22.0 \
CODEX_PROBE_RG=/absolute/path/to/rg \
  node docs/research/codex-exec-server-probe.mjs \
    /absolute/path/to/codex-aarch64-apple-darwin /tmp/codex-probe-results.json
```

预期 26 passed / 1 failed，退出 1；保留失败断言为 detached daemon 回收，daemon 在 finally 中清理。脚本拒绝不匹配的 CLI 版本；其他平台／工具链、上游版本或网络变化时结果可能改变。

未实现应用接入／审批 UI，未测 Linux/Windows、完整 tyler-agent 构建、长期负载或全网抓包。共享 tmp 修复、元数据覆盖与工具链配置必须进入实际适配；实验性 API、原生体积和 detached 回收是明确保留的限制。实验资产和 fixtures 使用自有临时目录，故意遗留 daemon 已停止；最终复现完成后已清理下载源、安装资产和 fixture。
