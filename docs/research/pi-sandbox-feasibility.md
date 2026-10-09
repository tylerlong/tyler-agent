# Pi 工具套件 + sandbox-runtime 的可行性验证

日期：2026-10-09。固定 Pi 1.1.0、sandbox-runtime（SRT）0.0.78；macOS arm64、Node 24.21.0、pnpm 11.22.0。仅实验这条路线，未修改应用依赖、锁文件、设置或服务，没有调用真实模型。

## 判断

**核心路线可行，适合首版 best efforts。** 可复用 Pi 整套文件／命令工具，把整个 worker 放入 SRT，保留自己的 Agent/Sub-agent、动态模型及模型 HTTP 记录。未发现必须交出 Agent loop、工具自行调用模型、或无法设置独立文件／域名范围的阻断条件。

**Pi 取消的已知限制：主动脱离原进程组的后台进程会留下。** Pi 默认取消杀进程组，实验中通过 Node `detached: true` 新建 session/process group 的进程未被停止；“主动”指程序显式选择这种启动方式，不表示恶意。残留进程仍继承文件／网络沙箱，不能描述为权限逃逸。当前应用尚未实现命令执行工具；现有“取消全部后代”指 Agent/Sub-agent 树，不能直接当成任意 OS 后代进程的回收承诺。本轮失败断言检验的是更强的命令取消要求，该要求尚未定为首版发布门槛；此前称其为明确上线阻塞不准确。[Pi 进程清理](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/utils/shell.ts)

另外两个真实失败已在不扩大文件范围的前提下修复：SRT 覆盖 TMPDIR，以及本机 Corepack pnpm 入口读取范围外的父 manifest。下面给出实际结果和接线要求。已有跨范围硬链接限制及特殊 Target Folder 字符的拒绝策略仍按已接受 best efforts 决定处理；本轮不把它们改称已解决。[ADR 0004](../adr/0004-command-tool-isolation-boundary.md)

## 真实实验结果

前轮七工具／文件隔离 28 项断言通过。本轮新增最终 **17 项检查，16 通过、1 失败**；失败是刻意 detached daemon 在取消后仍存活。实验随后按自有 fixture 记录的 PID 停止了该进程，没有把清理操作计为 Pi 原生能力。

| 验证内容 | 实际结果 |
| --- | --- |
| 未批准 HTTPS 域名 | 拒绝，返回域名拒绝事实；没有审批回调 |
| 获批域名与未获批另一域名 | 前者成功，后者拒绝 |
| 两个并发 manager/worker，允许列表不同 | 一个成功，一个拒绝，权限未串用 |
| 命令删除 proxy 环境变量直接联网 | OS 网络边界拒绝 |
| `*.npmjs.org` 子域规则 | 成功 |
| 网络 full、文件 restricted | 两个未逐项列出的公开域名可访问；范围外文件读取仍拒绝 |
| 文件 full、网络 restricted | 自有 outside fixture 可写；未批准网络仍拒绝 |
| 本次额外目录允许，下一次撤销 | 新调用不再能修改该文件，原内容保留 |
| Pi 原生 timeout、通过 host IPC 传 AbortSignal | 普通同进程组后代停止，退出结果诚实返回 |
| 8 MiB 单行输出 | 修复 tmp 配置后成功；模型文本约 50 KiB、结构化输出约 1 MiB，完整 8 MiB 日志在 own tmp |
| import + 七工具 + 编辑失败路径的 HTTP spy | fetch/http/https/Socket.connect 尝试计数为 0 |
| pnpm 11.22.0 在线安装 is-number 7.0.0，再运行 Node test | 成功，真实依赖被下载，目标内写出 verified artifact |
| Git init/add/commit/diff | 成功 |
| 新建进程组的 detached daemon，在 Agent abort 后应停止 | **失败：仍存活** |

HTTP spy 在 import 前安装，意外调用会记录并抛错；禁止工具自动下载并关闭 telemetry。它覆盖该 Node worker 的常见 HTTP／连接入口及已运行路径，不是所有依赖或命令子进程的永久无网络保证。获批 Bash curl/pnpm 的联网是明确的工具行为，与模型 HTTP 分开；未运行 Pi AgentSession/模型 transport，没有传模型 API key。

原始[首次结果](./pi-sandbox-initial-results.json)记录 TMPDIR 和 Corepack 两个失败；[最终结果](./pi-sandbox-probe-results.json)保留 detached 取消失败。可复现[实验脚本](./pi-sandbox-probe.mjs)默认因此退出 1，不删失败断言以宣称全部通过。

## 需要正确接的三处

**1. 隔离整个 worker，并绑定独立 manager。** 文件工具本身直接使用 Node fs，grep/find 启动 rg/fd；只 wrap Bash 不覆盖这些路径。每个独立权限范围用自己的 SRT manager 进程，避免 singleton 配置变化影响并发 Agent。普通调用可复用同一权限快照的 worker；权限变更时，下次调用使用新快照／重启，运行中的命令保持旧策略。本轮以独立短生命周期 manager/worker 验证，尚未接进实际服务。[Pi 工具入口](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/tools/index.ts)、[SRT manager](https://github.com/anthropics/sandbox-runtime/blob/v0.0.78/src/sandbox/sandbox-manager.ts)

**2. 明确设置 SRT 的临时目录。** 单设 worker TMPDIR 不够：SRT 会把它覆盖为 `/tmp/claude`。在我们拒写这个默认目录时，Pi 超长输出创建日志触发 unhandled WriteStream error，worker 退出。将独立 host manager 的 `CLAUDE_CODE_TMPDIR` 设为 own Agent tmp，并只放行该目录，8 MiB 实验原断言通过；没有重新开放共享 scratch。不能在所有 Agent 共用的服务进程里反复修改全局环境。[SRT env 生成](https://github.com/anthropics/sandbox-runtime/blob/v0.0.78/src/sandbox/sandbox-utils.ts)、[Pi 日志](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/utils/output-files.ts)

**3. 文件／网络 full 分开落实。** SRT validator 拒绝裸 `allowedDomains:['*']`。实际可行的 full-domain 路线是官方 initialize 的 callback 始终返回 true，仅用于用户已明确选择 network full 的情况；restricted 不提供 callback，并设 strictAllowlist。它是机械落实用户模式，不推断权限、不自动询问或重试。文件 full 另用 `/` write、空 denyRead/denyWrite，仍受 OS 用户权限约束。[域名 schema](https://github.com/anthropics/sandbox-runtime/blob/v0.0.78/src/sandbox/sandbox-config.ts)、[过滤与 callback](https://github.com/anthropics/sandbox-runtime/blob/v0.0.78/src/sandbox/sandbox-manager.ts)

本机 `pnpm` 为 Corepack shim，找项目配置时会读取目标外父 manifest。在实际实验中，直接调用**已经安装的 pnpm 11.22.0 程序入口**，只读放行它自身目录，安装／测试通过，没有放开整个 Home。生产工具链需要类似的明确入口和只读依赖；不能由本次成功推出所有工程无需配置。这里没有下载新 pnpm 作为业务依赖。

## 依赖代价

package.json 需要直接加 **2 项**：`@earendil-works/pi-coding-agent@1.1.0` 和 `@anthropic-ai/sandbox-runtime@0.0.78`。[Pi metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.1.0)、[SRT metadata](https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/0.0.78)

| 口径 | 实测 |
| --- | ---: |
| Pi 自身声明的直接依赖 | 23 |
| SRT 自身声明的直接依赖 | 4 |
| Pi 单独安装闭包，含 Pi 本身 | 121 个 package 目录 |
| SRT 单独安装闭包，含 SRT 本身 | 5 个 package 目录 |
| 两包合并的本机独立安装 | **126 个 package 目录**，即 2 根包 + 124 随带包；122 个去重名称 |
| 独立 node_modules 磁盘占用 | **约 174.8 MiB**，文件内容约 130.5 MiB；不含 npm cache |
| 当前项目 pnpm-lock 隔离副本净增 | **139 个名称／143 个版本条目**，含跨平台 optional；原包版本未升级／删除 |

126 是独立 macOS 安装，143 是现有应用的全平台 lock 图增量，不可混称实际应用装入数量。尚未安装加包后的应用，所以没有测其物理 node_modules 增量。Pi 与 SRT 的这次独立闭包没有重合；此前的 121 是 Pi 单根，不含 SRT。

体积主要来自 Pi 的 Agent/provider/TUI 等依赖，包括 OpenAI、Anthropic、Google、AWS SDK；当前没有受 package exports 支持的 tools-only 包／入口。因此官方正常安装会携带这些依赖，即使不运行模型循环。提取工具可行，但要维护一份上游代码和资源，不作为本次默认方案。安装图大不等于工具会调用这些模型。[Pi manifest](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/package.json)

默认 grep/find 还需要 **rg 和 fd/fdfind 两个可执行工具**，不在 npm 计数内；Node、shell、macOS sandbox-exec 为运行环境。本次用现有 rg、校验 SHA256 的官方 fd 10.3.0，设 `PI_OFFLINE=1` 防止隐式下载、`PI_TELEMETRY=0`；安装使用 `--ignore-scripts`，未要求本机编译 Node addon。包仍包含原生／WASM 资产，不能称为纯 JS。[Pi binary manager](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/utils/tools-manager.ts)

[依赖测量摘要](./pi-sandbox-dependencies.json)保存计数、磁盘、manifest 入口、脚本和当前锁图比较。两个根包固定不等于所有传递依赖永久固定，实际采用须保存 lockfile。首次默认公司 registry 查询失败，显式官方 registry 成功，属于 mirror 问题；没有用更换包名／版本掩盖失败。

## 采用建议与边界

建议继续采用这条路线做实际接入，以公开工厂复用文件／命令算法；保留自己的可信 Tool Call 所有权、schema/result 适配、权限存储／审批 UI 和 HTTP transport。无需让本地代码判断任务何时结束或自动扩权。第三方工具不要求主／子 Agent 使用同一模型。

这不是零代码接入。必须连接现有 Agent 的取消信号，处理 worker 状态、日志目录、运行时只读范围和工具结果归档。默认 Bash 非交互，不能当现成 PTY/session 平台；完整日志没有硬磁盘配额；whole-worker 冷启动样本约一秒，适合评估同策略 worker 复用。它们是接入成本；**detached 进程回收是尚待确定范围的已知限制**。首版可评估接受普通同进程组命令的 best efforts 取消；若要求连主动脱离的后台服务也自动回收，需另补生命周期管理。这不构成已有功能退化。

未实现应用接入与审批 UI，未调用真实模型，未验证 Linux/Windows、完整 tyler-agent 构建或任意 daemon 的可靠回收。所有依赖和 fixtures 位于自有临时目录，实验服务退出，故意遗留的测试 daemon 已主动停止；原有工作区修改被保留。

## 复现

在短路径隔离 runtime 安装上述两个固定 npm 包，使用官方 registry、自有 cache、ignore-scripts；在 runtime/bin 提供已校验的 fd，让 PATH 可找到 rg。`PI_PROBE_PNPM_ROOT` 指向已安装 pnpm 包的目录（含 bin/pnpm.cjs），脚本只读放行这套工具链。

```sh
PI_PROBE_PNPM_ROOT=/absolute/path/to/pnpm/11.22.0 \
  node docs/research/pi-sandbox-probe.mjs /tmp/short-isolated-runtime /tmp/pi-results.json
```

脚本仅清理传入 runtime 下自己创建的 fixture，使用新临时目录，勿传真实项目作为 runtime。输出应为 16 passed / 1 failed，失败为 detached daemon cancellation，进程在 finally 中清理。版本和传递依赖变化时结果可能改变；它不是生产安全认证。
