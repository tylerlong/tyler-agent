# microsandbox 深度验证与 Codex exec-server 对比

2026-10-09。固定 **microsandbox 0.7.8**，npm `gitHead` 与源码 commit `7b7b9dc89e9a1c77801918f7833c3381d1754579` 一致。macOS 26.7.1 arm64、Node 24.21.0、pnpm 11.22.0。独立 npm 安装、runtime home、清空继承环境和自建文件；不登录、不调用真实模型、不修改应用依赖或运行现有服务。

## 判断

**它是实际可用的 Linux 沙箱执行后端，值得保留为候选；当前不推荐替换 Codex exec-server。** 虚拟机安装并没有想象中麻烦，目录隔离、并发 scope、严格域名 HTTPS、Git/pnpm、PTY 和整 VM 回收均通过实际验证。当前最明显的代价是 Linux 工具链、权限变化所需独立 VM，以及**整个主机文件系统首次写入的全盘配额扫描**。

按我们已经接受的首版 best efforts 范围，受限 Target Folders 的 Linux 任务没有发现必须放弃的隔离缺口。若要求原样执行 Mac 程序，Linux guest 是决定性的兼容边界；若要交付已约定的文件完全访问，目前未验证出可用而无全盘扫描的官方接线。不能把某一次首次写入等待推导成永久不能访问，但也不能把这个模式记为通过。

## 实验结果与未通过项

主要检查 **33 项：30 通过，3 未满足**，由核心 25 项（23/25）与追加 8 项（7/8）组成。定点诊断另外保存，不把“成功复现缺陷”累计为产品验收通过。

| 检查 | 实测事实 |
| --- | --- |
| Apple Silicon 的实际启动 | npm 预编译程序直接启动；无 Docker/VMware、sudo、额外系统配置 |
| 多 Target、own tmp、并发 A/B | 允许所属目录；拒绝 outside、另一 Agent tmp，未串用权限 |
| 文件 API 与普通命令的范围限制 | 均通过；只读 host mount 拒绝 guest root 写入 |
| `[*?]`、空格、Unicode | 按字面路径正确挂载和读写 |
| 符号链接 | outside 内容访问拒绝；新获批 VM 挂载真实目标后可读；rename/delete 操作链接条目 |
| 已有跨范围硬链接 | 仍能影响 outside 同一 inode；是已接受的 v1 限制，不是隔离已解决 |
| 一次批准、后续撤销 | 新 VM 增加 extra Target；下一次基线 VM 拒绝；不是原 VM 权限热修改 |
| 网络 default deny、原始 IP、清空 proxy env | 拒绝；没有以 env 清空绕开边界 |
| 域名、域名 suffix 与严格 HTTPS | 开启 TLS interception 后允许；其它域名拒绝；只配域名而不 interception 会 fail closed |
| 受限 npm 网络下真实 pnpm 安装 | 成功安装 is-number 7.0.0，并 Node assert 验证；不是仅 curl 联通 |
| 允许所有外联、文件仍受限 | 通过；显式 egress allow / ingress deny，不发布端口 |
| 主机文件完全访问 | **未通过**：整个 `/` bind 的首次写入触发全盘元数据扫描 |
| 8 MiB 原始输出、二进制文件流、rename/delete | 字节数和 SHA256 正确，文件结果正确 |
| pipe stdin、PTY、超时、普通后代、兄弟继续运行 | 均通过；超时返回 typed error，随后确认 PID 已消失 |
| 单命令取消主动 detached daemon | **失败**：新 session/process group 中进程继续运行；与 Pi/Codex 相同 |
| 整 VM kill | **通过**：确认 detached heartbeat 仍在更新后 kill VM，更新停止，另一 VM 继续；一次测得 kill 约 62 ms |
| 宿主 SDK 进程退出 | attached VM 停止；没有把其显式 detached 模式当作同样契约 |
| Git init/add/commit/diff | 使用 Linux Git 实际成功，修改落到主机自建 Target |
| `,`、`:` Target Folder 根路径 | 有显式限制；冒号 host 路径改用合法 guest alias 仍拒绝，需提前拒绝并解释；错误与源码还明确限制 `;` |

核心结果：[最终结果](./microsandbox-probe-results.json)、[初次配置结果](./microsandbox-initial-results.json)、[早期根目录等待结果](./microsandbox-root-quota-results.json)。追加结果：[网络/生命周期](./microsandbox-edge-results.json)、[配额/路径诊断](./microsandbox-diagnostic-results.json)。单命令 detached 回收仍未作为我们当前发布硬门槛；现有应用尚没有命令执行工具。

初次结果中的 off+mirror 配置冲突、把 typed timeout 误当非零退出码、metrics disabled 后读取 metrics 都已按正式接口修正；这些是探针配置问题，未计作上游能力缺口。早期根目录 130 秒等待和最终 10 秒 deadline 均保留，不因失败而改小挂载范围。

## 最重要的实际缺口：文件完全访问

`bind("/").statVirtualization("off")` 可以启动，读取自建文件仅约 **2.6 ms**，但第一次写入会同步遍历 host bind root，计算配额 baseline。早期尝试等待 **130.7 秒** 后外部终止该 VM；改为 10 秒有界尝试后仍超时，写入前的自建文件保留。对比自建 **10,000 文件**的普通目录，首次写入约 **28 ms**，第二次约 **2 ms**。这些结果支持挂载范围成本，不支持 APFS 死循环或权限突破的说法。

源码明确：不填 quota 会补 **4096 MiB**；`quota(0)` 是零额度，仍需 baseline。所读公开 TS/Rust Bind 接口没有正式关闭选项，deployment profile 也不绕过默认值。扫描读取目录名、类型和文件大小，不读取内容；不跟随 symlink，无法读取的目录跳过，但同步文件系统调用没有独立 deadline。SDK 文件 API 本身也没有这次操作的 timeout 参数，探针用 host deadline 后显式 kill 整 VM。没有 fork 上游、删失败断言或把更小 Target 当作 full access。[baseline 实现](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/crates/filesystem/lib/backends/passthroughfs/unix/quota.rs)、[默认补全](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/rust/lib/runtime/spawn.rs#L3094)、[源码审计](./microsandbox-source-audit.md)

## 接线仍必须由我们负责

公开 `ModifyOptions` 没有 mounts / outbound network policy；本轮走官方独立 VM API 实现每次权限快照，权限变化不干扰原 VM。缓存镜像后约 0.2–0.3 秒启动，因而不算不可接受的启动时间，但后台服务、环境内安装的软件、会话句柄和各 Agent 的临时目录仍需按 VM 生命周期管理。权限申请/下一次尝试仍由远程模型决定，没有本地自动推断、自动审批或重放。[修改接口](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/src/modify.ts)

`copyFromHost` / `copyToHost` 实测可以读写未挂载的自建 outside，它们是 host 控制面的能力，没有 Target allowlist；必须省略或通过可信 adapter 核验 host 参数。直接 guest fs API 才使用已批准的挂载 namespace。创建挂载、rootfs patch、选择 runtime home 等控制面参数同样不能任由模型提交。[文件复制实现](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/rust/lib/sandbox/fs.rs#L1721)

网络必须显式 deny，默认策略允许 public 网络。严格域名 HTTPS 的 TLS interception 在本轮 Node/npm/pnpm 组合中成功，SDK 自动配置 guest CA；不能据此证明所有语言、证书 pinning 或 Git HTTPS 都兼容。Net full 使用 egress allow / ingress deny；SDK `allowAll()` 还包含 ingress、host/private，语义更宽。系统与工具链位于 Linux guest，不是在 Mac 上放行 `/usr/bin`。[网络模型](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/networking/overview.mdx)

执行/文件 API 没有接管模型客户端或 Agent loop。空账号、清空继承环境的实际执行已通过；我们的模型 HTTP 和多模型 Sub-agent 调度可以继续留在主机。`agentd` 是 guest 命令守护进程。本轮未做完整网络包捕获，不声称整个依赖没有其他 HTTP；OCI 下载和命令网络本就有 HTTP。[独立执行 API](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/sdk/typescript/execution.mdx)

SDK 提供原始 exec/fs，并没有 Pi 的模型工具定义、编辑算法和自动输出截断；`collect` 及内部 stream 通道有无界缓冲，应用需及时消费、限制模型展示并归档。也没有本轮确认的 Codex 内置 apply_patch 等价 API。`stop()` / `stopWithTimeout()` 不隐式强杀，取消必须明确选择 command kill 或 VM kill。[执行源码](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/rust/lib/sandbox/exec.rs)

## 依赖、体积和性能

| 口径 | microsandbox 本机实测 |
| --- | ---: |
| 项目直接新增 npm dependency | **1**：microsandbox 0.7.8 |
| 本机实际 package 目录 | **3**：SDK、types、Darwin arm64 native 包 |
| 全平台 lock / 项目 lock 副本 | **新增 7** 版本条目；原条目无移除，packages/snapshots 各 7 |
| node_modules 磁盘占用 | **89.84 MiB**；原始文件内容 89.20 MiB |
| 裸 msb / firmware / Node addon | 36.08 / 23.65 / 28.71 MiB |
| 两个测试镜像共享 cache | **174.72 MiB**（Node + Alpine） |
| SDK + 两个镜像 cache | **264.56 MiB**，不含单 VM 的写层、日志、DB 或下载器 cache |
| 首次 Alpine 镜像下载、准备与启动 | **2.09 秒**；压缩下载 3.93 MiB |
| 首次 Node 镜像下载、准备与启动 | **3.34 秒**；压缩下载 59.18 MiB |
| 镜像已缓存的新 VM | 约 **0.2–0.3 秒**；多次重复约 202–212 ms |
| 单 VM 内存 | 配置 512 MiB；普通空闲 host resident 样本约 99 MiB，TLS/pnpm 活动后样本约 300 MiB |

安装使用 `--ignore-scripts`，不需 Rust/native 编译；平台程序已含 Hypervisor entitlement，otool 中的系统依赖已有。npm 正常安装带原生运行程序，不是只有一个小 JS 包。镜像 digest、包 integrity、原生 SHA256 与项目 lock 差异保存在[依赖测量](./microsandbox-dependencies.json)。项目 pnpm 副本因新发布包生成临时 minimumReleaseAgeExclude，原项目配置未动。

总存储与 Codex npm 包实测 331.17 MiB 在同一数量级；Codex 裸 binary 235.09 MiB 不要求镜像。不能把 npm SDK 约 90 MiB 单独拿来宣称整体比 Codex 小很多；Node + 工具安装后的每 VM 写层还会增长。稀疏磁盘逻辑容量不是实际占用。

## 选择建议和复现

| 当前需求 | 更合适的选择 |
| --- | --- |
| 本机 Mac 环境、逐请求权限、文件完全访问 | **Codex exec-server**：已通过对应检查，无 VM/镜像/guest 会话管理 |
| 受限 Target 的 Linux 任务，需要独立内核、整环境回收 | **microsandbox** 有真实优势，前提是接受 Linux 工具链 |
| 直接复用模型工具与文本编辑/搜索体验 | Pi 更现成，但其权限 worker/SRT 及依赖成本仍在 |

复现脚本为[核心探针](./microsandbox-probe.mjs)、[追加探针](./microsandbox-edge-probe.mjs)、[定点诊断](./microsandbox-diagnostic-probe.mjs)。参数均为独立 SDK 安装目录与绝对结果文件路径；设置独立 `MSB_HOME`、HOME、TMPDIR 并移除 credentials，启用 local backend。核心/追加保留失败，正常预期退出 1；定点诊断中的 root-write deadline 通过表示缺陷复现，不表示 full access 验收通过。

没有实现项目 tools、审批 UI、权限持久化或 AGENTS 加载；没有测试真实大型项目、长期服务、完整网络捕获、Linux/Windows host 或恶意 VM 逃逸。本轮所有 VM 和自建 fixture 清理，独立 SDK、镜像/包缓存随后清理。v0.7.8 验证不代表未来版本或全部 macOS 版本兼容。
