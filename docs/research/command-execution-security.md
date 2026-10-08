# 命令执行的权限边界研究

日期：2026-10-08。范围：Tyler 是唯一用户，在本机运行通用 Agent；研究命令工具启动的进程及其后代的权限和交互审批，不涉及用户独立启动的 watcher、安装升级、上下文管理或新的 Git 恢复功能。本文是研究与方案建议，不是已接受的实现规格。

**已确认的设计范围**：用户接受首版采用 best efforts，不要求先解决全部隔离边界问题。命令自身进程树的责任边界记录于 [ADR 0004](../adr/0004-command-tool-isolation-boundary.md)；临时／缓存目录、特殊路径和链接的具体取舍仍待讨论，下面的研究建议不自动视为已接受决定。

## 结论

- **事实**：Deno 的读写权限不能约束 `Deno.Command` 启动的外部进程；已有符号链接也使其目录权限不同于当前文件工具的真实目标路径约束。换成 Deno 不能直接实现安全的任意 shell。[Deno 权限参考](https://docs.deno.com/runtime/reference/permissions/)
- **建议**：保留 Node，把命令及其后代放进 OS sandbox。Target Folders 提供项目数据范围；平台工具链只读路径、独立临时目录和缓存需要明确的附加许可。先评估现有 macOS 实现，不自行写 shell 命令安全分类器。[Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
- **建议**：审批由可信 Runtime 和 UI 完成，针对明确的额外路径或网络域名；批准后仍在扩展后的 sandbox 中执行。不得静默退回无隔离执行。审批与隔离是两项独立控制。[Codex 安全与审批](https://learn.chatgpt.com/docs/agent-approvals-security)
- **判断**：Jo 有编译期能力约束的价值，尤其适合能力可以预先收窄的业务 Agent。它可以承载开放式聊天任务，但不是任意 `git`、`pnpm`、Python 或 shell 的 OS sandbox；当前命令执行功能没有必要因此迁移语言。[Jo 两世界架构](https://jo-lang.org/security/two-worlds.html)、[Harpe 定位](https://harpe.jo-lang.org/overview/why-harpe/)

## Deno：限制的是哪一层

**事实**：`--allow-read=<paths>` 和 `--allow-write=<paths>` 控制 Deno Runtime 所检查的文件 API。`--allow-run` 允许启动外部程序，而外部程序不继承父 Deno 进程的权限限制。`--allow-run=git` 缩小可启动的可执行文件集合，不能限定 Git 的参数、配置、hook 或子进程的行为。最后一句是由子进程独立权限这一事实得出的推论。[权限参考：文件系统与子进程](https://docs.deno.com/runtime/reference/permissions/)

**事实**：`--allow-ffi` 允许原生库和 Node-API addon 执行原生机器码，绕过 JavaScript 层权限检查。官方建议按与 `--allow-all` 相同的信任程度对待 run 和 FFI；允许运行 shell 或另一个 Deno 尤其危险。[Deno 安全模型](https://docs.deno.com/runtime/fundamentals/security/)

**事实**：当前官方权限参考说，读取已有 symlink 时按链接位置检查，允许目录内的链接可能指向目录外文件；创建新 symlink 要求更广泛权限。这与当前文件工具要求最终目标也位于某个 Target Folder 内的规则不同。[权限参考：Symbolic links](https://docs.deno.com/runtime/reference/permissions/#symbolic-links)

### 本机无害复现

2026-10-08，本机 `deno --version` 为 **2.3.1**。主研究 Agent 用 `TemporaryDirectory` 创建 `allowed/` 和 `outside/`，运行受限 Deno 脚本，随后完整清理临时目录。没有操作用户项目文件或执行破坏性命令。

| 操作 | 实际结果 |
| --- | --- |
| Deno 文件 API 直接写 `outside/native.txt` | `NotCapable`，文件不存在 |
| Deno 读取 `allowed/link.txt`，链接指向 `outside/sentinel.txt` | 成功读到目录外 sentinel |
| 只允许 `/bin/sh` 后，`Deno.Command` 的 shell 子进程写 `outside/child.txt` | 退出码 0，文件内容与 sentinel 一致 |

关键启动参数如下，路径都指向上述临时目录：

```text
deno run --no-config --no-prompt \
  --allow-read=<allowed> --allow-write=<allowed> \
  --allow-run=/bin/sh <probe.js>
```

这些结果确认了官方文档描述的权限边界；没有据此声称 Deno Runtime 的所有安全属性均已审计。

### 交互审批

**事实**：Deno 有终端权限提示和 `Deno.permissions.request()`；stdout/stderr 非 TTY 或使用 `--no-prompt` 时不会展示提示。因此后台服务捕获输出时，终端提示不是浏览器 UI 的现成审批实现。[权限参考](https://docs.deno.com/runtime/reference/permissions/)

**事实**：当前官方文档另有 `DENO_PERMISSION_BROKER_PATH`，通过 Unix socket 或 Windows named pipe 委托每次权限判断；启用 broker 后，CLI allow/deny flags 被忽略，也不显示交互提示，连接或协议失败会终止进程。**本机 2.3.1 是否支持此能力未验证**，不能把最新文档能力视为已安装版本能力。[Permission broker](https://docs.deno.com/runtime/fundamentals/security/#permission-broker)

**推论**：broker 可以连接可信应用与浏览器审批，但它检查的仍是 Deno 权限请求。允许启动 shell 后，它不会拦截 shell 内部的文件和网络系统调用，不能解决当前目标。

另有 **Deno Sandbox**：官方 CLI 提供 Deno Deploy 上的 Linux microVM，需要账户和 token，可在其中执行任意命令。它和本地 Runtime 的 allow flags 是不同产品；若未来考虑远端执行，可以另行比较，目前不需要引入。[deno sandbox](https://docs.deno.com/runtime/reference/cli/sandbox/)

## OS sandbox 与已有 Agent 实践

**事实**：Codex 区分 sandbox（技术上允许进程做什么）和 approval（何时请求用户决定）；官方说明包含 macOS Seatbelt、Linux 隔离机制，以及网络、文件访问的限制。[Codex 安全与审批](https://learn.chatgpt.com/docs/agent-approvals-security)

**事实**：Claude Code 的 sandboxed Bash 对命令及其后代实施文件与网络隔离。其实现使用 macOS Seatbelt 和 Linux bubblewrap；网络通过代理控制。官方同时说明权限默认值与可配置的逃逸/非 sandbox 执行路径，采用库时不能照搬产品默认策略。[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)

**事实**：开源 `@anthropic-ai/sandbox-runtime` 提供 TypeScript API 和 CLI，以 OS 机制限制任意进程。`SandboxManager.wrapWithSandbox` 是执行包装入口，网络请求可经过 `askCallback`。本机已完成下述发布版文件权限实验，尚未接入应用或验证审批。[官方仓库与 API](https://github.com/anthropics/sandbox-runtime)

### 本机最小 Seatbelt 探针

2026-10-08，本机 macOS **26.7.1**。主研究 Agent 在 `TemporaryDirectory` 中用最小策略允许进程启动、sysctl 读取和所有文件读取，仅允许写入临时 `allowed/` 的真实路径。`sandbox-exec` 启动 `/bin/sh`，再由它启动第二个 `/bin/sh`：写 `allowed/child.txt` 成功，写 `outside/child.txt` 被拒绝，退出码非 0 且文件不存在。断言通过并清理临时目录。

此探针只确认 OS 写入限制对子孙进程生效。它允许全部读取，不是生产策略；没有验证 sandbox-runtime 集成、网络、CPU/memory 或漏洞逃逸。

### sandbox-runtime 发布版实际实验

2026-10-08，在 macOS **26.7.1**、Node **24.20.0** 上测试 npm 发布版 **0.0.78**，pnpm **11.22.0** 预装在独立临时目录。GitHub 主分支当时声明 0.0.79，接口和修复不能视为已进入 npm 发布版。本实验没有修改应用依赖或使用真实项目、数据库；临时文件与依赖已清理。

可复现的 [实验脚本](./sandbox-runtime-probe.mjs) 和 [32 项原始检查结果](./sandbox-runtime-probe-results.json) 已保存。最终 **29 项符合预期，3 项失败**；脚本保留失败断言并返回退出码 1，不把已发现的边界问题改成通过。

每次命令调用传入自己的 `filesystem` 配置，不更新全局配置，也不重启服务：

```js
await SandboxManager.wrapWithSandbox(command, "/bin/sh", {
  filesystem: {
    denyRead: [userHome, experimentRoot],
    allowRead: [nodeToolchainDirectory, ...targetFolders],
    allowWrite: targetFolders,
    denyWrite: defaultNonDeviceWriteDirectories,
  },
});
```

`defaultNonDeviceWriteDirectories` 从库导出的 `getDefaultWritePaths()` 取得并过滤 `/dev/` 标准流／设备路径。本机默认列表包含 `/tmp/claude`、`/private/tmp/claude`、用户 `.npm/_logs` 和 `.claude/debug`。不拒绝默认 scratch 时，临时的范围外文件确实能写入；显式拒绝后相同范围的写入被阻止。这是库附加的默认许可，不能忽略。

| 验证项 | 实际结果 |
| --- | --- |
| 每次动态切换 A/B、空列表、同时选择 A+B | 指定根可写；未选根被拒绝；空列表禁止项目文件写入 |
| 同时执行两条命令，各自有不同根列表 | 权限不串到另一条命令 |
| 范围外创建、覆盖、追加、删除、递归删除、chmod、双向移动 | 被拒绝；检查外部文件内容与权限保持原样 |
| 共享目录名前缀、`..` 路径越界、Node 子进程 | 不能绕过写入范围 |
| 文件 symlink、父目录 symlink 指向未选根 | 写入被拒绝；指向另一个已选根时允许 |
| 配置禁止读取实验根，再放行目标根 | 外部测试文件读取被拒绝；系统工具链仍可用 |
| Git init/add/commit/diff | 在临时目标内成功 |
| 预装 pnpm 离线初始化零依赖项目，再执行 Node 测试 | 成功，测试输出写入目标内；网络保持禁止 |
| 已有跨范围硬链接 | **失败：通过目标内链接写入会改变范围外同一 inode 的内容** |
| 含 `[]`、`*` 的字面目录名 | **失败：按 glob 解析，合法目录内写入被拒绝** |
| 字面根目录 `glob-*` 与未选中的同级路径 | **失败：glob 扩大许可，未选路径被创建为普通文件** |

**判断**：普通绝对目录可以在同一 Runtime 中按每次命令动态指定，基本文件范围和子进程继承满足预期。但发布版不能无条件保证“任意 Target Folders 之外的数据绝不改变”。采用前至少需要防止目录名被解释为 glob，并明确已有跨范围硬链接的处理。拒绝创建新的跨范围硬链接已验证，不能据此声称已有硬链接问题也已解决。

pnpm 初始尝试经过机器上的 Corepack shim，需要联网获取版本；另一次缺少依赖初始化会触发自动安装。这些是工具链预置问题。最终使用临时目录预装的准确版本入口，在沙箱内执行零依赖 `install --offline --ignore-scripts` 后运行 `test`，没有扩大网络或目标目录写权限。这个小型 fixture 不等同于已验证真实仓库的全部构建与测试。

复现步骤（在独立临时目录安装依赖，不安装到应用）：

```sh
probe_dir=$(mktemp -d)
npm install --prefix "$probe_dir" --ignore-scripts --no-audit --no-fund \
  @anthropic-ai/sandbox-runtime@0.0.78 pnpm@11.22.0
node docs/research/sandbox-runtime-probe.mjs \
  "$probe_dir/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js"
# 当前发布版会保留上述 3 项失败并返回 1；完成后删除自己创建的 probe_dir。
```

**建议**：首版针对 macOS 评估成熟 OS wrapper，保留当前服务和工具循环：

1. 命令默认在 sandbox 内，覆盖其后代进程；缺少 sandbox 或初始化失败时拒绝执行。
2. Target Folders 可读写；工具链、解释器和动态库的必要路径只读；临时文件与缓存用单独受控目录。当前库的宽泛默认读权限不能视为“只能访问 Target Folders”，必须核实限制个人文件的能力。
3. 网络默认拒绝或只允许明确域名；不向命令继承模型 API key 等不需要的秘密。
4. 不提供 `sudo`、原始磁盘设备、Docker socket 或可绕过范围的宿主服务入口。这里的目标是限制能力，不是识别并拦截 `rm`、`mkfs` 等几个字符串。
5. 输出、退出码、超时、取消与进程清理仍由 Tool Runtime 负责；停止不声称回滚已经完成的修改。

这是一份待验证的项目策略。正常开发命令往往需要目录外的工具链；“项目数据只能在目标文件夹内”和“任何目录外读取都禁止”应明确区分。OS sandbox 仍依赖内核、wrapper 配置和可信服务，不能声称绝对不会被漏洞突破。

### 审批应如何接入

**建议**：使用可信 Runtime 发起、由浏览器用户响应的 pending approval。请求应绑定 Agent/Tool Call、准确命令、`cwd`、所需路径的读写性质或网络域名；模型提供理由，但不能提交批准决定。最小先做“允许这次”与“拒绝”，不先做宽泛永久授权。

**事实与参考模式**：Harpe 的 approval 同样由 trusted tool/capability 发起，并在执行真实效果前等待用户；拒绝、超时、取消返回实际 Tool Result。无人可决定时按取消处理，模型无法批准自己的动作。[Harpe Human Approval](https://harpe.jo-lang.org/concepts/approvals/)

**建议**：网络代理可在连接发生前等待 UI 决定并继续当前连接。普通文件访问被 OS sandbox 拒绝时，通常需要新的权限配置和新进程；先把失败与已发生效果交给模型，再申请重新执行。不能自动重跑整个命令，因为失败前可能已经产生副作用。批准也不应默认解除整个 sandbox。[sandbox-runtime](https://github.com/anthropics/sandbox-runtime)

## Jo：价值与适用边界

**事实**：Jo 是静态类型语言，编译到 Python/Ruby；其 confined world 只能依赖 confined 库，没有 FFI、反射或跨边界动态加载。trusted world 实现并提供 capability，编译器检查调用链和能力声明。这属于语言与 API 层的隔离，不是把任意外部程序放进文件系统 sandbox。[Jo 两世界架构](https://jo-lang.org/security/two-worlds.html)、[语言概览](https://jo-lang.org/overview/index.html)

**事实**：Harpe 官方定位是 specialized agents。应用开发者预先设计 capability 接口，可信实现保存凭据、验证参数和落实用户/租户范围。模型用 Jo 编写循环、分支和组合，减少每个中间结果都经过模型的需要。[Why Harpe](https://harpe.jo-lang.org/overview/why-harpe/)

**事实**：Jo 官方有开放式交互 Sandbox Agent：用户聊天，模型写 Jo 程序，文件访问经过 typed API 和 trusted runtime 路径校验。这说明语言并非只能执行固定工作流，也不要求 prompt 来自预设模板。[Sandbox Agent 示例](https://jo-lang.org/security/examples/sandbox-agent.html)

**推论**：关键区别是 **授予的能力有多宽**，而不是 prompt 是否任意。一个通用助手也能借 Jo 在受限文件/API 能力内自由组合任务。可是若暴露 `runShell(command: String)`，编译器只能证明程序使用了获授的 shell 能力，不能理解或限制命令中的所有实际效果；限制 Git、包管理器、原生测试程序仍要 OS sandbox。

**源码事实**：Harpe 的 CLI `RunBash.jo` 在用户批准准确命令后运行 `bash -lc`，源码明确说明这个 shell 不带 `runCode` 的 sandbox。`RunCode.jo` 的 OS wrapper 是可选 `run.sh`，未配置时运行系统 Python。因此同一个 Jo 项目也区分语言能力约束与外部进程隔离。[RunBash 源码](https://github.com/typescope/harpe/blob/main/cli/src/RunBash.jo)、[RunCode 源码](https://github.com/typescope/harpe/blob/main/agent/tools/RunCode.jo)

**事实**：Harpe 文档明确编译器不证明操作/参数选择正确，也不限制 CPU/memory，建议外部 OS sandbox 补充。Jo 仓库自述 early-stage；Harpe 为 developer preview，API 可能变更。[保证与限制](https://harpe.jo-lang.org/concepts/sandbox/)、[Defense in Depth](https://harpe.jo-lang.org/guides/defense-in-depth/)、[Jo 仓库](https://github.com/typescope/jo)、[Harpe 仓库](https://github.com/typescope/harpe)

**项目判断**：Tyler 的理解方向正确，但“对通用 Agent 帮助不大”应缩小到当前任务：为 Node 项目补任意开发命令时，Jo 没有替代 OS sandbox 的收益，反而要引入语言、编译器、运行时和 capability 设计。未来若需要安全组合大量业务工具、隐藏凭据或按用户收窄数据权限，Jo/类似 code mode 值得独立评估；未实测其模型成功率、性能或维护成本。

## 当前项目的设计影响

现有 [ADR 0003](../adr/0003-structured-file-tools.md) 明确选择避免 shell，并把 Target Folders 设为文件访问的应用授权规则。[ADR 0004](../adr/0004-command-tool-isolation-boundary.md) 已记录新增命令工具的首版责任边界；现有文件工具契约继续有效。工具链只读例外、额外权限批准及命令 sandbox 的具体策略仍需后续确认。

### 命令工具的执行边界

**用户明确的范围**：命令工具负责它启动的进程及其后代。用户独立启动的 watcher 本来就会运行修改后的代码，其权限安全由外部运行环境负责；本次不要求沙箱化 watcher、运行服务代码快照或改变开发启动方式。[当前启动脚本](../../package.json)

**边界说明**：在目标文件夹内修改源码属于获准的文件操作；外部 watcher 随后执行该源码不是命令工具启动的子进程，不属于该工具的沙箱保证。若命令工具自己启动 watcher，则该 watcher 及其后代仍必须受沙箱约束。此前将外部 watcher 的保护列为本次必需工作，范围过大，现按用户说明修正。

**审批实现仍需维护的约束**：批准决定由用户和可信 Runtime 提交，命令不能自行批准额外权限。后续设计应检查审批状态与接口是否能被执行中的命令直接改写。现有 Host/Origin 校验是浏览器请求保护，本地进程可以自行构造这两个字段，不能用它们单独证明批准来自用户。[Host/Origin 校验](../../src/server.ts)

目前只保存研究笔记、实验脚本和结果，未修改应用代码或依赖，未调用付费模型。已验证 Deno 2.3.1、最小 Seatbelt 写入边界与 sandbox-runtime 0.0.78 的上述 macOS 文件范围；交互审批、运行中进程的权限撤销、Linux／Windows、真实项目完整构建、资源限制和漏洞逃逸没有验证。
