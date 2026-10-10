# 本地工具的首版执行与授权边界

实施规格见 [GitHub issue #145](https://github.com/tylerlong/tyler-agent/issues/145)。以下为已确认的完整设计。#146／#147 已交付受限命令、原生读取与 patch 和持久输出；#148／#149／#150 已交付审批、项目授权与独立访问模式；#151 保留中断事实并验证受控清理。

命令工具的权限隔离覆盖它启动的进程及其后代；用户独立启动的 watcher 等外部进程由用户的运行环境负责。首版面向 Tyler 单人本机使用，以 best efforts 限制命令的文件操作范围，不以消除全部隔离边界问题为交付前提，也不承诺范围外数据绝不会受到影响。

临时工作目录以 `/tmp/tyler-agent/` 为父目录，由运行时为每个 Agent 分配独立子目录，例如 `/tmp/tyler-agent/<agent-id>/`；命令的临时目录许可只授予所属 Agent 的子目录，避免并行任务互相覆盖。运行时把实际绝对路径发送给模型，并为命令设置相应的临时目录和缓存环境变量。`AGENTS.md` 加载留待以后支持，不属于本次命令工具的交付范围。

文件工具与命令工具采用同一份文件授权范围：当前项目的 Target Folders、所属 Agent 的临时工作目录、项目授权及该次调用获准的额外范围，不自动授权其他 Agent 的临时目录。Chat 文件访问模式同样作用于两类工具；批准额外目录后，两类工具均可使用获准的访问权限。优先采用 exec-server 的文件与沙箱能力，不要求保留原有 Node 文件工具的算法和接口。

首版不由应用自行清理临时工作目录，交给当前 macOS 的 `/tmp` 系统清理机制回收旧内容。临时目录不保证保留时长或回收期限，不作为长期成果存储；需要保存的内容应移到 Target Folders。应用需要临时目录时应确保它存在，不能假定此前创建的目录一直保留。当前系统清理机制的核查依据记录于研究笔记，不把具体系统清理阈值视为应用契约。

文件受限模式下，Target Folders 必须按字面目录路径授权。首版所用后端无法安全按字面路径授权任一 Target Folder 时，拒绝该次工具执行，并向模型返回明确原因；以后后端支持字面路径后再开放这些目录。

首版保留符号链接的正常使用，写入由沙箱按实际目标权限判断，指向未授权位置时拒绝写入。已有硬链接保留正常行为，接受目标范围内写入可能改变范围外同一 inode 内容的已知限制，首版不额外处理已有跨范围硬链接；这体现 best efforts 的取舍，不代表已解决该限制。

文件受限模式下，Target Folders 和所属 Agent 的临时工作目录可读写；运行命令所必需的系统与工具链路径只读，其他用户文件默认禁止读取，需要时申请额外权限。具体只读例外需通过真实工具链实验确认，不能沿用库默认的无限制读取并视为满足此规则。

额外权限申请集成在本地文件与命令工具中，由本地运行时展示审批并等待用户决定；首版不增加独立的 `prompt_for_approval` 工具。用户可以拒绝、允许这次或始终允许当前 Project；允许这次绑定该次工具操作及参数、命令的工作目录和额外访问范围，始终允许则把获准的额外访问权限保存为项目授权，在后续工具调用中复用并在服务重启后保留。项目授权供该项目现有及未来的所有 Chat、主 Agent 和子 Agent 共用；其他 Project 各自授权。授权保持具体访问范围和权限类型，不解除沙箱。

待审批申请保留在所属 Tool Call 卡片，并提供统一入口显示数量与所属 Project、Chat 和 Agent，便于处理后台子任务和其他 Chat 的申请；新申请不自动切换当前页面。申请一直等待用户批准、拒绝或任务取消，不设置审批超时。关闭浏览器不取消申请，服务仍运行时重新打开可继续处理；命令执行超时从实际启动执行开始计算。

每批准一项申请，就重新检查其余待审批申请是否仍需要用户决定。重新按当前授权匹配：完全覆盖的申请结束等待并按原工具参数执行，部分覆盖的申请仅展示仍需批准的需求。项目授权或 Chat 模式改变后同样重检。只对本次有效的批准仍只属于原 Tool Call；已拒绝、取消、执行过或因服务重启中断的调用不因重检而重新执行。重检是本地对既有权限的匹配，不新增模型调用或代替模型决定重试。

权限申请与后续处理由远程模型主导：模型在新的工具调用中明确提出额外访问范围和理由，本地仅校验参数及用户授权、展示执行前审批、落实权限并返回实际结果。文件或网络访问在执行中被拒绝时，本地记录可获得的拒绝信息和目的路径／域名，并与输出、退出码等事实一并返回；不自动发起审批、扩大权限、重新执行工具或等待批准后恢复连接。远程模型决定是否申请额外权限、重试、换操作或结束任务；本地必须继续执行用户授权边界，不以模型自行判断代替权限检查。

审批与影响授权的配置写入由用户管理入口控制，工具启动的进程不能通过本机 HTTP 自行批准或扩权。现有 Host／Origin 校验只能提供网页来源保护，不能仅凭原生客户端可自填的字段认定用户批准；接入只补此边界所需的最小保护，不扩展为通用账号系统，也不承诺防御已获文件完全访问的恶意同账号进程。

项目授权的管理入口放在 Project Edit。用户可以查看、添加、修改和删除额外访问权限；审批中的“始终允许当前 Project”与该入口管理的是同一份项目授权，首版仅保留 Project 这一个持久授权层级。

Project Edit 中保存的权限修改／撤销作用于后续启动的工具调用，已运行的调用保持启动时获准的权限，避免配置编辑意外中断任务；需要立即停止时，由用户取消执行。工具执行前读取所属项目的最新授权，为该次执行确定权限。

网络受限模式下，未获授权域名默认禁止访问，需要时申请具体域名的访问权限，并使用同一套一次批准／持久项目授权。持久域名权限在 Project Edit 中管理；域名授权允许向对应地址发送和接收数据，不表达仅下载的保证。

网络受限模式沿用上游默认的本机／私网保护及禁止端口监听行为。需要启动依赖 localhost 的测试服务时，模型可明确申请上游本机网络能力，批准后使用 `allowLocalBinding:true`，支持这次或始终允许当前 Project。该能力沿用上游范围，包括 loopback 直连及解除代理的私网地址检查，不另行实现按端口隔离。

工具访问模式按文件与网络分别设置，两项各为受限／完全访问。全局默认两项均受限，只在创建新 Chat 时初始化其实际选项；Chat 独立保存和修改这两项，不提供“继承全局”选项。修改全局默认不改变已有 Chat。这与现有模型及思考强度的对话选项用法一致，不增加 Project 级模式覆盖；Project Edit 继续管理受限模式下的具体额外授权。首版不增加自动安全审批模式。

文件完全访问取消本地工具的应用文件范围限制与额外文件审批，仍受服务 OS 账号及系统权限约束，不自动提权。网络完全访问使用 exec-server 原生 `network:"enabled"`，不设置受管网络代理，允许公网、本机、局域网及测试服务监听；文件权限仍独立限制。这取代此前以 `domains:{"*":"allow"}` 表达网络完全访问的选择：wildcard 不解除受管代理的本机／私网保护，代理的 HTTP 方法模式 `full` 也不等于原生完整网络权限。

2026-10-09 选择 Codex exec-server 作为本地执行后端，验证基线为官方 CLI 0.162.0。只使用独立文件／进程执行协议，保留自己的 Agent、Sub-agent、模型选择、HTTP 记录和远程模型决策；不采用 Codex 的 Agent loop。它在同一服务中支持每次请求的权限快照，减少并发 Agent 的权限接线，且可复用内置 patch。对比依据见 [Codex 验证](../research/codex-exec-server-feasibility.md)、[Pi 验证](../research/pi-sandbox-feasibility.md)及 [OpenShell 验证](../research/openshell-feasibility.md)。接入优先沿用上游协议、文件能力和进程生命周期，以本项目底线和已确认的授权范围为边界，不为兼容旧工具设计改写上游。

首版默认沿用上游行为，只有落实上述已确认的权限范围，或解决真实安装、构建、测试、Git 命令失败时才调整配置。exec-server 省略 sandbox 会无沙箱执行，因此仍须显式传入项目范围和授权快照；已有实验确认的共享 tmp、元数据目录和本机工具链配置属于必要接线。除此之外不预先扩展特殊场景，不自行实现额外网络隔离、后台进程回收或通用工具链探测，遇到实际问题后再处理。

首版一并替换现有文件工具；允许调整原有七个工具的名称、参数和结果格式。优先复用 exec-server 文件能力、Codex 内置 `apply_patch` 和搜索命令，只补模型需要的适配，不以复刻旧接口为目标。Agent／Sub-agent 工具及模型 HTTP 通信路径继续由本项目提供。

最小模型接口为 `exec_command`、`read_file`、`apply_patch` 和 `read_tool_output`。搜索、列目录、复制及目录移动／删除使用命令；文件创建和文本修改使用内置 patch，不另保留旧七工具或暴露整套 RPC。读取文件使用原生分块读取，每个句柄只属于本次 Tool Call，结束时关闭；后续调用重新打开并应用最新权限。FS 没有通用取消 RPC，取消读取时停止继续取块，结清在途请求并关闭句柄，不声称能够撤销已经发生的效果。模型续读命令输出限于自己的 Tool Call，用户仍可从任务界面查看主／子 Agent 的记录。

首版命令等待执行完成再返回 Tool Result，支持执行超时与取消；不同 Agent 的命令仍可并发。先覆盖安装、构建、测试和 Git 等普通开发命令；交互 PTY、stdin 输入及长期后台会话留待以后。命令完成以 exec-server 的输出关闭通知为准，不能仅收到退出通知就丢掉尾部输出。取消沿用上游受控进程生命周期；不把故意脱离进程组的任意后台进程全部回收作为首版交付前提。

实际收到的完整命令输出归属该次 Tool Call 并持久保存；取消、超时或失败均保留已有输出、退出状态及实际错误。返回模型的 Tool Result 有长度上限，并提供继续读取剩余输出的能力。首版使用工具调用卡片及日志查看，不实现终端模拟器。exec-server 的临时输出回放不能代替应用持久记录；执行后端崩溃或服务重启不自动重放工具调用。

命令运行期间，用户可以查看已经持久保存的 stdout／stderr，并手动刷新；首版不增加自动实时刷新。此查看不改变模型等待工具结束的流程，不产生额外模型 HTTP 请求。

exec-server 的原始 RPC 不作为模型工具直接暴露。可信适配层根据应用中的 Agent／Project／Chat、用户授权和该次 Tool Call 构造权限；模型不能自行提交原始 sandbox 策略或操作其他 Agent 的进程句柄。协议仍是实验接口，固定依赖及协议基线；运行时使用独立配置目录、关闭遥测并过滤继承环境。文件范围的默认共享 tmp 与 Target 元数据保护须按已有实测修正，不能依赖上游默认设置代表我们的范围规则。

实现使用官方 `@openai/codex@0.162.0` 包和一个常驻 stdio 执行器，不引入另一个模型 SDK、Agent 框架或上游 fork。请求、进程及文件句柄在可信层绑定本地 Tool Call；命令输出通知持续归档，上游连接断开时记录中断与已有事实，不恢复旧句柄或自动重放操作。所有获准读写目录均须落实整目录权限，包括 Target Folders、所属 Agent 临时目录和额外写入授权，不能只为 Target Folders 修正元数据保护。

这取代 [ADR 0003](./0003-structured-file-tools.md) 中避免 shell、仅以 Target Folders 授权、固定七个文件工具及其具体接口实现的选择。旧工具的分页、唯一文本替换、移动碰撞及进程内锁等具体契约不成为新接口的兼容要求；新工具沿用其明确记录的能力与限制。工具结果仍须报告真实效果，不承诺修改回滚。四个本地执行工具与拒绝／仅本次审批已接入；访问模式和持久项目授权已接入。

## #146 交付范围

官方 `@openai/codex@0.162.0` 常驻 stdio exec-server 已通过应用模型／工具循环提供 `exec_command` 与 `read_tool_output`。首个受限策略支持 macOS；不支持的系统明确返回执行错误，不以无沙箱执行代替。命令预算为实际启动起算的 1–3,600,000 毫秒整数，完成等待输出关闭；stdout／stderr 逐块持久保存顺序，模型页面最多 16,000 字符，续读只允许所属 Agent。用户沿用工具卡片查看、手动刷新主／子任务日志，不新增模型请求。

当前策略仅使用最新字面 Target Folders、所属 Agent 独立 scratch 和必要只读工具链范围，网络默认禁止。#147 已替换旧文件工具，历史接口不构成兼容要求。审批、Project Grant、Chat／全局访问模式留给后续子票。测试通过真实应用 HTTP、隔离临时数据库与可控模型响应验证；真实受限策略测试只在 macOS 运行，Linux CI 明确跳过该部分。schema 更新至 v16，旧库仍拒绝且不自动迁移、清空或删除。

## #147 交付范围

模型本地工具面已统一为 `exec_command`、`read_file`、`apply_patch` 和 `read_tool_output`，保留原有子 Agent 工具。`read_file({path, offset?, limit?})` 使用绝对路径与字节偏移，offset 默认 0，limit 默认及最大 51,200 字节；不复刻行／列分页或全文件 UTF-8 扫描。`apply_patch({patch, cwd, timeout_ms?})` 使用同一固定版本二进制的内置 patch，cwd 为允许的绝对目录，timeout_ms 默认 30,000，范围为 1–3,600,000 毫秒。搜索、列目录、复制、移动及删除由命令提供；不保留旧七工具、唯一替换、锁或碰撞契约。

原生读取及 patch 使用与命令相同的可信当前项目／Agent 范围，没有绕过权限的 Node 文件回退。每次读取独立打开原生句柄，完成／失败后关闭；取消时停止取新块、结清在途请求并关闭。不同 Agent 的临时目录不互相授权，零 Target Folders 仍允许所属 Agent scratch；符号链接按实际目标权限处理，已有跨范围硬链接保持已知限制。不承诺修改回滚。

真实后端 HTTP 测试以可控模型响应串联读取、patch、验证命令及下一次模型请求，验证实际结果和三种执行路径的范围外拒绝，使用隔离临时数据库／目录。历史 Tool Call 参数和结果仍可通过通用卡片读取。应用仍掌握模型 HTTP 记录、串行单 Agent 循环、结果配对与子 Agent 调度；本切片不实现审批、Project Grant 或 Tool Access Mode。


## #148 交付范围

三个执行工具允许 `extra_permissions`（既有绝对路径的 read/write、字面域名及本机网络能力）和必填理由。原始 Tool Call 参数不可变；未满足需求先进入 waiting，Tool Call 与统一入口保留归属／理由／范围。用户拒绝返回未执行结果，仅本次批准绑定唯一 requestId 和该次调用；等待无超时、关闭浏览器不取消，Agent 取消与服务重启中断且不重放。命令预算从实际启动起算。每次决定及 Target Folders 编辑重检其余 pending，不传播一次批准；后续持久授权／模式沿用此重检入口。

管理写入保留 Host／Origin 校验，另需每次启动生成的 256-bit 服务内存凭据。仅在终端启动 URL fragment 中交给用户，浏览器移除 fragment 后存于本标签 sessionStorage；公开 HTTP 页面、API 和命令环境不返回凭据。原生本机客户端只伪造头部不能批准或修改权限；重启后重新打开新管理 URL。所有 API 修改统一使用这一条用户管理路径，不增加账号／登录系统，不声称防御已获全部浏览器／应用文件访问的同账号进程。

域名批准通过上游受管代理策略执行；精确 localhost/IP 域名授权可访问对应主机，但不授权监听；本机能力沿用 `allowLocalBinding:true`，包含监听、loopback 直连及代理私网检查放宽，不承诺按端口隔离。额外目录 write 同样包含元数据，文件 write 仅授予该文件。schema v17 保存 Tool Call 审批事实，旧库拒绝且不自动迁移／删除。Project 持久授权和 Chat／全局访问模式仍待后续子票。


## #151 interruption and cleanup

Native output-close remains the command completion boundary. Cancellation waits for managed command/read cleanup before terminal Agent state, preserves received streams and exit facts, and records cancelled Tool Calls as interrupted. A subtree stop leaves siblings running. Executor loss settles unfinished calls without reconnecting or replaying; ordinary shutdown closes the executor with a five-second forced-close fallback when EOF cannot be acknowledged. This fallback closes only the managed exec-server and does not reclaim every detached daemon or undo file effects.

Restart recovery preserves durable output and approval facts, marks unfinished execution/waits interrupted, and never rebuilds the in-memory pending queue. Permission rechecks cannot revive interrupted calls. Browser closure while the service lives retains waiting approvals. Tests use isolated fresh databases and native HTTP fixtures, including stopped-backend shutdown, subtree/sibling cancellation and exact different-model communication records. The current supported schema is documented in README; old schemas are rejected without migration or deleting the development database.
## #149 交付范围

Project always 只保存当时展示的未满足权限；Project Edit 用同一 projects.grants 存储管理路径 read/write、字面域名与原生本机网络能力。权限单独保存，不覆盖项目名称或目标文件夹，支持跨页面同步、重启保留与项目内现有／未来 Chat 和主／子 Agent 共享，不增加 Chat／全局持久授权。每次保存或批准后重检待审批队列，完整覆盖执行原请求一次，部分覆盖展示剩余需求并更新 requestId，旧决定无效；终态调用不重放。执行开始解析最新授权，运行中保留快照，取消仍为立即停止机制。schema v18，拒绝旧库且不自动迁移／重建。

精确 localhost 域名授权支持对应主机访问，不授予监听；原生 localNetwork 能力还包含监听、loopback 直连及代理私网检查放宽，无按端口隔离。所有授权写入需启动时服务内存管理凭据。真实 macOS HTTP 工具测试覆盖项目持久复用、读写隔离、其他项目拒绝、队列重检及运行快照；浏览器测试覆盖键盘操作和跨页授权编辑同步。


## #150 交付范围

Chat 独立保存文件／网络受限或完全访问选择，Settings → Execution 默认值只初始化新 Chat（两项默认均受限）。用户管理写入须具备服务内存凭据；模式忙碌时可编辑，实际执行前读取所属 Chat 当前权限，已有子 Agent 沿用所属 Chat 当前模式；已开始操作保持快照，待审批原调用按变化后的权限重核且仅执行一次。完全文件使用原生 unrestricted，不提升 OS 权限；完全网络使用原生 Enabled，不附带 managed proxy，也不扩展受限文件范围。原生 localhost 验收涵盖四种组合、忙碌编辑与待审批部分／完整覆盖。受限 managed proxy 的已批准精确 `localhost` 域名可访问该主机的 loopback 服务；它不授予监听、任意 IP 或通用 LAN 权限。local-network capability 有意扩展原生本地绑定／loopback 行为，不隔离端口。
