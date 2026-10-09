# 执行后端下一轮候选精筛

2026-10-09。本轮只检查官方文档和固定版本源码，没有安装、运行新候选或调用模型。基线是已经实际验证的 [Codex exec-server](codex-exec-server-feasibility.md)，保留自己的模型 HTTP、Agent/Sub-agent 调度及审批决策。

实验前的初筛优先安排 microsandbox，理由是它有机会在隔离边界和整个执行环境的回收上超过 exec-server；当时并未证明 OpenShell 不适合我们。2026-10-09 的 OpenShell 聚焦实测也已完成：native MicroVM 能运行，但正式接口不支持持续共享主机 Target Folders；Docker 路线仍未实测。详见 [OpenShell 本机实验](./openshell-feasibility.md)。OpenSandbox 暂不优先。

后续实测已完成，见 [microsandbox 深度验证](./microsandbox-feasibility.md)。目录与网络隔离、Linux 工具链、整 VM 回收验证成功；挂载 `/` 的全盘配额扫描属于一种文件完全访问实现，不是普通 Target Folder 模式的问题，不能据此淘汰受限目录方案。当前仍推荐已经通过本机实测的 Codex exec-server。本文件保留实验前的初筛依据，并记录复核结论。

| 候选、固定版本 | 最可能超过 exec-server 的地方 | 当前项目的主要代价 | 下一步 |
|---|---|---|---|
| microsandbox 0.7.8；`7b7b9dc89e9a1c77801918f7833c3381d1754579` | 独立 Linux 内核；显式终止整台 VM 可能回收 detached 后台进程 | Linux 工具链、镜像/rootfs，以及审批后权限变化的生命周期 | 唯一优先实验 |
| NVIDIA OpenShell 0.1.3；`e1f3c82caa3ed3b65de22889ae7ef32a774878ef` | 网络权限热更新；按程序、HTTP 方法/路径授权，隔离服务凭据 | Native MicroVM 不提供主机目录共享；Gateway/runtime/镜像 | Native 路线核心门槛失败；Docker 尚未测 |
| OpenSandbox 1.1.1；`531700ca18a7fa5fab6a2f25d6dc68a76eddab12` | 完整沙箱服务、后台命令、PTY、文件 API 与集群扩展 | Python 服务、Docker/其他后端、execd/egress；本机接线更重 | 暂不优先 |

## microsandbox：有明确胜出方向，但尚未通过我们的验证

它可作为独立执行后端使用：TypeScript API 提供命令、流式输出和文件操作，不要求采用其 Agent 或模型客户端。macOS Apple Silicon 使用硬件虚拟化，执行环境具有独立 Linux 内核；主机目录和文件可显式 bind 到 guest，分别设置读写权限。[执行 API](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/sdk/typescript/execution.mdx)、[SDK 运行要求](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/README.md)、[挂载](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/sandboxes/volumes.mdx)。

**最有价值的待验证推论**：每个权限范围使用独立 VM，取消全部工作时显式 kill 该 VM，可能同时消除其中主动脱离进程组的后台程序。不能把这当成已经解决：SDK 的 `stop()` 可以无限等待正常退出，不会隐式强杀；另有明确的 `kill()`/`killWithTimeout()`。也不能把整个 VM 的终止等同于只取消其中一条命令而保留其他服务。[生命周期源码](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/src/sandbox.ts#L614)。

最关键的适配风险是权限变化。当前公开 TS `ModifyOptions` 和 Sandbox 接口中尚未看到审批后热增挂载或修改 outbound policy 的方法；这不证明完整 runtime 绝不支持。实验必须验证每次新授权能否创建独立执行实例，以及启动成本、已运行服务和状态如何处理。[修改接口](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/src/modify.ts)、[Sandbox 接口](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/src/sandbox.ts)。

网络也需要实测：默认严格 hostname 策略下，仅允许域名但不启用 TLS interception 的 HTTPS 连接会被拒绝，需要配置 interception 或关闭严格检查；证书及 Node/pnpm/Git 兼容性不能靠功能列表推定。`NetworkPolicy.allowAll()` 包含私网，与默认 public profile 不同。[网络模型](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/networking/overview.mdx)、[TS 网络配置](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/sdk/typescript/networking.mdx)。

我们新增的直接 npm 依赖可为一个 `microsandbox`；其 manifest 只有一个普通依赖 `@microsandbox/types`，以及五个平台 optional native 包，其中本机需 Darwin ARM64 包。要求 Node ≥22；不是五个平台都在本机安装。没有测完整传递闭包、安装体积或 rootfs/cache 成本，不能据此说总开销比 exec-server 小。[发布 manifest](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/package.json)。

macOS 不需要另外安装 Docker、VMware 或手动启用虚拟化功能：官方支持 Apple Silicon，使用系统提供的 hypervisor。普通 npm 安装的 Darwin ARM64 包已包含 native addon、`msb` 和 `libkrunfw`，打包时已经给 `msb` 签上 Hypervisor entitlement；创建沙箱只解析已有 runtime，不会隐式下载 runtime，另行 provision 的 helper 是可选路径。首次使用未缓存的 OCI image 仍会拉取镜像并建立 Linux rootfs，所以有 VM runtime、guest kernel 和 rootfs 的存储成本；普通用户安装/运行路径没有 sudo 步骤。这些固定版本说明未明确承诺最低 macOS 版本，不能据构建机器版本推定兼容范围。[系统要求](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/troubleshooting/macos.mdx)、[平台包内容](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/npm/darwin-arm64/package.json)、[打包签名](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/sdk/node-ts/scripts/prepare-platform-package.mjs#L114)、[runtime 解析](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/sdk/setup.mdx)、[首次启动](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/docs/getting-started/quickstart.mdx#L178)、[用户目录安装](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/scripts/install.sh)。

Linux guest 是实质取舍：项目文件可共享，但现有 macOS 可执行文件及本机工具链不能直接作为 Linux 程序复用。如果必须原样使用本机开发环境，exec-server 更合适。三个候选均使用 Apache-2.0。[microsandbox 许可证](https://github.com/superradcompany/microsandbox/blob/7b7b9dc89e9a1c77801918f7833c3381d1754579/LICENSE)。

## OpenShell：native MicroVM 不满足主机 Target Folders 要求

实际 native 创建请求拒绝 `mounts`；成功启动的 guest 也不能访问主机 target/sentinel。Node Bookworm 首次镜像准备和创建约 15.61 秒，缓存后的三次新实例约 6.61–6.76 秒；测试配置 runtime+工具+保留缓存约 517.03 MiB，另计已有 gettext 和可选 SDK。核心门槛未通过，因此未做完整审批/并发 host scope/取消套件；这不否定另有挂载接口的 Docker/Podman 后端。[实际验证与证据](./openshell-feasibility.md)。下文保留实验前的静态评估。

可以独立调用 SDK `sandbox.exec`/交互执行，不需要替换 Agent。它支持 Docker、Podman、Kubernetes 和 libkrun MicroVM，后者在 macOS 使用 Hypervisor.framework；workload 仍为 Linux OCI。还包含 gateway、可信 supervisor 和 sandbox runtime，不能只按一个 SDK 包估算运行成本。[SDK](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/README.md)、[支持矩阵](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/about/support-matrix.mdx)。

其强项是按 binary、域名和 HTTP method/path 实施网络规则及 endpoint-bound 凭据；我们可以保留主机侧自己的模型 HTTP。但文件权限在启动时落实：新增路径写进 stored policy 不会扩展运行中进程的 Landlock 权限，移除路径会被拒绝，文档要求重新创建沙箱。相比 exec-server 每请求权限，这会增加我们并发 scope 和批准一次的接线。[网络策略](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/policies/schema.mdx)、[真实校验代码](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-server/src/grpc/validation.rs#L1033)、[变更流程](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/policies/manage-policies.mdx)。

不能据其进程管理文档认定 detached 命令取消已经胜过 Codex，本轮没有运行该验证。TS SDK 有三个直接运行依赖（protobuf、Connect、Connect Node）；有 patch 兼容性政策，但 Experimental 接口仍可能在 patch 中变化。[进程源码](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-sandbox/src/process.rs#L797)、[manifest](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/package.json)、[版本承诺](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/about/support-matrix.mdx)。

2026-10-09 复核：网络规则可在运行中增减，这是相对当前 microsandbox 公共 TS 接口的优势；生效时会关闭旧规则下的连接，包括 keep-alive、WebSocket 和长流，所以需要验证后台服务兼容性。文件授权不能热更新，但新建具有对应权限的执行实例可能满足批准一次和 Project 长期授权；需实测启动成本、共享文件及并发 scope，不能直接把“需重建”判为不支持动态授权。[策略生效行为](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/policies/manage-policies.mdx#how-changes-take-effect)。

聚焦实验应先测：不依赖 Docker 的 macOS MicroVM 最小启动；多个 Target Folder 和私有临时目录的真实主机挂载；批准一次、新命令撤销、并发 Agent 权限不串用；基础 Node/pnpm/Git 和网络增减。保留主机侧自己的 Agent、模型 HTTP 和审批 UI，仅调用独立执行 API。再测完整安装体积、冷热启动、PTY、输出和取消。当前只能确认组件及接口需求，未测传递依赖、镜像大小或资源成本，不能把“SDK 三个直接依赖”等同于完整接入成本。

进一步静态核对发现，VM driver 自己的 README 明确标为 Experimental；它用缓存的 ext4 镜像和每个沙箱的 overlay disk 保存文件。公开 `VmSandboxDriverConfig` 只有 `gpu_device_ids` 和 `rootfs_tar_path`，且使用 `deny_unknown_fields`；通过该接口传 `mounts`/bind 配置会被拒绝。这证明该配置接口没有 host bind，并不证明所有路径都不可能支持共享；目前没有找到另一条公开接口。因此应把主机目录直接共享列为最先核实的门槛，避免未确认这项就开始完整性能实验。若只能复制进出，需要额外同步；若改选 Docker，则应重新计入其依赖和本机挂载限制。[VM 驱动状态和存储](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md)、[公开配置解析](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/driver.rs#L119-L149)。

用户确认：如果新建沙箱足够快，授权后新建实例可以接受。该生命周期方式本身不是阻塞项；是否合适应由缓存后启动时间、状态处理及并发授权的实测结果判断。

## OpenSandbox：更适合将来多机器的执行平台

原 Alibaba 仓库目前重定向到 `opensandbox-group/OpenSandbox`。它的独立 execd 提供 command、background、PTY、文件 API；本地参考路径需要 Python lifecycle 服务与 Docker，网络限制再使用 egress 侧车。我们的模型客户端可以继续留在主机，原始执行 API 不要求模型代理。[项目与要求](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/README.md)、[execd](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/docs/architecture/data-plane/execd.md)、[网络侧车](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/docs/architecture/network/egress.md)。

多个 host volumes 可以在创建时指定并带 RO/RW；发布的 lifecycle API 有动态 networkpolicy 更新，但未见运行中新增 host bind 的同等接口。因此不能宣称每请求权限已与 Codex 对等。普通命令取消仍向原 process group 发 SIGKILL；它另有 Linux isolated sessions，但这条路径尚未实测。[挂载实现](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/server/opensandbox_server/services/docker/volumes.py)、[生命周期协议](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/specs/sandbox-lifecycle.yml)、[普通取消](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/components/execd/pkg/runtime/command.go#L315)。

TS SDK 的三个直接运行依赖为 OpenTelemetry API、openapi-fetch、undici；这不包括 Python 服务、Docker 和镜像成本。公开执行协议有部分未覆盖扩展（例如 PTY）。它的优势是完整多机器平台，并未证明对当前单用户本机项目有更省事的路线。[manifest](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/sdks/sandbox/javascript/package.json)、[协议覆盖说明](https://github.com/opensandbox-group/OpenSandbox/blob/531700ca18a7fa5fab6a2f25d6dc68a76eddab12/docs/architecture/data-plane/execd.md)。

## 下一轮实验的决策标准

复用现有权限探针，只增加 microsandbox 的真实适配：多 Target/临时目录隔离、并发 scope、批准一次后下一命令撤销、实际 pnpm/Git、HTTPS、超时/PTY、detached 后台进程与 VM kill。测冷启动、权限变化需要的新实例和完整安装成本。它必须以真实结果抵消 Linux 工具链和权限变更成本，才有理由取代当前推荐的 exec-server。
