# Tyler Agent

TypeScript/Node.js 本地网页应用。React SPA 由 Vite 和 Tailwind 构建，原生 Node HTTP server 使用 SQLite 保存项目、对话与用户配置。

## 运行

需要 Node.js 24 和 pnpm 11。

```sh
pnpm install
pnpm start
```

`pnpm start` 先构建页面再启动服务，打开 `http://127.0.0.1:3000`。后端代码变化时自动重启；前端变化后重新运行以构建页面。可用启动参数改变端口：

```sh
pnpm start --port 3001
```

端口须为 1–65535 的整数，默认 3000。启动和前端构建不加载 `.env` 文件，应用配置不从环境变量读取。

默认数据库为项目根目录的 `data/tyler-agent.sqlite`，默认目录自动创建。可指定数据库：

```sh
pnpm start --db /path/to/chat.sqlite
```

相对路径按启动工作目录解析；自定义路径的父目录须已存在、可写且仅当前用户可访问（例如权限 `0700`）；服务不会修改自定义父目录权限，不符合要求则在打开数据库前报错。新数据库自动创建当前 schema 和默认设置，不创建项目或对话。数据库无法打开、不支持/未知/损坏 schema 或初始化失败时服务报错退出，绝不自动删除或重置；本版本仅对已知的 v8 schema 非破坏升级，保留历史与偏好，不做历史选择回填。

## 项目与对话

左侧点击文件夹＋图标和“New project”文字入口，输入非空名称，通过“Add folder”打开独立目录选择框。浏览的是 **server 机器**的目录，首次从 server 用户 home 开始。当前绝对路径完整换行显示；“返回上级”（Up one level）在根目录禁用。每个子目录整行可点击，显示文件夹图标、名称和进入箭头，并提供悬停及键盘焦点。点击只浏览，不添加。标题、当前位置和底部 Cancel / Select current folder（取消 / 选择当前文件夹）始终可见，仅目录列表滚动，成功进入目录后列表回到顶部。每次确认添加当前显示的绝对路径并关闭选择框。再次打开沿用当前浏览位置，可逐次添加多个目录，已选列表支持移除，重复路径显示 Already added（已添加）且不可再次选择。创建成功后清空表单，下一次新 project 从 home 开始；单纯显隐不重置输入或浏览位置。

Folder browsing: the server-machine path wraps in full. Use Up one level (disabled at root) or a full folder row to browse; navigation never adds a folder. Only the list scrolls, with location and Cancel / Select current folder kept visible. Successful navigation returns the list to the top. No subfolders still permits selecting the current folder; Already added prevents duplicates. Loading identifies the requested destination and disables selection. A failed request retains the previous successful location and list, identifies both the failed target and the still-displayed folder, and permits selecting that displayed folder. Retry requests the failed target. Cancel returns focus to Add folder and keeps the current edit-session position.

目录列表只枚举当前层的可见子目录，按名称排序，忽略普通文件和以 `.` 开头的项，不识别其他系统隐藏属性。可见目录符号链接允许浏览和选择；损坏链接跳过。允许浏览 server 用户有权限读取/进入的目录，home 只是起点；权限不足、目录缺失会显示错误并保留上次成功的路径和列表，明确指出失败目标与仍显示的位置；“重试”请求失败目标，也可选择明确显示的原目录。空目录提示“没有子文件夹”，仍可选择；加载提示请求目标并禁用选择，但可随时关闭，关闭不会取消请求。浏览不读取文件内容、不更改文件、数据库或共享状态。

创建框预填 `New project` / `New chat`，可修改，也可直接提交。名称会去掉首尾空白、不得为空，允许重复。隐藏再打开保留当前草稿和错误；创建成功后的新草稿重新使用默认名称。

project 可以有零个或多个文件夹，无需选择目录即可创建。添加文件夹时 server 再次检查存在、可访问且为目录，拒绝重复解析路径和失效目录，失败保留表单。相对 API 路径按启动工作目录解析，符号链接使用 lexical 路径，不按物理目录去重。所有文件夹平等，本阶段只保存配置，不向模型发送文件夹。

普通管理 modal 始终挂载，取消或 Escape 只隐藏界面，提交期间也允许关闭，不取消请求或重置输入、错误及进行中状态；再次显示直接使用现有状态，不另行缓存或恢复。提交中禁止修改创建输入或切换创建目标，并禁止重复提交；原目标的创建入口可重新显示进行中的表单，设置仍可打开。创建成功后独立清空对应表单；失败保留输入，旧创建响应不关闭设置框。切换到不同的创建目标是显式动作，可以重置创建表单。

每个 project 可创建多个具名 chat，空 chat 立即保存，不自动生成 chat。创建成功后仅当前页面选中它；其他页面通过 SSE 更新列表，不改变选择或折叠。项目默认展开，折叠状态仅当前页面有效。右侧显示所选 project/chat 和只读文件夹；没有选择时，首页提示从侧栏选择对话或在所属项目内创建；没有可写项目时提示使用侧栏 New project。初始项目读取显示加载，失败显示错误与 Retry，不冒充空列表，已有可用列表保留。

每个 chat 的提问与追问仅使用自己的成功历史。每次服务器已接受的问题成为持久化 Turn，历史显示进行中、成功或失败；失败保留问题和错误，但不会进入后续模型上下文。草稿可修改重试，每次重新提交产生新的 Turn。发送前写入失败不会调用模型；完成结果写入失败明确报错，不自动重发，也不声称结果已保存。busy 由 server 按 chat 保存：同 chat 请求进行中时所有页面禁止再次提交，server 返回 409；不同 chat（包括同项目）可以同时请求。侧栏标记运行中的 chat，目录之后失效也不阻止纯文本聊天。

选择只保存在本页 URL 的 `?chat=<id>`，刷新和浏览器前进/后退恢复；无参数不自动选择，未知 ID 自动移除 URL 中的 chat 参数并返回首页。每个 chat 的草稿仅存在当前页内存，切换恢复、刷新丢失，不跨 tab 分享。请求时可以切换 chat；回答写回原 chat，不清除后来编辑或其他 chat 的草稿。SSE 重新读取历史/busy，不覆盖草稿或选择。

列表按 server 接受合法提问的时间排序：chat 最近提问优先，project 按其 chat 中最新的活动优先。不等待模型回答，上游失败也保留活动时间；空 prompt、未知 chat 和 busy 拒绝不改变排序，回答完成不再次更新。未提问的 chat 使用创建时间，没有 chat 的 project 使用自身创建时间；时间相同时按 ID 倒序稳定排列。排序时间保存在 SQLite，重启保留。

已提交的项目、文件夹、chat、所有已接受的 Turn 和活动时间由 server 维护，是共享数据的唯一来源。创建、排序、历史、busy 和语言变化通过 SSE 通知所有页面重新读取，不整页刷新；初次加载、刷新和断线重连都会读取最新数据。SSE 通知和重连不改变本页选择、折叠与未提交草稿；整页刷新通过 URL 恢复选择，折叠与草稿重新初始化。busy 只在 server 内存中，重启恢复空闲。

新数据库自动建立数据表，不生成默认项目或对话。用户配置使用单行 `settings` 表，保存 `sidebar_width`、`language`、密钥及默认模型；默认宽度 320px、界面语言英文，修改任一项不覆盖另一项。项目、文件夹、chat、历史、活动时间和归档状态重启保留。仅升级已知 v8 schema；未知或不支持的数据库报错且不重置。没有删除功能。

## 桌面视口与思考强度

支持的浏览器内容视口为宽 ≥1280 且高 ≥720 CSS 像素（包含边界），不是屏幕物理分辨率。任一尺寸不足会显示扩大窗口提示，阻止被遮挡的页面及弹窗交互；扩大后自动恢复选中的对话、草稿、提问选项、弹窗和阅读位置，已接受请求及同步继续。窗口尺寸不保存为偏好，也不修改面板宽度。此版本使用固定左右桌面布局，不提供移动端布局。

输入区在原生强度选择框旁持续显示“思考”，默认项显示“默认”：不指定强度，使用模型或提供方行为，区别于显式 none 和全局默认模型。支持的级别、无效历史保护和进行中编辑下次草稿的行为不变。控件可换行，发送按钮保留在输入区右下方。

The desktop workspace supports browser content viewports at least 1280×720 CSS pixels, including that exact boundary. If either dimension is smaller, an enlarge-window notice blocks obscured interactions. Enlarging restores the selected Chat, drafts, local Turn Options, dialogs and reading position; accepted work and synchronization continue. Resizing never saves a viewport or sidebar preference. The sidebar stays beside Chat, with its existing 320px default and 240–600px drag range.

The composer visibly labels its native level selector **Reasoning**, with **Default** meaning omitted strength and provider/model behavior. It differs from explicit none and the global Default Model. Supported levels, invalid-history protection and editing future drafts while a request runs remain unchanged. Controls can wrap while Send stays at the lower right.

## 左侧面板宽度

页面固定为窗口高度，左右内容独立滚动。左侧顶部标题和 New project、底部 Settings 始终可见，中间项目、对话与 Archived 列表独立滚动；右侧长聊天内容仅在右侧区域滚动。

用鼠标或触控板拖动左侧面板右边的分隔线，两个区域实时调整；双击恢复默认宽度。默认 320px，最小 240px，最大 600px，范围不随窗口大小变化。边界始终为 1px 灰线，hover 和拖动稍微加深，8px 透明区域用于抓取。

拖动开始后移出边界仍可调整，松手、窗口失焦或异常中断时保留当前宽度并结束；拖动期间不选择文字，结束恢复正常操作。结束时仅保存改变后的宽度一次，双击保存默认值，不在移动过程中发送请求。

宽度属于数据库对应的唯一用户，由 server 保存到 SQLite，重启 server 或使用新浏览器后恢复。新页面先显示默认宽度，读取成功应用保存值；不使用 localStorage。多个窗口共用最近成功保存的偏好，已打开窗口不实时同步，刷新或重新打开后读取最新值。读写失败不显示提示或自动重试；保存失败保留当前布局，读取失败保留默认，server 数据库读写失败只打印 terminal 日志。

## OpenRouter 通信记录

Settings 是唯一的总标题，语言、OpenRouter API 密钥、模型为并列分区。设置标题和底部 Close 始终可见，仅中间内容滚动；长模型名称和 ID 换行，行操作保留可用。可写对话缺少配置时，在标题附近明确提示缺少密钥、模型或两者。

Settings has peer Language, OpenRouter API key and Models sections, with a fixed title and Close footer and scrolling content. Configured status is separate from the write-only replacement field. Blank saves send no request; meaningful saves show Saving, then Saved and clear the field. Failures retain confirmed settings and the draft. Removal is immediate, secondary, and retains the draft; credential and model errors appear in their respective sections. Required Settings identifies the missing key, models, or both beside its title.

Settings 是唯一的配置界面，管理 OpenRouter API key、启用的文本模型和可选全局默认模型。SQLite 是用户配置的唯一来源。首次向空列表添加模型会在同一事务中指定它为全局默认；向非空列表添加不改变默认，包括已有列表没有默认的情况。首次添加成功时，仅为发起操作且仍处于当前页面的 chat 填入空的模型选择（包括已有历史的 chat）；期间切换聊天或改选模型后不再自动填入，不影响其他窗口。重复添加不改变默认或顺序。默认模型必须属于启用列表。设置中统一显示所有已启用模型，按添加顺序排列，每行显示名称和较小的模型 ID；非默认行提供 Set default，默认行显示不可点击的 Default，不提供清空默认操作。每行的 × 图标（Disable model）立即移除模型，无需确认。移除默认模型时，按最近成功目录排名自动选择剩余模型；排名内优先，无排名或缓存时选择最早添加的剩余模型。移除最后一个模型则清空默认。失败保留原配置和聊天选择，保存过程中避免重复操作。

密钥在 SQLite 中明文保存，数据库备份也包含密钥；数据库目录和文件仅当前用户可访问，并保持 Git 忽略。密码输入用于输入新密钥或替换密钥，独立显示已配置/未配置状态。空白输入不能保存且不发送请求（server 仍支持空值保留）；保存期间显示保存中并防止重复提交，成功清空输入并显示已保存，失败保留原配置与输入。移除是无需确认的次要文字操作，保留尚未保存的替换草稿。密钥错误与模型错误分别显示在对应区域。读取配置只返回是否已配置，旧密钥不回传浏览器，也不进入 SSE、公共错误或通信记录。保存密钥不执行付费验证。每个已接受请求捕获当时的密钥，后续替换或删除不改变正在运行的调用；prompt、请求、响应和错误使用同一密钥脱敏，包括跨网络 chunk 的内容。

每次打开 Settings 都匿名请求 OpenRouter 最热门的 100 个文本模型（不传 Authorization 或 API key），列表按过去一周 token 使用量排序，只下载一页。已启用列表下方的 Add model 打开自动聚焦的可输入选择组件、可滚动候选列表及 Cancel 按钮；候选仅包含尚未启用的模型，按热门顺序排列。在同一个输入中按名称或 ID 不区分大小写地即时筛选，不发送网络请求。点击候选立即添加；方向键选择候选，Enter 仅确认已高亮的有效候选，不接受任意 ID。成功后清空搜索并恢复 Add model 按钮和焦点，失败保留输入与候选以便重试。Cancel 或 Escape 取消未提交的添加、清空输入并返回 Add model；第一个 Escape 不关闭 Settings，再次 Escape 可关闭普通 Settings，强制设置仍不能关闭。已发出的保存不撤销，期间禁用取消和重复提交。移除在已启用列表中进行，不提供单独 Search、Refresh 或模型保存按钮。加载与筛选无结果分别提示，保存失败恢复已确认状态。服务启动、输入、配置保存与发送不刷新目录；添加仅验证 server 已缓存的候选，server 重启后若页面仍保留旧候选，添加会报错并保留输入，重新打开 Settings 下载目录后再试；刷新失败提示错误并保留上次成功列表，重新打开设置重试；若因缺少密钥或启用模型而无法关闭设置，重新加载页面重试（未保存输入会丢失）。排名仅缓存在 server 内存，SQLite 保存启用成员、名称及能力；成功刷新仅更新排名内已启用模型的信息，不覆盖并发成员修改。跌出前 100 的已启用模型保留能力、默认和历史选择，在统一已启用列表里仍可移除；排名变化不代表模型不可用。已启用列表始终按添加顺序排列，设置默认或排名刷新不会移动行；既存模型在目录失败时仍可使用。

输入区只列出配置的常用模型。思考强度根据模型能力动态显示：不支持指定强度时隐藏，支持时提供相应级别；“模型默认”不发送强度，区别于关闭思考。切换模型保留兼容的强度，否则回到模型默认。已恢复的强度若能力更新后不再支持，明确标为无效并禁止发送，需重新选择。

未提交的模型与强度仅保存在当前页面、对应 chat 的内存中，切换回来与发送成功后保留，不共享到其他页面。刷新时按当前 chat 的 Turn 从新到旧、每 Turn 的 Model Call 从新到旧读取 request 原文中的模型与强度，不区分进行中、失败或成功，不受显示分页限制；坏 JSON、无模型或无调用记录跳过。两者始终来自同一请求，未指定强度表示模型默认并停止查找；全部读取不到才使用全局默认模型与模型默认强度。不新增聊天或轮次的选项字段，不回填旧历史。读到已移除模型时清空选择、禁止发送，不回退到更旧记录或全局默认。

除上述首次添加填入空选择的情况外，修改全局默认不改变已初始化的输入区；删除模型会同步清空使用它的选择，但保留历史与进行中的请求。每次提交捕获当前 prompt、模型、强度及密钥，先录制请求再调用；进行中仍可编辑草稿、模型和强度，仅影响下次提交，不更新 server 上正在执行的选项。

进入可写 chat 时，如果保存的密钥缺失或没有启用模型，自动打开同一个 Settings modal；缺失期间 Close 禁用，Escape 和背景点击不能关闭。保存密钥且至少启用一个模型后，即使没有全局默认或当前 chat 的模型，也可关闭设置。当前 chat 的模型与思考强度只在 prompt 输入区选择，选择无效时不能发送；移除所选模型清空选择而不回退，有其他启用模型时直接在输入区重新选择，不再打开强制设置。移除最后一个模型或密钥时设置变为强制，即使原本是普通设置。配置读取失败明确显示错误与 Retry，保持未知而不猜测配置，禁止发送并保留本页选择及草稿。普通 Settings 隐藏后保留输入、筛选和错误；不覆盖其他管理 modal，不阻碍归档只读历史，已接受的请求继续执行。

配置的修改通过 SSE 同步所有页面，不覆盖未提交草稿。每次通信以脱敏原文保存到 SQLite，可在 Turn 的 Request/Response 查看；prompt 和回答也可能出现在记录中。

## 检查与测试

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

自动测试使用真实本地 HTTP server、临时 SQLite、假的 OpenRouter 流和 Chromium；不使用真实密钥或付费 API。覆盖有序增量、partial failure/restart、重连追赶、懒加载与缓存、SSE/Copy、分页和阅读锚点；分页不截断完整成功上下文，失败部分内容不进入模型上下文。

GitHub CI 使用 Node 24/pnpm 11，运行格式、类型、构建、后端测试及同一套 headless Chromium E2E。Linux 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器和系统依赖。浏览器测试失败会令 CI 失败，并上传 `playwright-failure` artifact（保留 7 天），包含 HTML 报告和失败 trace；在 Actions run 页面下载后，可用下面的命令查看。

本地默认只输出终端结果，不生成 HTML 报告；失败时在 `test-results/` 保留 trace。`pnpm test:e2e` 全部通过后自动删除 `test-results/`，失败时保留结果和非零退出码。直接运行 `pnpm exec playwright test` 不执行这一步清理。`playwright-report/` 和 `test-results/` 均已忽略；已有 HTML 报告不会自动删除。

```sh
pnpm exec playwright show-report playwright-report
pnpm exec playwright show-trace test-results/<失败用例目录>/trace.zip
```

### 编辑项目和对话

通过侧栏项目或对话旁的 ⋯ 菜单打开编辑框。项目可修改名称和添加/移除目标文件夹（允许零个）；对话可改名，历史和活动排序不变。回答进行中仍可编辑。未变的已存文件夹即使后来不存在，也不妨碍改名；新增文件夹仍须有效。

编辑框关闭仅隐藏，同一目标重新打开保留未保存的内容和错误；换目标加载对应数据。保存期间可关闭，保存继续完成；为避免保存到错误目标，完成前不能切换编辑/创建目标或重复保存。失败保留草稿供重试，成功后再次编辑读取最新服务端数据。保存结果持久化并同步其他页面，未提交草稿仍仅属于当前页面。

### 归档与恢复

⋯ 菜单可直接归档或恢复，无确认框。project 和 chat 各自持久化独立归档状态，归档 project 不改变其 chats 自身标记。正常列表仅显示未归档 project 和未归档 chats；侧栏底部 Archived 默认折叠，按 project → chat 分组：归档 project 标记“(project archived)”并包含全部 chats，正常 project 的分组只列其单独归档 chats。列表继续按原活动时间排序，改名、归档及恢复不使条目跑到最前。

归档后只读：project 不能改名、更新文件夹或创建 chat；chat 自身或父 project 任一归档时不能改名或提交新问题，server 同样拒绝这些操作。仍可查看历史和恢复。恢复 project 保留各 chat 原标记；父 project 归档时可恢复已单独归档的 chat，但它仍因父状态只读，需要恢复 project 才可继续使用。

归档允许在回答或保存进行中执行，已接纳的操作继续完成、保存及同步，不取消请求。当前选中 chat 不自动切换或清空，主区域保留历史、提示只读原因，已开始的回答继续更新。现有编辑及提问草稿保留；恢复后重新判断可用操作。编辑、归档及恢复经 SSE 同步所有页面，选择、未提交草稿及 Archived 折叠只属于本页；刷新后 Archived 重新折叠，重启保留所有已提交的归档状态和历史。

侧栏的 New project 默认透明无描边，标题行、+ / ⋯ 图标按钮及菜单项有浅灰圆角 hover 反馈（禁用菜单项置灰）。⋯ 使用原生 Popover：点击外部关闭，打开其他菜单关闭旧菜单，选择动作立即关闭后执行。菜单与 ⋯ 下方右对齐，靠近底部时向上避让，不被侧栏裁切。+ 提供“New chat”悬停提示。

## 界面语言

Settings 中可选择 English 或简体中文。默认英文（en），支持 zh-CN；i18next 与 react-i18next 使用随应用打包的本地资源，缺少翻译时回退英文，不自动检测浏览器语言，不加载远程翻译。Agent 角色标识沿用英文 fallback。

选择后立即保存，无额外保存按钮。语言由 server 的 SQLite 用户配置维护，保存确认后生效，通过 SSE 同步所有页面，包括隐藏中的设置框；刷新、断线重连与重启恢复。首次页面先读取已保存语言再显示主界面，失败显示英文错误及 Retry，不会将英文写回覆盖配置。保存失败保留已确认语言，可重试；结果不明时重新读取 server。

语言切换更新界面标签、菜单、状态、placeholder、悬停和可访问名称，以及已经显示的应用错误。名称输入、问题草稿、已存名称、路径、聊天历史和模型回答保持原样。新的一份创建草稿用当前语言生成默认名；已有草稿（包括未改过的预填名）和同一目标隐藏重开保持，不追踪默认名是否修改。外部错误详情及原始 request/response 保留原内容，凭据仍脱敏，terminal 技术日志不翻译。

## 保存轮次与模型通信

通过 direct fetch 向配置的 OpenRouter Responses 模型发送 `stream: true`，无 SDK、tools 或自动付费重试。思考与回答按实际 output item/content part 顺序交错显示，支持多个文本、refusal、推理正文和摘要；同一思考块分别标注正文和摘要，reasoning item 内的 output_text 仍属于思考，encrypted reasoning 仅保留在原始通信中。思考仅在轮次进行中默认展开，成功或失败默认折叠；手动选择在当前页面内更新和切换对话时保留，刷新后重置。历史初读只有有序块元数据和回答，思考正文与摘要展开才下载，已下载内容保留到刷新并持续同步进行中的增量。只有协议 completed 且含可用回答才成功，EOF、[DONE]、单个 item 完成不代表成功。失败保留部分回答并标记不完整。

Turn 与 Model Call 分别保存；实际 OpenRouter 调用始终录制。通信记录保留 URL、method、请求时间、原始请求/响应正文、实际 HTTP 状态、耗时或调用错误，不保存 headers。凭据在写入数据库和返回浏览器之前脱敏；JSON 和非 JSON 正文保持当时文本（仅凭据脱敏），完整成功上下文随请求保存。原始 Response 保存实际收到的脱敏 SSE 文本（包括未知事件和尾部片段）；保存原始正文和结构化增量后才通知浏览器，两个页面均可在完成前看到回答。凭据跨网络 chunk 也先脱敏。

聊天历史摘要不包含通信正文。`GET /api/turns/:id/calls` 可独立读取该轮次按顺序排列的记录，归档后仍可读取。配置缺失等发送前失败可以没有调用；网络或响应读取失败没有虚构响应正文，已收到的 HTTP 状态仍保存。每个问题下 Request 和结果下 Response 默认折叠；展开才下载对应正文，SSE 按事件分别展示，JSON payload 缩进，未知事件、不可解析数据和尾部不完整片段保持可见；非 SSE 响应沿用 JSON 缩进或纯文本展示。Copy 复制保存的脱敏原文（不复制展示缩进）。无调用的旧记录明确提示无通信记录，不重建请求。进行中展开可查看已保存的部分 SSE，Turn 仍进行中时后续增量同步到已展开或已下载的记录；无响应明确提示，HTTP 错误可读取实际正文。当前页面保留已下载正文与展开状态，切换 chat、归档、语言或同步不清除；整页刷新才重置。读取失败在折叠区内重试，已读取内容保留。

服务启动将遗留进行中的 Turn 和调用标记为重启中断，保留已保存信息，不恢复发送。已保存的部分回答、按序输出项和通信正文继续保留；失败轮次不进入后续模型上下文。

OpenRouter 通信始终保存到 SQLite，已移除 terminal 通信日志、Settings debug 开关及相关启动配置。普通服务错误日志仍保留。当前 schema 不包含废弃 debug 配置。侧栏齿轮可打开语言、模型及密钥设置。

### 分页历史与页面缓存

打开 chat 默认只读取最新 10 个 Turn（包含进行中与失败），按旧到新显示。顶部“Load earlier turns”每次读取更早的 10 个；没有更早记录时入口消失。稳定 ID 边界使新增提问不影响旧页，历史摘要不下载通信正文。分页仅影响展示，模型仍使用完整成功问答上下文。

已下载历史、思考、问题草稿以及通信正文和展开状态保留在当前页面中，切换 chat、实时通知、同步错误、语言或归档不会删除它们；整页刷新后重新从最新 10 个初始化。缓存不使用 localStorage 或 cookie。SSE、重连、页面重新可见、窗口获得焦点和切回 chat 都核对服务器最新状态，补齐尚未下载的新轮次（超过 10 个也分批补齐），同时保留已有内容。流式通知仅更新发生变化的 Turn，不逐 token 重读项目列表和已缓存历史，不增加 throttle、debounce 或定时批处理。已下载的 pending 思考和原文即使折叠也追赶当前保存的内容；较旧的异步读取不得覆盖较新的同步结果。同步或加载更早失败显示可重试错误。

### 固定输入区与阅读位置

右侧标题、文件夹信息、问答及 Request/Response 在内容区独立滚动，底部圆角输入区固定：Prompt 提示放在 placeholder，输入框从约 2 行随草稿增长/缩小，到约 8 行后内部滚动；框内右下角箭头提交按钮仅在内容非空白时显示，进行中仍可编辑但禁止同 chat 再次提交。底部控件始终留在输入区；左侧固定头尾及列表滚动保持独立。加载更早记录、文本增量增长及展开/折叠保持正在阅读的内容锚点，即使已展开的思考或通信正文很长。

首次打开 chat 显示最新内容，自己提交后跟随到底部（包括进行中与回答完成）。其他页面产生的新内容或状态变化只在本来位于底部时跟随，阅读旧内容时不跳转。每个 chat 的阅读位置仅保存在当前页面；切走再返回恢复原位置，即使期间新增轮次，也不强制跳到最新。已下载历史、草稿和通信展开状态继续保留；整页刷新后重新加载最新 10 个并显示底部，不使用 localStorage 或 cookie 保存阅读位置。

### Project-owned creation and empty states / 项目内创建与空状态

Each writable Project keeps its + action. An expanded Project with no visible nonarchived Chats also offers New chat, including Projects containing only archived Chats. Populated or collapsed Projects hide the inline action; archived Projects offer neither creation action. Both open the existing form identifying the owning Project, and save only when Create is submitted. Cancel preserves the draft; creating a Project never creates a Chat automatically. The homepage guides selection or creation within a Project. Without a writable Project it points to New project in the sidebar; Archived remains accessible. Project reads distinguish initial loading, retryable failure, and successful empty results, retaining previously usable lists on read failure. A selected Chat shows first-question guidance only after successfully loading empty history; loading and errors have distinct presentation and Retry, preserving cached or partial content. Archived Chats retain their restore/read-only guidance. Unknown Chat IDs redirect to home.

每个可写项目保留 +；展开且没有可见未归档对话时，另显示新建对话按钮，包括仅有归档对话的项目。有对话或折叠时隐藏行内入口，归档项目不提供创建。两种入口都打开标明所属项目的原创建框，仅点击创建后保存，取消保留草稿，创建项目不自动创建对话。首页提示在所属项目内选择或创建；无可写项目时提示侧栏新建项目，仍可访问已归档数据。项目初始加载、可重试读取失败和成功空列表分别显示，失败保留已有列表。所选对话只有在成功加载空历史后才提示输入第一个问题；加载与失败分别显示，可重试，缓存和部分内容保留。归档对话继续显示只读及恢复提示；未知对话 ID 返回首页。
