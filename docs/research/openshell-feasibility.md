# OpenShell 本机实验验证

2026-10-09。固定 **v0.1.3 / `e1f3c82caa3ed3b65de22889ae7ef32a774878ef`**，macOS 26.7.1 ARM64、Node 24.21.0、`kern.hv_support=1`。使用官方预编译 native MicroVM 路线；没有修改应用依赖、运行用户服务或调用模型。

**结论：这版 MicroVM 可以执行命令，但不能通过正式接口持续共享本机 Target Folders，因此不适合直接接入我们当前的本机目录工作流。** 这不是“新建沙箱一定不能接受”，也不是对所有 OpenShell 后端的否定。Docker/Podman 有挂载接口，但属于另一条仍待实测、需要容器引擎的路线；本机现有 Docker CLI 指向的 daemon 不在运行，未启动或安装容器引擎。

## 最关键的真实失败

创建一个主机 `target/sentinel` 文件，传入公开 VM `driver_config` 的 bind mount，API 实际返回：

```text
invalid vm driver_config: unknown field `mounts`,
expected `gpu_device_ids` or `rootfs_tar_path`
```

同时，成功启动的 guest 无法读取该主机文件路径，主机 sentinel 保持 `HOST_TARGET_BEFORE`。这两项区分了“运行 VM”与“直接读写项目目录”，没有把 upload/copy 当成持续共享。

固定源码也明确：`driver_config` 只接受 GPU 和 rootfs tar；`platform_config` 被拒绝；实际 VM 启动接口只连接 root/overlay/image 磁盘与 vsock，没有 host filesystem 接口。参见 [源审计](./openshell-source-audit.md)、[配置解析](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/driver.rs#L119)、[启动接口](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/runtime.rs#L35)。

若采用文件复制进出，就需增加同步、并发修改和覆盖冲突处理；本轮没有实现同步，也不把它记成 Target Folder 需求已通过。

## 实际运行结果

| 验证 | 结果 |
| --- | --- |
| 官方 CLI/Gateway 固定版本、本机 Hypervisor entitlement | 通过；release SHA256 与下载内容一致 |
| 隔离 Gateway、VM driver、临时 DB 和 HOME/XDG | 通过；最终一轮 Gateway ready 约 0.17 秒 |
| 直接 bind 主机 Target Folder | **失败：公开 VM 配置拒绝 mounts** |
| Node Linux 镜像启动、exec 和 guest 文件写入 | 通过；使用 `node:24-bookworm-slim` |
| 主机文件是否自动映射进 guest | 确认未映射；主机文件保持不变 |
| 新实例是否继承旧 VM 的 guest 文件 | 未继承；两个 VM 的 `/sandbox` 内容独立 |
| 明确空网络策略的 HTTPS 拒绝 | 通过；Node fetch 被拒绝 |
| 删除实验 VM、退出 Gateway/driver | 通过；最终进程检查没有本实验进程 |

`node:24-bookworm-slim` 首次镜像准备及创建到可执行约 **15.61 秒**。三次已有镜像缓存的新实例创建分别为 **6.614、6.760、6.614 秒**。这些是实际 CLI create 到 ready 的端到端时间，不是仅 Hypervisor boot 时间；不代表其它镜像、硬件或 SDK 必然相同。新建实例本身可接受，但当前测量并非 microsandbox 的亚秒级创建，而且没有主机目录共享。

初试的 `node:24-alpine` 因缺少 `/bin/bash` 被 runtime 拒绝；这是该镜像不兼容，不能据此说所有 Node/Linux 镜像不能运行。[真实镜像要求](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/rootfs.rs#L593)。初次没有 launch-signing bundle 时创建被拒绝，随后使用独立的 Ed25519 PKCS#8/SPKI 文件配置官方签名接口，创建成功；没有关闭 sandbox launch authentication。

由于核心目录共享门槛已失败，本轮没有继续完整测试批准一次、Project 授权、不同 Agent 的 host scope、真实项目 pnpm/Git、网络热更新、PTY 或 detached 进程取消。不能将上表基础验证等同整个候选通过。

## 依赖和本机占用

native MicroVM 路线不需 Docker、VMware、Rust 编译器或手动安装 Hypervisor.framework，但除了预编译二进制，**仍需 e2fsprogs ≥1.43**。本次在临时目录解包 Homebrew 的 e2fsprogs 1.47.4 bottle，修正该临时副本的动态库路径后使用；没有全局安装。它依赖 gettext，本机已有 gettext 1.0。官方 brew 安装路线会处理这些依赖及路径。[主机工具要求](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/e2fsprogs.rs#L19)。

| 实测项目 | 实际磁盘分配 |
| --- | ---: |
| CLI、Gateway、VM driver 三个 binary | 136.86 MiB |
| 独立 e2fsprogs bottle 解包后的工具和库 | 9.47 MiB |
| 解压的嵌入 VM runtime | 21.98 MiB |
| 删除 VM 后保留的 Node Bookworm rootfs、host supervisor、1 GiB sparse overlay 模板缓存 | 348.72 MiB |
| 上述合计 | **517.03 MiB** |

这个合计不含已有 gettext、SDK、源码、下载归档、npm 下载缓存和日志/DB，也不含存活 VM 的 overlay。1 GiB overlay 是逻辑容量，不是已分配 1 GiB。这里只是测试配置下的占用，不是全平台安装包总量。

若通过 CLI 接入，可不加 npm 运行依赖，仍要管理上述原生运行时。若通过 TS SDK 接入，直接依赖为一个 `@nvidia/openshell-sdk`；其 manifest 声明三项运行库。本轮独立安装验证这三个库的闭包确实只有三个 npm 包：protobuf 2.16.0、Connect 2.2.0、Connect Node 2.2.0，合计约 4.59 MiB；**没有安装或构建 SDK 本体**。

公开 npm registry 查询 SDK 返回 HTTP 404。官方文档规定它发布在 GitHub Packages，需要 `read:packages` token；固定源码生成/build 是备用方式。本轮未使用用户 package token，不能称为官方 SDK 安装通过。[SDK 安装](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/README.md#L12)、[manifest](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/package.json)。

## HTTP、环境和验证边界

执行不要求采用其 Agent 或模型代理；自己的模型 HTTP 可以继续留在原应用。本轮只运行 sleep、Node 和网络拒绝探针，没有调用模型、自动导入 provider 或继承用户 API key。下载 release 和 OCI image 的 HTTP 是执行运行时所需网络，不等同模型调用。

源审计发现官方二进制默认有独立 NVIDIA 遥测。初试只设置了 `OTEL_SDK_DISABLED=true` 且没有 OTLP exporter，**没有关闭独立遥测**；是否发出或送达未捕获，不能声称初试没有额外 HTTP。最终一轮显式设置 `OPENSHELL_TELEMETRY_ENABLED=false` 后重跑；所有核心结果重复一致。正式适配必须固定该设置，不能只关闭 OTLP。[遥测开关](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/observability/telemetry.mdx#L20)。未做全机 packet capture，不能承诺全运行时零隐式 HTTP。

实验使用自己的 loopback Gateway 和临时签名密钥，允许本地匿名 user RPC；sandbox JWT/launch authentication 保留。此实验配置不代表正式应用的批准入口或认证设计。应用的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml 没有变化。

原始证据：[首次前置条件结果](./openshell-initial-results.json)、[Alpine 镜像结果](./openshell-alpine-results.json)、[首次兼容镜像结果](./openshell-first-compatible-results.json)、[最终重复验证](./openshell-probe-results.json)、[依赖清单](./openshell-dependencies.json)、[探针](./openshell-probe.mjs)。探针须自行准备固定 binary、e2fsprogs、签名和配置；不能在已删除的临时路径上直接重跑。

临时 binary、工具副本、SDK 库、镜像/cache、DB 和密钥均在复制证据后删除。没有更改用户 Docker context、启动用户容器或修改其它已有实验的原始证据。
