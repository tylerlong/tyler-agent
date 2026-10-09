# 命令执行的权限边界研究

日期：2026-10-08。范围：Tyler 是唯一用户，在本机运行通用 Agent；研究命令工具启动的进程及其后代的权限和交互审批，不涉及用户独立启动的 watcher、安装升级、上下文管理或新的 Git 恢复功能。本文是研究与方案建议，不是已接受的实现规格。

**已确认的设计范围**：用户接受首版采用 best efforts，不要求先解决全部隔离边界问题。命令自身进程树的责任边界、命令及结构化文件工具可访问的 Agent 独立临时工作目录及交由系统清理的选择、特殊目录名的拒绝策略、链接处理、读取权限规则、命令工具内置审批、模型主导权限申请及拒绝后的后续处理、Project Edit 中管理的持久项目授权及其修改生效时机、网络受限模式的默认拒绝与域名授权、文件／网络独立访问模式及仅初始化新 Chat 的全局默认记录于 [ADR 0004](../adr/0004-command-tool-isolation-boundary.md)；`AGENTS.md` 加载留待以后支持。缓存兼容性、系统／工具链只读例外、命令访问模式与执行前审批的具体接入仍待验证，下面的研究建议不自动视为已接受决定。

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

**已确认的特殊目录名策略**：首版遇到无法安全按字面路径授权的 Target Folder 时，拒绝该次命令执行并向模型明确说明原因；现有文件工具保持原有行为。该策略尚未实现，不改变以上发布版实验的原始失败结果。

**已确认的链接策略**：符号链接保留正常使用，写入由沙箱按实际目标权限判断；已有跨范围硬链接的修改效果被接受为首版 best efforts 的已知限制，暂不额外处理。接受这一限制不改变原始实验中的失败记录。

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

### 临时工作目录与模型环境说明

**已确认决定**：采用 `/tmp/tyler-agent/` 作为父目录，由运行时为每个 Agent 分配独立子目录，例如 `/tmp/tyler-agent/<agent-id>/`。命令只获得自己子目录的临时目录许可，供实验和暂存可丢弃内容使用；运行时发送实际绝对路径给模型，并设置相应的临时目录和缓存环境变量。首版不由应用自行清理，交由当前 macOS 的 `/tmp` 系统清理机制处理。

**代码事实**：当前模型请求的 `instructions` 由 [openrouter.ts](../../src/openrouter.ts) 直接生成，包含 Target Folders 和子模型清单，没有自动加载项目 `AGENTS.md`。现有文件工具只接受 Target Folders 范围内的路径；目录说明不会为范围外临时路径授予权限。

**已确认的文件工具访问范围**：结构化文件工具也可读写所属 Agent 的临时工作目录，将该目录与当前项目的 Target Folders 合并为该次调用的授权范围；沿用真实路径、父目录和链接校验，不自动授权其他 Agent 的临时目录。内容访问要求实际目标位于合并范围内，移动／删除末级符号链接仍操作链接条目本身。这扩展 ADR 0003 的仅 Target Folders 授权规则，其余文件工具契约继续有效；当前应用代码尚未实现此扩展。

**系统清理的本机依据（2026-10-09）**：本机 macOS 26.7.1 的 `/usr/share/man/man8/tmp_cleaner.8` 明确说明每天检查 `/tmp` 并删除近期未修改的旧内容；`/System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist` 启动 `/usr/libexec/tmp_cleaner`，日历配置为 `Hour = 0`。只读 `launchctl print system/com.apple.tmp_cleaner` 确认服务已加载、已运行 9 次、最近退出码为 0。Apple 官方开源手册和配置支持上述机制，但具体清理规则不是稳定 API，不能沿用旧 `periodic` 的三天说明作为本机保证。应用不承诺临时内容的保留或回收期限；需要长期保存的成果应移入 Target Folders，需要临时目录时确保它存在。本轮没有触发清理、重启、写清理测试文件或查看用户临时内容，也没有核实当前二进制的确切年龄阈值。[Apple 官方手册](https://github.com/apple-oss-distributions/diskdev_cmds/blob/main/tmp_cleaner/tmp_cleaner.8)、[Apple 官方配置](https://github.com/apple-oss-distributions/diskdev_cmds/blob/main/tmp_cleaner/com.apple.tmp_cleaner.plist)、[Apple DTS 对规则稳定性的说明](https://developer.apple.com/forums/thread/71382)

**交付范围与待验证事项**：用户明确将 `AGENTS.md` 加载留到以后支持，本次由运行时直接提供临时目录信息。改变环境变量不会撤销 sandbox-runtime 的默认目录许可，执行策略需要另行处理这些默认许可并验证缓存兼容性。

### 审批应如何接入

**审批归属**：使用可信 Runtime 发起、由浏览器用户响应的 pending approval。请求应绑定 Agent/Tool Call、准确命令、`cwd`、所需路径的读写性质或网络域名；模型提供理由，用户决定是否批准及授权期限，具体选择按下述已确认的工具接口处理。

**事实与参考模式**：Harpe 的 approval 同样由 trusted tool/capability 发起，并在执行真实效果前等待用户；拒绝、超时、取消返回实际 Tool Result。无人可决定时按取消处理，模型无法批准自己的动作。[Harpe Human Approval](https://harpe.jo-lang.org/concepts/approvals/)

**已排除的网络审批候选**：库的网络代理回调可以在连接发生前等待 UI 决定并继续连接，但用户要求尽量避免本地编排权限申请与后续处理，因此首版不采用执行中自动审批。普通文件访问被 OS sandbox 拒绝时通常也需要新的权限配置和新进程；先把失败与已发生效果交给模型，再由模型申请新调用。不能自动重跑整个命令，因为失败前可能已经产生副作用；批准也不默认解除整个 sandbox。[sandbox-runtime](https://github.com/anthropics/sandbox-runtime)

**0.0.78 源码核查**：`SandboxAskCallback` 是接收 `{ host, port }`、返回 `Promise<boolean>` 的网络回调；未命中网络允许／拒绝规则且未启用 `strictAllowlist` 时才调用，`false` 或抛错均拒绝，不会自动保存域名授权。文件访问没有对应的等待审批回调；`wrapWithSandbox` 在启动前生成文件规则，`updateConfig` 明确不实时更新运行中进程的文件权限。发布包通过本机 npm 镜像取得并校验其完整性，README 与官方 `v0.0.78` tag 一致；官方 registry 直连因证书链错误未完成。本轮核查源码，未增加动态审批实验，临时解包目录已清理。[回调类型](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-schemas.ts#L111-L118)、[网络回调调用](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L332-L413)、[文件权限更新契约](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L2016-L2034)

**已确认的工具接口与授权选择**：首版把额外路径权限和申请理由放在命令工具的参数中，由本地运行时在启动该次命令前校验并等待浏览器用户决定。提供拒绝、允许这次和始终允许当前 Project：一次批准绑定准确命令、工作目录和额外访问范围；项目授权持久保存获准的额外访问范围与权限类型，供该项目现有及未来的所有 Chat、主 Agent 和子 Agent 复用，其他 Project 各自授权。已知需要权限时可以直接申请；执行中发现未知文件访问被拒绝时，返回实际结果，由模型决定是否发起新的命令调用。不为命令执行单独增加 `prompt_for_approval` 工具。

**已确认的模型／本地职责边界**：文件和网络访问在执行中被拒绝时，本地只执行既有权限边界并记录可获得的拒绝信息、路径／域名、输出和退出码，不根据错误自行申请权限、扩大范围、重跑命令或等待批准后恢复连接。远程模型决定是否通过新命令调用明确申请额外权限、重试、换命令或结束任务；用户仍是批准方，本地保留参数校验、审批展示及强制权限检查。网络受限模式可使用 `strictAllowlist` 阻止落入动态审批回调，允许所有域名模式的自动放行则只是执行用户已选择的权限规则；具体 SDK 接入尚未实测。

**已确认的管理入口**：在 Project Edit 中查看、添加、修改和删除项目允许的额外权限。该入口与审批中的“始终允许当前 Project”管理同一份数据，首版只保留 Project 这一个持久授权层级。

**已确认的生效时机**：Project Edit 中保存的权限修改／撤销影响后续启动的命令；已运行的命令保留启动时获准的权限，用户需要立即停止时可取消其执行。命令启动时读取所属项目的最新授权。文件权限无法在运行中直接追加或撤回，网络代理则存在实时决策能力，统一生效时机尚需在集成实验中验证。

**已确认的网络默认规则**：网络受限模式下，未获授权域名默认禁止访问，需要时按具体域名申请，支持允许这次及始终允许当前 Project；持久域名授权在 Project Edit 中管理。域名授权允许发送和接收数据，不区分上传与下载。

**已确认的访问模式与全局默认**：文件和网络分开设置，文件为受限／完全访问，网络为受限／允许所有域名。全局默认两项均受限，只用于新 Chat 创建时初始化其实际选项；每个 Chat 独立保存自己的两项设置，不提供“继承全局”，修改全局不会追溯修改已有 Chat，与模型／思考强度的对话配置用法一致。受限模式继续使用目标文件夹、Agent 临时目录、项目授权和该次工具调用的许可；文件完全访问取消文件范围限制与额外文件审批，仍受运行服务的 OS 账号权限约束。用户接受首版网络完全访问通过允许所有域名实现，不要求关闭全部网络隔离或支持全部协议。项目继续管理具体权限，不额外引入项目级模式覆盖；首版不增加自动安全审批。具体执行接入尚未验证。

**Full access 的版本能力核查**：官方固定 `v0.0.78` 源码支持 `filesystem.disabled`，可关闭普通文件规则及内置强制写保护而保留网络隔离；配置了 credential 文件 mask 时，额外的文件拒绝仍会传入 wrapper，因此这里的完整文件访问结论针对没有该配置的常规用法。网络 schema 没有对称的 `network.disabled` 开关，且 `allowedDomains: ['*']` 被正式校验拒绝；绕过校验也仍受 TCP 代理、直接 UDP/DNS、监听和 Unix socket 等规则限制，不能据此承诺支持全部网络协议。用户已接受首版只要求放行所有域名，所以不需要为了该选项关闭整个网络隔离层。若将来两维都真正取消 OS sandbox 限制，可直接启动原命令并复用 Tool 的输出、超时、取消与持久化流程，这是集成推论；完全访问仍受宿主账号和 OS 自身权限约束。本轮仅核查源码，没有执行 full-access 命令。[文件开关](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-config.ts)、[网络判断](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L1648-L1663)、[域名校验](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-config.ts#L25-L63)、[macOS 规则](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/macos-sandbox-utils.ts)

**允许所有域名的候选接入**：使用正式回调接口，在没有额外 deny 规则且 `strictAllowlist: false` 的配置下，让 `SandboxAskCallback` 自动返回 `true`，可以放行所有格式合法的代理目标而不展示逐域名审批；仍保留地址检查、代理和 OS 协议限制。这比绕过 schema 强塞裸 `*` 更适合目前已确认的首版语义，但还没有动态验证。[代理授权流程](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L319-L391)

**并行 Chat 的网络策略限制**：该版本的配置、代理和初始化状态是模块级共享状态；代理读取全局网络规则并使用初始化时的回调。`wrapWithSandbox` 的单次 network override 不能提供独立的代理域名策略，`updateConfig` 又会影响该代理下所有运行中命令，因此不能让不同 Chat 通过反复修改共享 Manager 来切换授权。建议每次命令通过独立执行器进程初始化自己的 Manager，使用所属 Chat 和 Project 的授权快照，保证并行 Chat 的模式、一次批准及项目授权互不扩大；这属于待实验的接入建议，不是已经实现的隔离。[共享状态](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L126-L151)、[回调接线](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L514-L554)、[单次包装](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L1648-L1663)、[实时规则更新](https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/src/sandbox/sandbox-manager.ts#L1915-L1957)

**Codex 参考的范围**：用户提供的界面和说明用于提出全局默认与 Chat 覆盖的产品行为；官方文档确认 Full access 会解除文件与网络的沙箱边界，Approve for me 则依赖额外的自动审批能力。参考这些行为不意味着首版需要实现自动审批，也不代表上述独立网络开关已经验证。[Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)

**错误层次**：OS 对未获准文件访问返回错误，命令内的程序可能抛异常、打印错误退出，也可能捕获错误后继续。父执行器需要收集退出码、stdout、stderr 和可获得的沙箱拒绝记录，不会自动收到子程序语言层的异常；不能仅凭 `EPERM`／`EACCES` 字样断言沙箱是唯一原因。权限识别用于提供事实和建议，批准决定仍由本地用户提交。

**现有循环的接入位置**：[requestModel](../../src/openrouter.ts) 已经逐次等待异步工具执行，再把对应 Tool Result 放入下一次模型请求。等待本地审批可以放在这次工具执行之内；当前代码尚未实现审批状态、UI 或执行授权。

**业内参考**：Claude Code 将执行前的工具权限判断与执行期间的 OS sandbox 分开，并在命令结果中报告网络拒绝，供模型决定后续调用。这支持“模型提出请求，本地落实决定”的结构，不代表应照搬其解除沙箱重试选项。[Claude Code：权限与隔离](https://code.claude.com/docs/en/sandboxing#how-sandboxing-relates-to-permissions-and-permission-modes)

## Jo：价值与适用边界

**事实**：Jo 是静态类型语言，编译到 Python/Ruby；其 confined world 只能依赖 confined 库，没有 FFI、反射或跨边界动态加载。trusted world 实现并提供 capability，编译器检查调用链和能力声明。这属于语言与 API 层的隔离，不是把任意外部程序放进文件系统 sandbox。[Jo 两世界架构](https://jo-lang.org/security/two-worlds.html)、[语言概览](https://jo-lang.org/overview/index.html)

**事实**：Harpe 官方定位是 specialized agents。应用开发者预先设计 capability 接口，可信实现保存凭据、验证参数和落实用户/租户范围。模型用 Jo 编写循环、分支和组合，减少每个中间结果都经过模型的需要。[Why Harpe](https://harpe.jo-lang.org/overview/why-harpe/)

**事实**：Jo 官方有开放式交互 Sandbox Agent：用户聊天，模型写 Jo 程序，文件访问经过 typed API 和 trusted runtime 路径校验。这说明语言并非只能执行固定工作流，也不要求 prompt 来自预设模板。[Sandbox Agent 示例](https://jo-lang.org/security/examples/sandbox-agent.html)

**推论**：关键区别是 **授予的能力有多宽**，而不是 prompt 是否任意。一个通用助手也能借 Jo 在受限文件/API 能力内自由组合任务。可是若暴露 `runShell(command: String)`，编译器只能证明程序使用了获授的 shell 能力，不能理解或限制命令中的所有实际效果；限制 Git、包管理器、原生测试程序仍要 OS sandbox。

**源码事实**：Harpe 的 CLI `RunBash.jo` 在用户批准准确命令后运行 `bash -lc`，源码明确说明这个 shell 不带 `runCode` 的 sandbox。`RunCode.jo` 的 OS wrapper 是可选 `run.sh`，未配置时运行系统 Python。因此同一个 Jo 项目也区分语言能力约束与外部进程隔离。[RunBash 源码](https://github.com/typescope/harpe/blob/main/cli/src/RunBash.jo)、[RunCode 源码](https://github.com/typescope/harpe/blob/main/agent/tools/RunCode.jo)

**事实**：Harpe 文档明确编译器不证明操作/参数选择正确，也不限制 CPU/memory，建议外部 OS sandbox 补充。Jo 仓库自述 early-stage；Harpe 为 developer preview，API 可能变更。[保证与限制](https://harpe.jo-lang.org/concepts/sandbox/)、[Defense in Depth](https://harpe.jo-lang.org/guides/defense-in-depth/)、[Jo 仓库](https://github.com/typescope/jo)、[Harpe 仓库](https://github.com/typescope/harpe)

**项目判断**：Tyler 的理解方向正确，但“对通用 Agent 帮助不大”应缩小到当前任务：为 Node 项目补任意开发命令时，Jo 没有替代 OS sandbox 的收益，反而要引入语言、编译器、运行时和 capability 设计。未来若需要安全组合大量业务工具、隐藏凭据或按用户收窄数据权限，Jo/类似 code mode 值得独立评估；未实测其模型成功率、性能或维护成本。

## 当前项目的设计影响

现有 [ADR 0003](../adr/0003-structured-file-tools.md) 明确选择避免 shell，并把 Target Folders 设为文件访问的应用授权规则。[ADR 0004](../adr/0004-command-tool-isolation-boundary.md) 已记录新增命令工具的首版责任边界，并明确扩展结构化文件工具的授权范围，允许所属 Agent 的临时工作目录；其余文件工具契约继续有效。工具链只读例外和命令 sandbox 的具体执行接入仍需验证。

### 命令工具的执行边界

**用户明确的范围**：命令工具负责它启动的进程及其后代。用户独立启动的 watcher 本来就会运行修改后的代码，其权限安全由外部运行环境负责；本次不要求沙箱化 watcher、运行服务代码快照或改变开发启动方式。[当前启动脚本](../../package.json)

**边界说明**：在目标文件夹内修改源码属于获准的文件操作；外部 watcher 随后执行该源码不是命令工具启动的子进程，不属于该工具的沙箱保证。若命令工具自己启动 watcher，则该 watcher 及其后代仍必须受沙箱约束。此前将外部 watcher 的保护列为本次必需工作，范围过大，现按用户说明修正。

**审批实现仍需维护的约束**：批准决定由用户和可信 Runtime 提交，命令不能自行批准额外权限。后续设计应检查审批状态与接口是否能被执行中的命令直接改写。现有 Host/Origin 校验是浏览器请求保护，本地进程可以自行构造这两个字段，不能用它们单独证明批准来自用户。[Host/Origin 校验](../../src/server.ts)

目前只保存研究笔记、实验脚本和结果，未修改应用代码或依赖，未调用付费模型。已验证 Deno 2.3.1、最小 Seatbelt 写入边界与 sandbox-runtime 0.0.78 的上述 macOS 文件范围；交互审批、运行中进程的权限撤销、Linux／Windows、真实项目完整构建、资源限制和漏洞逃逸没有验证。
