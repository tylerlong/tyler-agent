# OpenShell v0.1.3 源码审计

审计日期：2026-10-09。固定 release `v0.1.3`、commit `e1f3c82caa3ed3b65de22889ae7ef32a774878ef`。本文件只记录静态源码／官方 release 元数据；没有安装、启动或操作 OpenShell 进程，不把配置示例记为通过实测。目标是接入现有 Agent／Sub-agent 和模型 HTTP，同时直接读写 host Target Folders；新 VM 实例可以用于落实批准后的权限变化。

## 预编译 native macOS 路径

官方 release 提供下列 Apple Silicon 包。release packaging workflow 对每包只归档一个对应 binary，不是必须从源码构建整套项目。[release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.3)、[实际包装](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/.github/workflows/package-release-binaries.yml#L82)。

| 本地组件 | 固定 release asset | 压缩 bytes |
| --- | --- | ---: |
| CLI | `openshell-aarch64-apple-darwin.tar.gz` | 9,450,808 |
| Gateway | `openshell-gateway-aarch64-apple-darwin.tar.gz` | 33,431,517 |
| VM driver | `openshell-driver-vm-aarch64-apple-darwin.tar.gz` | 30,216,186 |

三包合计 73,098,511 bytes（约 69.7 MiB），**不是总安装占用**。还需运行时解压、OCI image／Linux rootfs、每 sandbox 的 ext4 overlay 和 SDK；后者尚未测量。下载 URL 固定为 `https://github.com/NVIDIA/OpenShell/releases/download/v0.1.3/<asset>`；用同 release 的 `openshell-checksums-sha256.txt`、`openshell-gateway-checksums-sha256.txt` 校验适用条目，不能用 latest/main 代替 pin。[release assets](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.3)、[版本化 image 与 overlay](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L199)。

三包**仍需要 host e2fsprogs >=1.43**，不是完全自包含：格式化调用 `mke2fs`／`mkfs.ext4`，访问与修复 ext4 使用 `debugfs`、`e2fsck`。resolver 先找继承的 PATH，再找 `/opt/homebrew/opt/e2fsprogs/{sbin,bin}`、`/usr/local/opt/e2fsprogs/{sbin,bin}`；可以把隔离安装目录放在 gateway 的 PATH，runtime 会继承。这是独立系统依赖，不能算进三包压缩总量，也不代表必须全局 brew install。[真实 formatter](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/rootfs.rs#L655)、[resolver 与最低版本](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/e2fsprogs.rs#L19)、[三个 host tools](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/e2fsprogs.rs#L110)。

VM driver 编译时嵌入 libkrun、libkrunfw、Linux guest sandbox、native host supervisor、guest init、umoci；因此这条路径无需另装 Docker／VMware 或另找 macOS supervisor release 包。首次运行提取嵌入内容，再从 OCI registry 获取 image；这不意味着 rootfs 随三包提供。只有 macOS ARM64 的 VM runtime 嵌入分支；未查到明确 minimum macOS version，不能用 CI macos-15 runner 反推最低要求。[嵌入清单](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/build.rs#L19)、[平台与提取](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/embedded_runtime.rs#L9)、[OCI preparation](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L199)。

release build 会给 macOS driver 做带 Hypervisor entitlement 的 ad-hoc codesign，通常不需自行补签。具体下载件的签名和本机启动能力留给实际探针。VM driver 明确写着 “Status: Experimental. The VM compute driver is under active development.”，不能把 overall support matrix 的 Supported 等同此 driver 已稳定。[签名步骤](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/.github/actions/build-rust-binary/action.yml#L73)、[VM build 参数](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/.github/workflows/build-vm-driver.yml#L39)、[状态声明](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L3)。

提取缓存在 `XDG_DATA_HOME/openshell/vm-runtime/<version>`；清理函数会删除同 cache base 的其他版本目录。实验应设置独立 `XDG_DATA_HOME`，并隔离 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`、gateway DB、VM state_dir，避免改现有安装。AF_UNIX socket 路径较短的 `/tmp/...` state_dir 更合适。[真实 cache／清理](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/embedded_runtime.rs#L131)、[socket 路径说明](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L63)。

## Host Target Folder：native VM 接口缺口

固定版本的公开 VM `driver_config` 使用 `deny_unknown_fields`，完整字段只有 `gpu_device_ids` 和 `rootfs_tar_path`。额外的 `mounts`／`bind` 字段会在该解析器被拒绝，而不是传进 libkrun。VM `create_sandbox` 先调用校验；另一可能入口 `template.platform_config` 又被明确拒绝，错误文本为 `vm sandboxes do not support template.platform_config`。[实际配置 parser](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/driver.rs#L119)、[create 校验](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/driver.rs#L1094)、[platform_config 拒绝](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/driver.rs#L4956)。

这不只是一处文档遗漏：真实 `VmLaunchConfig` 没有 host mount 参数；`run_libkrun_vm` 只设置 root／overlay／image 磁盘、command／env 与 vsock。FFI 加载列表没有 virtiofs 或 host root 共享函数。**已读固定版本的正式创建及启动接口不提供持续 host bind**；不宣称未来版本、插件或自定义 fork 永远无法做到。[完整 launch shape](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/runtime.rs#L35)、[实际 launch](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/runtime.rs#L323)、[FFI surface](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/src/ffi.rs#L61)。

`rootfs_tar_path` 是 gateway 分配的私有 archive upload slot，用于准备 image；CLI `--upload` 是复制文件进去。guest `/sandbox` 写入 VM 的 overlay.ext4。它们都不证明 host Target Folder 会随 guest 修改持续同步；若需要自己做 copy-back／冲突处理，那是另一种方案和额外实现，不能记为当前要求通过。[staging RPC](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/proto/openshell.proto#L60)、[CLI upload](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-cli/src/main.rs#L1457)、[guest 写入位置](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L226)。

## Docker fallback 的确存在 bind 接口

Docker 配置明确有 `mounts: [{type:"bind", source:<absolute host path>, target:<guest path>, read_only:false}]`。operator 需配置 `[openshell.drivers.docker] allow_driver_config=true, enable_bind_mounts=true` 和 `[openshell.drivers.docker.resource_admission] enabled=false`；bind 不能被 label admission，因此启用 admission 时会被拒绝。关闭此 attachment admission 不等同自动关闭 guest filesystem policy；我们的可信 adapter 仍须限制模型可请求的 host source 和 guest policy。[真实 mount enum](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-docker/src/lib.rs#L718)、[admission 拒绝](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-docker/src/lib.rs#L1056)、[官方配置](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/sandboxes/runtimes.mdx#L139)。

SDK 可通过 `rawSpec: {template: {image, driverConfig: {docker: {mounts:[...]}}}}` 传递 driver envelope；`rawSpec` 是 shallow override，会覆盖整个 assembled template，因此要自己包含 image。文件 policy 同时使用实际 guest 路径。macOS fallback 还要可工作的 Docker／Podman Linux 环境，不能把 native VM 成功启动当作已验证 Docker host 路径共享。[真实 SDK assembly](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/src/client.ts#L1020)、[driver envelope](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/proto/openshell.proto#L1098)、[runtime 选择](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/sandboxes/runtimes.mdx)。

Bind 的真实 Docker 请求最后使用 legacy `source:target[:opts]` 字符串，并检查 source 存在。host source 校验只要求非空、无 surrounding whitespace／NUL、绝对路径，没有 canonical containment。因此 adapter 需要校验真实路径和授权来源；含冒号的合法 host 文件名需要单测，不能因输入 JSON 而宣称全部字面路径都支持。[真实 bind 构造](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-docker/src/lib.rs#L3754)、[source validation](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/driver_mounts.rs#L34)。

## 最小 gateway／exec 配置依据

下例是源码认可的 native VM 参数形状，路径、port、image 必须替换为实验值；**没有 host bind**。独立 XDG 环境应由探针传给进程。[官方手动启动](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-driver-vm/README.md#L127)、[真实 gateway flags](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-server/src/cli.rs#L72)。

**Launch signing 是 VM create 的前置要求，plaintext listener ready 不代表能创建 VM。** 推荐先运行 `openshell-gateway generate-certs --output-dir /absolute/probe/tls`，不用 `--dry-run`（会打印 PEM），再令 gateway 发现 `OPENSHELL_LOCAL_TLS_DIR=/absolute/probe/tls`。该 local mode 不需要 Kubernetes，会写 `jwt/signing.pem`、`jwt/public.pem`、`jwt/kid` 并向独立 XDG_CONFIG_HOME 复制 CLI client 材料。密钥算法 EdDSA／Ed25519，私钥 PKCS#8 PEM，公钥 SPKI PEM；官方 kid 是 public DER SHA256 的前16 bytes hex。也可显式 `[openshell.gateway.gateway_jwt]` 配置 `signing_key_path`、`public_key_path`、`kid_path`、`gateway_id`；listener TLS keys 不能代替这些。[local generation](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-server/src/certgen.rs#L123)、[key generation](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-bootstrap/src/jwt.rs#L23)、[配置／发现／前置拦截](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/gateways/configuration.mdx#L310)。

```toml
[openshell]
version = 2
[openshell.gateway]
compute_driver = "vm"
disable_tls = true
[openshell.gateway.auth]
allow_unauthenticated_users = true
[openshell.drivers.vm]
driver_dir = "/absolute/probe/bin"
state_dir = "/tmp/tyler-agent/openshell-probe/vm"
grpc_endpoint = "http://127.0.0.1:18091"
default_image = "<fixed-compatible-OCI-image>"
vcpus = 2
mem_mib = 2048
```

```sh
openshell-gateway generate-certs --output-dir /absolute/probe/tls
OPENSHELL_LOCAL_TLS_DIR=/absolute/probe/tls OPENSHELL_TELEMETRY_ENABLED=false openshell-gateway --config /absolute/probe/gateway.toml --compute-driver vm --disable-tls --bind-address 127.0.0.1 --port 18091 --db-url 'sqlite:/absolute/probe/gateway.db?mode=rwc'
openshell gateway add http://127.0.0.1:18091 --local --name os-probe
openshell --gateway os-probe sandbox create --name vm-probe --from '<fixed-compatible-OCI-image>' --detach --no-auto-providers -- /bin/sh -c 'sleep 3600'
openshell --gateway os-probe sandbox exec vm-probe --timeout 10 --no-tty --no-login-shell -- /bin/sh -c 'printf hello'
```

`create --detach` 保留 canonical main；`exec` 的 positional sandbox、`--timeout`、`--workdir`、`--no-tty`、`--no-login-shell` 是真实 CLI flags。示例 command 只是保持 VM 可供 exec，不调用模型／provider。plaintext gateway 只用于隔离的 loopback 实验，正式集成另选认证。[create 参数](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-cli/src/main.rs#L1439)、[detach](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-cli/src/main.rs#L1556)、[exec 参数](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-cli/src/main.rs#L1704)。

示例的 `auth.allow_unauthenticated_users=true` 只让隔离 loopback probe 的用户 CLI／SDK 无需 OIDC／mTLS；supervisor 仍使用 gateway-minted sandbox JWT。这个 dev escape hatch 不应未经决定直接进入应用正式默认配置。[真实 auth 语义](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/gateways/configuration.mdx#L318)。

## SDK、模型 HTTP、权限变化与遥测

`@nvidia/openshell-sdk` 当前发布到 **GitHub Packages**，official install 要 `@nvidia:registry=https://npm.pkg.github.com` 和 `read:packages` token。源码 manifest 的 `0.0.0` 是 placeholder：release workflow 计算 npm version 并传给 publish task，task 临时 stamp 后 publish，因此与 gateway 对齐应请求 `0.1.3`，不能安装无版本 latest 冒充固定验证；实际 package 读取性仍未测试。[manifest](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/package.json#L1)、[安装](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/README.md#L12)、[release publish](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/.github/workflows/release-tag.yml#L851)、[version stamp](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/tasks/typescript.toml#L78)。

SDK 要 Node >=20.3；3 个直接 runtime dependencies 是 `@bufbuild/protobuf`、`@connectrpc/connect`、`@connectrpc/connect-node`，devDependencies 不应计为运行依赖。没有 package token 时可在固定源码中 `npm ci; npm run gen; npm run build` 后使用 dist，codegen 需要 repo 根 `proto/`、`buf.yaml` 和固定 Google API Buf module；这是 build fallback，不是已验证的 registry install，也没有计算完整依赖 closure。[manifest](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/package.json#L32)、[codegen inputs](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/buf.gen.yaml)、[build task](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/tasks/typescript.toml#L50)。

SDK 的 create／execStream／execInteractive 是独立 gateway transport，没有 mandatory 模型调用或 agent harness；client create 默认 `providers: []`。我们可把模型 HTTP 留在原应用。`execInteractive.cancel()` 是取消 RPC，不能静态推断其回收全部 detached descendants；整 sandbox lifecycle 另测。[SDK execution](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/README.md#L118)、[create defaults](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/sdk/typescript/src/client.ts#L1026)。

Filesystem grant／revoke 需要重新创建 sandbox；network 可热更新，但更新会关闭旧规则下的 keepalive、tunnel、WebSocket、long stream。这不是自动 deal breaker：模型在批准后请求新的执行实例即可，需测初始化成本、工作文件延续和后台服务影响。Advisor 默认关闭；审批自动模式是 opt-in，批准后 Agent 重试，不强迫应用接管模型决策。[真实权限行为](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/policies/manage-policies.mdx)、[advisor](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/how-it-works/policies/advisor.mdx)。

官方预编译 telemetry 默认开启，真实 core 默认 endpoint 是 NVIDIA telemetry HTTP；必须传 `OPENSHELL_TELEMETRY_ENABLED=false`，官方说明 gateway 会将关闭设置传给 sandbox supervisor。另不要配置 OTLP exporter；下载 image、用户命令网络、模型 HTTP、运行遥测需要分开记账。本次没有包捕获，不能声称整个依赖零隐式 HTTP。[真实 telemetry 默认与 endpoint](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/telemetry.rs#L27)、[env 判定](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-core/src/telemetry.rs#L293)、[关闭说明](https://github.com/NVIDIA/OpenShell/blob/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/docs/observability/telemetry.mdx#L20)。

## 实测门槛

- **Native VM 直接操作 host Target Folders：接口缺口已明确。** 优先用真实 create 对未知 mounts／platform config 做负向验证；VM 启动与 guest 文件读写不能替代 host 双向可见性断言。
- **Docker fallback：有正式接口，但本机 engine、host sharing、Linux guest policy、特殊路径和系统权限需验证。** 若未具备 engine，记录平台前提，不为通过实验偷偷安装 Docker 或改变文件语义。
- **SDK 获取：官方 registry 需要 package token；源码 build 是明确的备用路线。** 两者要标清，不把源码构建当成公开 npm 安装成功。
- **尚无实测证明** boot／重建成本、取消 detached／整 sandbox cleanup、literal 多 Target 的隔离、domain full 模式、TLS／Node／pnpm／Git 兼容及依赖总占用；这些由独立探针／结果报告补齐。本审计未运行 runtime，也未调用付费模型。
