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

端口须为 1–65535 的整数，默认 3000。启动前通过 `lsof` 检查所选端口；如果被占用，先终止监听进程及其 Node watcher，再启动服务。需要系统提供 `lsof` 和 `ps`；停止服务使用终端 Ctrl+C。启动和前端构建不加载 `.env` 文件，应用配置不从环境变量读取。

默认数据库为项目根目录的 `data/tyler-agent.sqlite`，默认目录自动创建。可指定数据库：

```sh
pnpm start --db /path/to/chat.sqlite
```

相对路径按启动工作目录解析；自定义路径的父目录须已存在、可写且仅当前用户可访问（例如权限 `0700`）；服务不会修改自定义父目录权限，不符合要求则在打开数据库前报错。新数据库自动创建当前 schema 和默认设置，不创建项目或对话。数据库无法打开、不支持/未知/损坏 schema 或初始化失败时服务报错退出，绝不自动删除或重置；本版本使用新的 v15 空数据库结构，不读取或迁移旧数据库。升级时请使用明确指定的新数据库路径；删除或重建实际开发库需要单独授权，应用启动不会自动清库。测试始终使用隔离临时数据库。

## 项目与对话

左侧点击文件夹＋图标和“New project”文字入口，输入非空名称，通过“Add folder”打开独立目录选择框。浏览的是 **server 机器**的目录，首次从 server 用户 home 开始。当前绝对路径完整换行显示；“返回上级”（Up one level）在根目录禁用。每个子目录整行可点击，显示文件夹图标、名称和进入箭头，并提供悬停及键盘焦点。点击只浏览，不添加。标题、当前位置和底部 Cancel / Select current folder（取消 / 选择当前文件夹）始终可见，仅目录列表滚动，成功进入目录后列表回到顶部。每次确认添加当前显示的绝对路径并关闭选择框。再次打开沿用当前浏览位置，可逐次添加多个目录，已选列表支持移除，重复路径显示 Already added（已添加）且不可再次选择。创建成功后清空表单，下一次新 project 从 home 开始；单纯显隐不重置输入或浏览位置。

Folder browsing: the server-machine path wraps in full. Use Up one level (disabled at root) or a full folder row to browse; navigation never adds a folder. Only the list scrolls, with location and Cancel / Select current folder kept visible. Successful navigation returns the list to the top. No subfolders still permits selecting the current folder; Already added prevents duplicates. Loading identifies the requested destination and disables selection. A failed request retains the previous successful location and list, identifies both the failed target and the still-displayed folder, and permits selecting that displayed folder. Retry requests the failed target. Cancel returns focus to Add folder and keeps the current edit-session position.

目录列表只枚举当前层的可见子目录，按名称排序，忽略普通文件和以 `.` 开头的项，不识别其他系统隐藏属性。可见目录符号链接允许浏览和选择；损坏链接跳过。允许浏览 server 用户有权限读取/进入的目录，home 只是起点；权限不足、目录缺失会显示错误并保留上次成功的路径和列表，明确指出失败目标与仍显示的位置；“重试”请求失败目标，也可选择明确显示的原目录。空目录提示“没有子文件夹”，仍可选择；加载提示请求目标并禁用选择，但可随时关闭，关闭不会取消请求。浏览不读取文件内容、不更改文件、数据库或共享状态。

创建框预填 `New project` / `New chat`，可修改，也可直接提交。名称会去掉首尾空白、不得为空，允许重复。隐藏再打开保留当前草稿和错误；创建成功后的新草稿重新使用默认名称。

project 可以有零个或多个文件夹，无需选择目录即可创建。添加文件夹时 server 再次检查存在、可访问且为目录，拒绝重复解析路径和失效目录，失败保留表单。相对 API 路径按启动工作目录解析，符号链接使用 lexical 路径，不按物理目录去重。所有文件夹平等，本阶段只保存配置，不向模型发送文件夹。

普通管理 modal 始终挂载，取消或 Escape 只隐藏界面，提交期间也允许关闭，不取消请求或重置输入、错误及进行中状态；再次显示直接使用现有状态，不另行缓存或恢复。提交中禁止修改创建输入或切换创建目标，并禁止重复提交；原目标的创建入口可重新显示进行中的表单，设置仍可打开。创建成功后独立清空对应表单；失败保留输入，旧创建响应不关闭设置框。切换到不同的创建目标是显式动作，可以重置创建表单。

每个 project 可创建多个具名 chat，空 chat 立即保存，不自动生成 chat。创建成功后仅当前页面选中它；其他页面通过 SSE 更新列表，不改变选择或折叠。项目默认展开，折叠状态仅当前页面有效。右侧显示所选 project/chat 和只读文件夹；没有选择时，首页提示从侧栏选择对话或在所属项目内创建；没有可写项目时提示使用侧栏 New project。初始项目读取显示加载，失败显示错误与 Retry，不冒充空列表，已有可用列表保留。

提交接口在校验及保存 pending Agent的事务成功后立即返回 HTTP 202 和 `{ agentId }`，表示已接受，不包含最终回答或表示执行成功。模型/工具循环继续在 server 运行；关闭页面或断开确认连接不取消已接受任务。进度及终态通过现有 SSE 和 Agent/历史读取同步，busy 持续覆盖整个执行。接受前的拒绝属于提交错误；已接受任务的模型、工具循环或结果保存错误属于该 Agent，保存失败显示无法保存的错误，不声称未保存结果已保存。

每个 chat 的提问与追问仅使用自己的成功历史。每次服务器已接受的问题成为持久化 Agent，历史显示进行中、成功、失败或取消；失败保留问题和错误，但不会进入后续模型上下文。失败的问题保留在历史中，可手动复制后重新提交，每次重新提交产生新的 Agent。发送前写入失败不会调用模型；完成结果写入失败明确报错，不自动重发，也不声称结果已保存。busy 由 server 按 chat 保存：同 chat 请求进行中时所有页面禁止再次提交，server 返回 409；不同 chat（包括同项目）可以同时请求。侧栏使用 chat 行最右侧（操作菜单之后）的 16px 旋转圆环标记 server 已接受且尚未结束的 Agent；提交接受前不显示，成功、失败或取消后消失。所有行预留状态位置，名称与菜单不会位移。未选中、同时运行及归档中的 chat 同样显示；折叠项目不额外汇总状态。圆环不可点击，提供本地化“运行中”无障碍状态，系统减少动态效果时改为静态圆环，无需 GIF 或动画库。目录之后失效也不阻止纯文本聊天。

Sidebar work status: a noninteractive 16px CSS ring appears after the chat actions menu while the server reports an ongoing Agent. Every row reserves the slot so names/actions stay aligned. It covers unselected, parallel and archived work and recovers through existing refresh/reconnect synchronization; there is no pre-acceptance or project aggregate indicator. Reduced-motion preference makes the localized Working status static.

选择只保存在本页 URL 的 `?chat=<id>`，刷新和浏览器前进/后退恢复；无参数不自动选择，未知 ID 自动移除 URL 中的 chat 参数并返回首页。每个 chat 的草稿仅存在当前页内存，切换恢复、刷新丢失，不跨 tab 分享。请求时可以切换 chat；回答写回原 chat，不清除后来编辑或其他 chat 的草稿。SSE 重新读取历史/busy，不覆盖草稿或选择。

列表按 server 接受合法提问的时间排序：chat 最近提问优先，project 按其 chat 中最新的活动优先。不等待模型回答，上游失败也保留活动时间；空 prompt、未知 chat 和 busy 拒绝不改变排序，回答完成不再次更新。未提问的 chat 使用创建时间，没有 chat 的 project 使用自身创建时间；时间相同时按 ID 倒序稳定排列。排序时间保存在 SQLite，重启保留。

已提交的项目、文件夹、chat、所有已接受的 Agent 和派生的活动时间由 server 维护，是共享数据的唯一来源。创建、排序、历史、busy 和语言变化通过 SSE 通知所有页面重新读取，不整页刷新；初次加载、刷新和断线重连都会读取最新数据。SSE 通知和重连不改变本页选择、折叠与未提交草稿；整页刷新通过 URL 恢复选择，折叠与草稿重新初始化。busy 只在 server 内存中，重启恢复空闲。

新数据库自动建立数据表，不生成默认项目或对话。用户配置使用单行 `settings` 表，保存 `sidebar_width`、`language`、`enter_behavior`、密钥及默认模型；默认宽度 320px、界面语言英文，修改任一项不覆盖另一项。项目、文件夹、chat、历史、活动时间和归档状态重启保留。不升级旧 schema；未知或不支持的数据库报错且不重置。没有删除功能。

## 桌面视口与思考强度

支持的浏览器内容视口为宽 ≥1280 且高 ≥720 CSS 像素（包含边界），不是屏幕物理分辨率。任一尺寸不足会显示扩大窗口提示，阻止被遮挡的页面及弹窗交互；扩大后自动恢复选中的对话、草稿、对话选项、弹窗和阅读位置，已接受请求及同步继续。窗口尺寸不保存为偏好，也不修改面板宽度。此版本使用固定左右桌面布局，不提供移动端布局。

输入区用一个控件显示模型与“默认”或所选强度，摘要不显示“思考”标签。点击打开同一弹层中的模型和思考区域；选择立即应用，弹层保持打开。默认不指定强度，区别于显式 none 和全局默认模型。模型列表独立滚动，弹层根据可用空间显示在控件上方或下方，不扩大输入区；长名称在控件中截断，在弹层中完整显示。Escape 或再次点击控件关闭并返回焦点；点击外部关闭并保留目标焦点。进行中仍可编辑下次草稿，只读对话不可修改。

The desktop workspace supports browser content viewports at least 1280×720 CSS pixels, including that exact boundary. If either dimension is smaller, an enlarge-window notice blocks obscured interactions. Enlarging restores the selected Chat, drafts, saved Chat Options, dialogs and reading position; accepted work and synchronization continue. Resizing never saves a viewport or sidebar preference. The sidebar stays beside Chat, with its existing 320px default and 240–600px drag range.

One composer trigger summarizes Model and **Default** or the selected effort, without a Reasoning label. Its popup has labeled Model and Reasoning groups; selections apply immediately and keep it open. Default omits explicit effort and differs from none and the global Default Model. The model list scrolls independently; the popup fits above or below without enlarging the composer. Long trigger labels truncate while popup names remain readable. Escape or clicking the trigger closes and returns focus; outside clicks keep target focus. Running Chats allow next-draft edits; read-only Chats do not.

## 左侧面板宽度

页面固定为窗口高度，左右内容独立滚动。左侧顶部标题和 New project、底部 Settings 始终可见，中间项目、对话与 Archived 列表独立滚动；右侧长聊天内容仅在右侧区域滚动。

用鼠标或触控板拖动左侧面板右边的分隔线，两个区域实时调整；双击恢复默认宽度。默认 320px，最小 240px，最大 600px，范围不随窗口大小变化。边界始终为 1px 灰线，hover 和拖动稍微加深，8px 透明区域用于抓取。

拖动开始后移出边界仍可调整，松手、窗口失焦或异常中断时保留当前宽度并结束；拖动期间不选择文字，结束恢复正常操作。结束时仅保存改变后的宽度一次，双击保存默认值，不在移动过程中发送请求。

宽度属于数据库对应的唯一用户，由 server 保存到 SQLite，重启 server 或使用新浏览器后恢复。新页面先显示默认宽度，读取成功应用保存值；不使用 localStorage。多个窗口共用最近成功保存的偏好，已打开窗口不实时同步，刷新或重新打开后读取最新值。读写失败不显示提示或自动重试；保存失败保留当前布局，读取失败保留默认，server 数据库读写失败只打印 terminal 日志。

## OpenRouter 通信记录

Settings 提供常规、模型、执行三个水平标签：常规包含语言和 Enter 键行为，模型包含 API 密钥、启用模型及默认模型，执行包含模型调用与子 Agent 上限。普通打开从常规开始；可写对话缺少必要配置时打开模型，并在标题附近提示缺少密钥、模型或两者。标签选择不持久化，切换保留输入、错误和进行中的保存。配置项提供简短说明：密钥清空后会移除；默认模型用于新对话及空模型选择；执行上限说明模型请求次数、子 Agent 的嵌套与累计计数。密钥是否存在由密码框中的值表示，不另显示已配置标签。模态框在标签间保持固定高度并受窗口限制，标题、标签和 Close 固定，仅当前面板滚动；长模型名称和 ID 换行，行操作保留可用。

Settings has horizontal General, Models, and Execution tabs. General contains language and Enter key behavior; Models contains the API key, enabled models, and default model; Execution contains Model Call and sub-Agent limits. Ordinary openings start on General; incomplete required setup opens Models. Tab selection is local and resets on opening, while switching preserves drafts, errors, and pending saves. Short field hints explain clearing the API key, where the default model applies, and how model requests and nested sub-agents count toward execution limits. The populated password field indicates that a key exists without a redundant configured label. The modal keeps a consistent height bounded by the window, a fixed title, tabs and Close footer, and scrolling only within the selected panel. Dropdowns and model add/remove/default actions save immediately. Changed API-key and execution-limit fields save on blur, including clicking another tab or Close; unchanged values need no write, and typing does not save each keystroke. Saving/Saved feedback reflects persistence, and failures retain entered values with field-local feedback. Positive safe-integer execution limits save independently: an invalid or empty draft is not persisted and does not block another valid field. Close and supported backdrop/native cancellation wait for pending saves and commit focused edits before dismissal; invalid input or failed saves keep Settings open and reveal the affected tab. Correct the value or click Close again to deliberately retry; there is no automatic retry loop. Required Settings identifies the missing key, models, or both beside its title.

Settings 是唯一的配置界面，管理 OpenRouter API key、启用的文本模型和可选全局默认模型。SQLite 是用户配置的唯一来源。首次向空列表添加模型会在同一事务中指定它为全局默认；向非空列表添加不改变默认，包括已有列表没有默认的情况。首次添加成功后，关闭 Settings 返回可写 Chat 时按当前默认模型补齐空选择。重复添加不改变默认或顺序。默认模型必须属于启用列表。设置中统一显示所有已启用模型，按添加顺序排列，每行显示名称和较小的模型 ID；非默认行提供 Set default，默认行显示不可点击的 Default，不提供清空默认操作。每行的 × 图标（Disable model）立即移除模型，无需确认。移除默认模型时，按最近成功目录排名自动选择剩余模型；排名内优先，无排名或缓存时选择最早添加的剩余模型。移除最后一个模型则清空默认。失败保留原配置和聊天选择，保存过程中避免重复操作。

密钥在 SQLite 中明文保存，数据库备份也包含密钥；数据库目录和文件仅当前用户可访问，并保持 Git 忽略。密码输入框读取已保存的实际密钥并以密码字符遮挡，成功保存后仍保留值；替换在失去焦点时保存，清空后失去焦点会删除密钥，不提供保存、移除或显示密钥按钮。Settings 专用的 `GET /api/settings/credential` 仅返回 `{ apiKey }`，空值表示未配置，响应禁止缓存；共享模型配置仍只返回是否已配置，密钥不进入 SSE、公共错误、日志或通信记录。保存密钥不执行服务方认证或付费验证。下拉选择和模型添加、移除、默认操作立即保存；已修改的文本与数字字段在失去焦点（包括点击标签或 Close）时保存，不逐键写入，未修改值不写入。执行上限必须是正的安全整数；空值或无效草稿显示字段内错误且不保存，不阻止另一有效字段独立保存。切换标签保留输入、错误及待完成保存，即使无效或失败也可切换。保存中与已保存反馈对应实际持久化结果，失败保留输入。Close 及支持的背景点击或原生取消先保存仍聚焦的修改并等待待完成操作，再隐藏；无效输入或保存失败保持设置打开并显示对应标签。修正输入或再次点击 Close 可主动重试，不自动循环重试。每次 Model Call 捕获当时的密钥，后续替换或删除不改变已发送的调用；prompt、请求、响应和错误使用同一密钥脱敏，包括跨网络 chunk 的内容。

The API-key password field contains the actual persisted key, visually masked, and stays populated after successful saving. Replacing saves on blur; clearing removes the stored credential on blur. No Save, Remove key, or reveal controls are provided. Only the uncached Settings-specific `GET /api/settings/credential` returns `{ apiKey }`; shared model metadata exposes only configured status, and credentials remain excluded from SSE, public errors, logs and communication records. Saving makes no provider-authentication or paid validation call. For a writable Chat, dismissal checks the saved key and at least one enabled model after saving outstanding edits, so a first key entry can save through Close. Removing the key or final model restores required setup. Reopening Settings and restarting restore saved values. Ordinary management dialogs retain their existing hide-without-waiting behavior.

Add model sits below the enabled-model list and focuses the editable Search models by name or ID input beside Cancel. A bordered candidate popup stays inside Settings, opens above when needed, and scrolls independently without moving the title or Close footer. Leaving Models hides the popup and preserves its query; returning to Models does not repeat discovery. Candidates retain cached popular-100 order and exclude enabled models; typing filters locally and never refreshes discovery. No match explains this exclusion. Selection saves immediately; success clears/collapses and returns Add model focus, while failure retains the query and candidates. Cancel or the first Escape clears addition only; a second Escape closes ordinary Settings. Loading and failures appear near addition, successful cache survives refresh failures, and recovery remains reopening Settings or reloading when required Settings cannot close. Closing Settings fills empty writable Chat choices from the current default; valid choices and historical requests remain unchanged.

返回模型标签不会重复刷新目录，离开模型标签会隐藏候选浮层，保留搜索输入。每次打开 Settings 都匿名请求 OpenRouter 最热门的 100 个文本模型（不传 Authorization 或 API key），列表按过去一周 token 使用量排序，只下载一页。模型分区中，启用模型列表下方的 Add model 打开自动聚焦的、带“按名称或 ID 搜索模型”提示的输入框及相邻 Cancel 按钮；候选在输入框旁的浮层中独立滚动，空间不足时向上展开，不改变 Settings 高度或移动标题与关闭按钮；候选仅包含尚未启用的模型，按热门顺序排列。在同一个输入中按名称或 ID 不区分大小写地即时筛选，不发送网络请求。点击候选立即添加；方向键选择候选，Enter 仅确认已高亮的有效候选，不接受任意 ID。成功后清空搜索并恢复 Add model 按钮和焦点，失败保留输入与候选以便重试。Cancel 或 Escape 取消未提交的添加、清空输入并返回 Add model；第一个 Escape 不关闭 Settings，再次 Escape 可关闭普通 Settings，强制设置仍不能关闭。已发出的保存不撤销，期间禁用取消和重复提交。移除在已启用列表中进行，不提供单独 Search、Refresh 或模型保存按钮。加载与筛选无结果分别提示，保存失败恢复已确认状态。服务启动、输入、配置保存与发送不刷新目录；添加仅验证 server 已缓存的候选，server 重启后若页面仍保留旧候选，添加会报错并保留输入，重新打开 Settings 下载目录后再试；刷新失败提示错误并保留上次成功列表，重新打开设置重试；若因缺少密钥或启用模型而无法关闭设置，重新加载页面重试（未保存输入会丢失）。排名仅缓存在 server 内存，SQLite 保存启用成员、名称及能力；成功刷新仅更新排名内已启用模型的信息，不覆盖并发成员修改。跌出前 100 的已启用模型保留能力、默认和历史选择，在统一已启用列表里仍可移除；排名变化不代表模型不可用。已启用列表始终按添加顺序排列，设置默认或排名刷新不会移动行；既存模型在目录失败时仍可使用。

输入区只列出配置的常用模型。思考强度根据模型能力动态显示：不支持指定强度时隐藏，支持时提供相应级别；“模型默认”不发送强度，区别于关闭思考。切换模型保留兼容的强度，否则回到模型默认。可写 Chat 的能力更新使强度失效时，自动保存为模型默认；历史请求保持原样，服务端校验已保存的选择。

模型和思考强度属于 Chat 的当前配置，选择立即通过 Chat 保存接口持久化；不提交 prompt 也能在刷新、切换 Chat 和服务重启后恢复，多个页面通过既有刷新及 SSE 读取已保存的选择，不从历史请求恢复配置。新 Chat 保存当前全局默认模型，初始强度为模型默认；没有默认模型仍可创建空选择 Chat。进入可写 Chat 或关闭 Settings 返回时，空选择有默认模型就保存补齐；有效选择不随默认变化。删除模型在同一事务中清空引用及强度，历史请求保持原样。只读 Chat 不补齐或归一化写入。

提交 prompt 只使用服务端已保存的 Chat 模型和强度；选项保存中禁止发送，保存失败保留已确认选择并显示错误。每次 Model Call 开始读取当前 Chat 配置与密钥，已经发出的请求保持原样，后续调用使用最新保存值。每次工具执行读取 Project 当前目标文件夹并保留范围校验；配置无效时停止受影响执行，不自动重试付费调用。
进入可写 chat 时，如果保存的密钥缺失或没有启用模型，自动打开同一个 Settings modal；Close 会先尝试保存未提交的输入，再检查必要配置；首次输入密钥可直接通过 Close 保存，配置仍缺失时保持打开。保存密钥且至少启用一个模型后，即使没有全局默认或当前 chat 的模型，也可关闭设置。当前 chat 的模型与思考强度只在 prompt 输入区选择，选择无效时不能发送；移除所选模型清空选择及强度；返回可写 Chat 或关闭 Settings 时，存在默认模型就保存补齐，有模型但无默认时可手动选择。移除最后一个模型或密钥时设置变为强制，即使原本是普通设置。配置读取失败明确显示错误与 Retry，保持未知而不猜测配置，禁止发送并保留本页选择及草稿。普通 Settings 隐藏后保留输入、筛选和错误；不覆盖其他管理 modal，不阻碍归档只读历史，已接受的请求继续执行。

配置的修改通过 SSE 同步所有页面，不覆盖未提交草稿。每次通信经凭据脱敏后保存到 SQLite；成功 Response 保存实际完整 JSON，流式增量不保存；未完成调用保留可读部分内容和真实诊断，可在 Agent 的 Request/Response 查看；prompt 和回答也可能出现在记录中。

## 检查与测试

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

自动测试使用真实本地 HTTP server、临时 SQLite/目录、假的 OpenRouter 流和 Chromium；不使用真实密钥或付费 API。覆盖 HTTP 202 提前确认、确认期间输入锁、接受清空、拒绝及确认网络失败保留、终态先于确认、下一条草稿及 Chat/页面隔离；提交调用者分别等待接受和读取终态。覆盖目录列表、glob 路径发现、字面内容搜索、UTF-8 行／列读取、100 条及 2,000 行／50 KiB 限制与续读、二进制拒绝／跳过、多根／改变／零目标范围、范围内隐藏及 `.git` 路径、特殊文件名、越界／符号链接保护、重复同名调用与配对结果、工具错误修正、完成协议、模型调用上限、多次调用输出归属回读、真实 DOM 的逐次 Request/输出/Response 顺序、独立状态/折叠/Copy、按需下载及整个 Agent 的 Send/busy，以及有序增量、partial failure/restart、重连追赶、懒加载与缓存、不保存 SSE/delta 日志、完整 JSON 与服务方元数据、最终响应替换不同或被省略的暂存内容、普通 HTTP 错误正文、格式化 JSON/Copy、标题状态与读取资格、剪贴板反馈、限高换行及内部/外部阅读位置、折叠和 Chat 状态恢复、刷新重置、旧读取保护、分页和阅读锚点；分页不截断完整成功上下文，失败根任务的部分内容不进入后续 Chat 历史上下文；子任务的失败或取消部分输出如实进入父模型通知或取消工具结果。

递归委派验证复用 `test/sub-agents.test.ts` 的真实 HTTP 服务与可控响应，覆盖两 blind 子请求同时开始后释放 3/7、父模型收到终态后输出 10，以及 A 部分失败后由父模型主动取消 B、等待流/工具清理并原样回传部分结果。覆盖递归终态与 busy、当前配置/祖先覆盖、16/32 及当前上限计数、八表归属、重启保留记录且不重放。Chromium 覆盖完整工具卡片、树与详情、两种语言、局部/根停止、阅读位置及刷新恢复；显示折叠不改变实际模型输入。

GitHub CI 使用 Node 24/pnpm 11，运行格式、类型、构建、后端测试及同一套 headless Chromium E2E。Linux 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器和系统依赖。浏览器测试失败会令 CI 失败，并上传 `playwright-failure` artifact（保留 7 天），包含 HTML 报告和失败 trace；在 Actions run 页面下载后，可用下面的命令查看。

本地默认只输出终端结果，不生成 HTML 报告；失败时在 `test-results/` 保留 trace。`pnpm test:e2e` 全部通过后自动删除 `test-results/`，失败时保留结果和非零退出码。直接运行 `pnpm exec playwright test` 不执行这一步清理。`playwright-report/` 和 `test-results/` 均已忽略；已有 HTML 报告不会自动删除。

```sh
pnpm exec playwright show-report playwright-report
pnpm exec playwright show-trace test-results/<失败用例目录>/trace.zip
```

### 编辑项目和对话

通过侧栏项目或对话旁的 ⋯ 菜单打开编辑框。项目可修改名称和添加/移除目标文件夹（允许零个）；对话可改名，历史和活动排序不变。回答进行中仍可编辑。未变的已存文件夹即使后来不存在，也不妨碍改名；新增文件夹仍须有效。

普通管理编辑框（不同于先保存再关闭的 Settings）关闭仅隐藏，同一目标重新打开保留未保存的内容和错误；换目标加载对应数据。保存期间可关闭，保存继续完成；为避免保存到错误目标，完成前不能切换编辑/创建目标或重复保存。失败保留草稿供重试，成功后再次编辑读取最新服务端数据。保存结果持久化并同步其他页面，未提交草稿仍仅属于当前页面。

### 归档与恢复

⋯ 菜单可直接归档或恢复，无确认框。project 和 chat 各自持久化独立归档状态，归档 project 不改变其 chats 自身标记。正常列表仅显示未归档 project 和未归档 chats；侧栏底部 Archived 默认折叠，按 project → chat 分组：归档 project 标记“(project archived)”并包含全部 chats，正常 project 的分组只列其单独归档 chats。列表继续按原活动时间排序，改名、归档及恢复不使条目跑到最前。

归档后只读：project 不能改名、更新文件夹或创建 chat；chat 自身或父 project 任一归档时不能改名或提交新问题，server 同样拒绝这些操作。只读 chat 隐藏整个 prompt 区域（模型、思考强度、输入框及发送控件），保留历史、当前任务状态及恢复提示；查看历史无需模型或 API key，也不会强制打开 Settings。仍可查看历史和恢复。恢复 project 保留各 chat 原标记；父 project 归档时可恢复已单独归档的 chat，但它仍因父状态只读，需要恢复 project 才可继续使用。

归档允许在回答或保存进行中执行，已接纳的操作继续完成、保存及同步，不取消请求。当前选中 chat 不自动切换或清空，主区域保留历史、提示只读原因，已开始的回答继续更新。现有编辑及提问草稿保留；恢复后重新判断可用操作。编辑、归档及恢复经 SSE 同步所有页面，当前查看的 Chat、未提交草稿及 Archived 折叠只属于本页；刷新后 Archived 重新折叠，重启保留所有已提交的归档状态和历史。

侧栏的 New project 默认透明无描边，标题行、+ / ⋯ 图标按钮及菜单项有浅灰圆角 hover 反馈（禁用菜单项置灰）。⋯ 使用原生 Popover：点击外部关闭，打开其他菜单关闭旧菜单，选择动作立即关闭后执行。菜单与 ⋯ 下方右对齐，靠近底部时向上避让，不被侧栏裁切。+ 提供“New chat”悬停提示。

## Sending shortcuts

Enter sends by default; Shift+Enter inserts a newline. Cmd+Enter on macOS or Ctrl+Enter on Windows/Linux sends in either mode, based on the browser platform rather than the server OS. Settings → Enter key behavior can make plain Enter insert a newline, saved immediately without an extra Save action. The Send tooltip and accessible name show the active shortcut.

The semantic send/newline preference is stored in SQLite and synchronized across pages, refresh, restart and SSE reconnect. Fresh databases default to Send; old schemas are rejected without migration or automatic reset. While the preference is unknown or cannot be read, plain Enter does not send; the draft and explicit Send button remain usable, with an error and Retry in Settings. Failed or ambiguous saves reread the server, and stale reads cannot overwrite newer confirmed settings.

Shortcuts apply only to the prompt textarea. IME composition/confirmation and held-key repeats never submit; other fields and option popups retain their local Enter behavior. Shortcuts reuse the same empty/configuration/read-only/busy guards as Send, remaining disabled throughout the entire Agent. Editing during work affects the next local draft only, and failures never trigger automatic retries.

## 发送快捷键

默认 Enter 发送，Shift+Enter 换行；macOS 使用 Cmd+Enter，Windows/Linux 使用 Ctrl+Enter，在两种模式下均可发送。按用户浏览器平台确定快捷键，与 server 操作系统无关。Settings 中的“Enter 键行为”可改为普通 Enter 换行，立即保存，无单独 Save；Shift+Enter 始终换行。发送按钮的悬停提示和无障碍名称显示当前快捷键，不额外占用输入区一行。

偏好以语义值 send/newline 保存在 SQLite，刷新、重启、SSE、断线重连及多页面同步后恢复；新数据库默认 send，不升级旧 schema。读取失败或尚未确认时不会将未知偏好当作 Enter 发送；草稿和显式 Send 按钮仍可用，Settings 显示错误及 Retry，不写回默认。保存失败重新读取并保留服务端确认值；结果不明时同样核对服务器，较旧读取不能覆盖新值。

快捷键仅处理问题输入框，模型弹层、其它字段的 Enter 保留自身行为。输入法组合及确认、按住 Enter 的重复事件不会发送；所有发送方式复用相同保护，无法绕过空白、只读、缺少配置或整个 Agent 进行中时的禁用规则。期间可编辑下一次草稿和选项，不修改已接受请求；失败不会自动重发。

## 界面语言

Settings 中可选择 English 或简体中文。默认英文（en），支持 zh-CN；i18next 与 react-i18next 使用随应用打包的本地资源，缺少翻译时回退英文，不自动检测浏览器语言，不加载远程翻译。Agent 角色标识沿用英文 fallback。

选择后立即保存，无额外保存按钮。语言由 server 的 SQLite 用户配置维护，保存确认后生效，通过 SSE 同步所有页面，包括隐藏中的设置框；刷新、断线重连与重启恢复。首次页面先读取已保存语言再显示主界面，失败显示英文错误及 Retry，不会将英文写回覆盖配置。保存失败保留已确认语言，可重试；结果不明时重新读取 server。

语言切换更新界面标签、菜单、状态、placeholder、悬停和可访问名称，以及已经显示的应用错误。名称输入、问题草稿、已存名称、路径、对话历史和模型回答保持原样。新的一份创建草稿用当前语言生成默认名；已有草稿（包括未改过的预填名）和同一目标隐藏重开保持，不追踪默认名是否修改。外部错误详情及原始 request/response 保留原内容，凭据仍脱敏，terminal 技术日志不翻译。

## Local file tools / 本地文件工具

The delivered read-only tools are `list_files`, `search_files` and `read_file`. Ask to discover TypeScript paths, find a literal phrase or read a file in the Project's Target Folders. Each Tool Call performs one operation; several calls in one model response retain separate IDs/results and execute in order before the next model request.

| Tool | Arguments and result bounds |
| --- | --- |
| `list_files` | Absolute directory `path`; without `pattern`, list its immediate entries. Optional `pattern` recursively discovers paths using Node `path.matchesGlob` syntax against relative paths (for example `**/*.ts`). `offset` defaults to 0; return at most 100 entries. |
| `search_files` | Absolute directory `path` and nonempty `query`; recursively search UTF-8 text for a literal, case-sensitive query, without regex. `offset` defaults to 0; return at most 100 matching lines with file, line and 1-based Unicode column locations. |
| `read_file` | Absolute file `path`; optional 1-based `startLine` (default 1), inclusive `endLine`, and `startColumn` (default 1, Unicode code points). Return at most 2,000 lines or 50 KiB of text, whichever comes first. |

For truncated lists/searches, repeat the same arguments with the returned `nextOffset`. For truncated reads, use `nextLine` and `nextColumn` as `startLine` and `startColumn`, retaining the requested `endLine` if any. Column continuation allows reading a single line longer than 50 KiB without dropping text. Search returns one result per matching line, with up to 4,096 Unicode code points of text around its first match; `textStartColumn` and `textTruncated` identify a clipped excerpt. Read rejects binary/invalid UTF-8; search skips those unsupported files. Listing can include binary files. Recursive listing/search does not follow descendant symlinks, even within scope.

Every execution reads the Project's current Target Folders. All selected roots are equal; absolute paths must resolve inside at least one root. Changes affect future calls and leave saved results intact. Traversal, sibling-prefix paths and escaping symlinks are rejected; recursive discovery/search does not follow links outside scope. Hidden paths and `.git` are accessible inside scope, and Git is not required. OS permissions still apply. With no selected folders, text-only chat still works and file tools return a scope error; choose **Edit project → Add folder** to enable file access.

Examples (replace `/project` with a selected absolute Target Folder):

```json
{"name":"list_files","arguments":{"path":"/project","pattern":"**/*.ts","offset":0}}
{"name":"search_files","arguments":{"path":"/project","query":"create_sub_agent","offset":0}}
{"name":"read_file","arguments":{"path":"/project/README.md","startLine":1,"endLine":80}}
```

The final design also includes `write_file` (create/replace UTF-8 text and missing parents), `edit_file` (one exact replacement with exactly one match), `move_path` (rename/move one file or folder to a nonexistent scoped destination), and `delete_path` (delete one file or recursively delete one folder). These four mutation tools are tracked in [#126](https://github.com/tylerlong/tyler-agent/issues/126) and are not advertised by this read-only slice. No shell, multi-path batch, Git checks or recovery guarantee is provided. Invalid tool names, JSON, argument types, extra arguments, scope violations and execution errors produce truthful Tool Results; the model can correct its request. Cancellation/errors retain actual saved results and do not automatically retry.

当前已交付的只读工具为 `list_files`、`search_files` 和 `read_file`。可要求查找 TypeScript 路径、搜索字面文本或读取目标文件夹内的文件。每次 Tool Call 只执行一个操作；同一模型响应中的多个调用（包括同名调用）保留各自 ID 和结果，按顺序执行完毕后才继续请求模型。

`list_files({path, pattern?, offset?})` 的 path 为绝对目录路径，无 pattern 时列出当前层条目；有 pattern 时递归发现路径，使用 Node `path.matchesGlob` 对相对路径匹配（如 `**/*.ts`）。`search_files({path, query, offset?})` 递归搜索 UTF-8 文本，query 为非空、区分大小写的字面文本，不支持正则；每个匹配行返回一个结果，包含文件、行及从 1 开始的 Unicode 列位置。两者 offset 默认为 0，每次最多返回 100 个条目／匹配，截断后保留原参数，以返回的 nextOffset 继续。

`read_file({path, startLine?, endLine?, startColumn?})` 读取一个 UTF-8 文件；行与列从 1 开始，默认 startLine/startColumn 为 1，endLine 包含该行，列按 Unicode 码点计数。每次最多 2,000 行或 50 KiB 文本，先达到者为准。截断时将 nextLine/nextColumn 作为下一次 startLine/startColumn，并保留原 endLine（如有）；单行超过 50 KiB 也可续读，不丢失文本。搜索返回首个匹配附近最多 4,096 个 Unicode 码点的文本，textStartColumn/textTruncated 标明片段位置及截断。读取拒绝二进制／无效 UTF-8，搜索跳过这些文件；列表可包含二进制文件。递归列表／搜索不跟随后代符号链接，即使链接仍在范围内。上面的 JSON 示例需将 `/project` 替换为所选的绝对目标目录。

每次执行重新读取 Project 当前目标文件夹，所有根目录平等；路径解析后必须在至少一个根目录内。更改范围影响后续工具，不改写已存结果。拒绝越界遍历、共享前缀邻接目录和逃逸符号链接，递归发现／搜索不跟随范围外链接。范围内隐藏路径及 `.git` 均允许访问，无需 Git，仍受操作系统权限限制。零文件夹项目仍可纯文本聊天，文件工具返回范围错误；通过 **编辑项目 → 添加文件夹** 配置访问范围。

最终设计另含 `write_file`（创建／完整覆盖 UTF-8 文件及缺失父目录）、`edit_file`（恰好一个匹配的精确替换）、`move_path`（移动／重命名一个文件或文件夹，目标须不存在且在范围内）、`delete_path`（删除一个文件或递归删除一个文件夹）。四个修改工具由 [#126](https://github.com/tylerlong/tyler-agent/issues/126) 交付，本只读阶段不提供这些能力。不提供 shell、多路径批量操作、Git 检查或恢复保证。非法工具名、JSON、参数类型、额外参数、越界及执行错误返回真实工具错误，供模型修正；取消及错误保留实际已存结果，不自动重试。

只有完整有效的 completed 响应才触发工具，先组装参数，再按输出顺序执行；工具-only 或混合文本响应都可继续。后续请求携带完整 output items（含推理元数据）与对应 `call_id` 的 `function_call_output`，模型可修正工具错误并重新调用。每 Agent 默认最多 16 次实际模型请求，初次、失败及子任务终态通知触发的调用均计入。最后允许的调用可用最终回答成功；若仍请求工具则保存为未执行，不发起超限请求。远程请求、协议或持久化失败立即停止，不自动重试付费调用。

整个循环期间 Send 保持禁用。后续失败、上限或重启中断仍保留已保存的思考、回答和通信，不恢复执行。后续 Agent 使用完整成功问答历史，不要求重放旧工具轨迹；失败 Agent 不进入后续上下文。

## 独立 Tool Call 记录

完整有效的模型工具请求提交后，为每次 Tool Call 独立保存身份、所属 Agent/Model Call、原始 call_id、工具名称、参数与响应内顺序。不同 Model Call 重复 call_id 和同名调用各自独立；参数 delta 不生成卡片。一次响应全部调用先保存为等待，再按模型顺序逐个保存运行状态、执行和保存终态与 Tool Result，之后才发出下一次模型请求。工具失败允许模型继续处理，成功/失败由执行层明确提供，界面不猜测结果的 error 字段。

通用卡片在所属 Response 后、下一次 Request 前默认折叠，手动展开或折叠在执行结束后保持。标题显示“工具调用 · 工具名称”（英文为“Tool Call · 工具名称”），保留真实工具名称，等待标记与运行 loading 本地化，成功不附 Completed，失败保留标记及真实结果。参数和结果明确分区，JSON 缩进、非 JSON 和空结果保留原文本；保留所有字段（包括文件路径和续读位置），不使用工具专属渲染。凭据按该 Agent 已使用的密钥脱敏保存，实际下一次模型请求的工具结果契约保持不变。

历史和独立 Agent HTTP 读取携带工具身份和状态；`GET /api/agents/:id/tools?toolId=:id` 读取该工具的已保存参数与结果，归档后仍可读取。通过现有 Agent SSE 通知同步，不定时轮询；浏览器刷新或断开不取消服务端执行，Send/busy 覆盖整个循环。已经保存的工具结果不依赖下一次 Request，后续模型请求失败也不丢失。测试在真实 HTTP 与 Chromium 边界使用模拟模型和可控工具，不调用真实付费模型。

工具卡片默认折叠，第一次展开才下载该调用的参数与结果；折叠期间通过元数据更新标题中的等待、运行与异常状态。完成不改变手动选择，已经读取的缓存继续随状态更新。参数和结果共用最大高度 `min(400px, 50vh)` 的内部滚动区，短内容自然收缩，长行换行，标题与操作按钮保持在正文外。JSON 仅缩进原始 token，保留大数字、重复字段与嵌套数据；普通文本、非法 JSON 和空结果原样显示。终态且成功读取当前记录后才显示 Copy，复制标题下全部格式化正文（参数、结果、真实错误及原因），排除标题、控件和临时读取/运行反馈；折叠已缓存卡片仍可复制。复制失败可重试，读取失败保留缓存并提供读取重试，两者都不重新执行工具或模型。页面内切换 Chat 保留每次调用独立的折叠、下载和滚动位置，状态增量不自动滚动；刷新清除页面缓存，恢复默认折叠，首次展开才重新读取已保存内容；终态但尚未读取的卡片没有 Copy。Chromium 覆盖默认折叠与首次展开读取、中英文类型标题、终态资格、脱敏与完整复制、剪贴板反馈、通用数据、限高与换行、折叠/切换/刷新、阅读位置、读取重试及旧下载保护。

服务重启把已保存但仍等待/运行的 Tool Call 标记为执行中断，保留参数、已经保存的结果及终态；不恢复或重执行工具/模型。最后允许的 Model Call 仍请求工具时保留请求并显示未执行原因，不产生 Tool Result，也不发出超限请求。工具失败只表示本地执行失败，模型可继续修正；后续模型通信失败不改写已保存工具结果。调用建立或开始状态保存失败时停止后续执行，工具尚未启动；结果/终态保存失败停止后续模型调用，显示保存失败而不伪造工具错误或已保存结果。保留已提交记录，无法持久化终态时通过读取/通知显示中断和保存失败说明，避免永久 loading；重启后未结束记录按中断处理。测试使用临时数据库与 SQLite 写入失败注入覆盖这些边界，不再次删除实际开发数据库。


## 保存Agent与模型通信

通过 direct fetch 向配置的 OpenRouter Responses 模型发送 `stream: true`，无 SDK 或自动付费重试；每次模型请求均提供当前已交付的文件工具及子 Agent 工具和调用开始时读取的 Project 当前目标路径。思考与回答按实际 output item/content part 顺序交错显示，支持多个文本、refusal、推理正文和摘要；同一思考块分别标注正文和摘要，reasoning item 内的 output_text 仍属于思考，encrypted reasoning 仅保留在原始通信中。思考在所属模型调用进行中默认展开，该次调用成功、失败或取消后默认折叠，即使下一次调用仍在进行；手动选择在当前页面内更新和切换对话时保留，刷新后重置。历史初读只有有序块元数据和回答，思考正文与摘要展开才下载，已下载内容保留到刷新并持续同步进行中的增量。每个问题仅显示一次，随后逐次显示 Request 1 → 本次思考与回答 → Response 1 → 本次 Tool Call 卡片 → Request 2 → 本次思考与回答 → Response 2；编号在每个 Agent 内从 1 开始，单次调用也如此。成功 Model Call 只保存服务方实际完整响应 JSON，思考与回答从该响应派生；未完成或失败调用的 output_json 只保存可读部分快照，成功时清空；按本地创建顺序及调用内原始 item／part 顺序展示；调用内 index 不跨调用偏移。不重复显示聚合回答。没有思考或回答的调用不生成空块，只有工具请求的调用仍保留 Request/Response；Agent 回答从各调用的消息／refusal 文本按顺序派生，含工具前片段、不含思考；仅更早成功 Agent 的 prompt 与派生回答进入后续上下文。只有协议 completed、含可用回答且没有待执行工具才成功，EOF、[DONE]、单个 item 完成不代表成功。失败保留部分回答并标记不完整。

Agent 与 Model Call 分别保存；每次调用的 Request/Response 围绕该次输出展示，工具参数与结果还可通过独立 Tool Call 卡片查看。通信记录保留 URL、method、请求时间、实际请求正文、HTTP 状态、耗时及错误，不保存 headers。HTTPS 继续实时流式传输，Reasoning 与 Answer 增量立即显示，但不持久化 SSE 帧、delta 事件日志或转录。只有协议接受实际完整响应才算 Model Call 成功；EOF、DONE、item 完成或 HTTP 正文读完都不够。成功保存脱敏后的完整响应对象及全部服务方字段，并以最终 output 替换暂存思考和回答；最终响应省略的项或段落不残留，不另存成功可读输出副本或 Agent 聚合输出。进行中保留可读部分快照，失败、取消及重启中断保留部分内容、已知状态/耗时和实际收到的错误响应或 HTTP 错误正文。跨网络 chunk 的凭据仍先脱敏。

Live deltas immediately update Reasoning and Answer but are never stored as SSE frames or event transcripts. An accepted actual completed response is the successful Model Call's sole final representation, including provider fields and ordered output items. Final content replaces provisional content, including omitted items or parts; readable output, lazy Reasoning, Agent/child results and continuation input derive from that JSON. Unfinished calls retain readable partial snapshots, known status/duration and actual error responses; success clears the snapshot. EOF or DONE alone cannot imply success. Credentials remain redacted across split chunks.

对话历史摘要不包含通信正文。`GET /api/agents/:id/calls` 独立读取调用记录，归档后仍可读取。Request 和 Response 默认折叠，展开才下载；成功 Response 显示实际完整 JSON 的缩进格式，不显示 response.completed 事件外壳。进行中及失败视图说明部分内容性质，显示已有可读快照、实际诊断和已知 HTTP/耗时，没有 raw-stream 按钮。每笔通信共用最大高度为 `min(400px, 50vh)` 的滚动区，长行换行；标题与 Copy 在区外。进行中显示本地化 loading，失败保留标记；调用状态独立于下载状态和 Agent 状态。调用结束且正文成功读取后才能 Copy；Copy 与本地搜索使用同一完整格式化显示内容，不受滚动窗口限制。本地搜索按字面子串高亮匹配，不改变 Copy 内容。复制失败可重试，不执行或重发模型。内部阅读位置、手动折叠及已下载内容在增长、最终替换、Chat 切换、归档、语言及同步时保留（新内容高度不足时由浏览器限制位置）；整页刷新重置。读取失败保留已有内容并提供 Retry。

Completed Response disclosure, Copy and local search use the same formatted actual final JSON, without the response.completed envelope or a hidden event log. Local search highlights literal substring matches without changing copied text. Unfinished disclosures identify provisional content and actual diagnostics. Request/Response reads remain lazy; disclosure choices, caches and reading positions survive live-to-final replacement where the new content permits them. Read failures offer Retry without another model request. The approved development database rebuild, including old configuration/history, occurs once at final delivery #130. There is no migration or historical SSE compatibility; ordinary startup refuses unsupported databases and never deletes data automatically.

服务启动将遗留进行中的 Agent 和调用标记为重启中断，保留已保存信息，不恢复发送。已保存的部分回答、按序输出项和通信正文继续保留；失败Agent不进入后续模型上下文。

OpenRouter 通信始终保存到 SQLite，已移除 terminal 通信日志、Settings debug 开关及相关启动配置。普通服务错误日志仍保留。当前 schema 不包含废弃 debug 配置。侧栏齿轮可打开语言、模型及密钥设置。

### 分页历史与页面缓存

打开 chat 默认只读取最新 10 个 Agent（包含进行中与失败），按旧到新显示。顶部“Load earlier agents”每次读取更早的 10 个；没有更早记录时入口消失。稳定 ID 边界使新增提问不影响旧页，历史摘要不下载通信正文。分页仅影响展示，模型仍使用完整成功问答上下文。

已下载历史、思考、问题草稿以及通信正文和展开状态保留在当前页面中，切换 chat、实时通知、同步错误、语言或归档不会删除它们；整页刷新后重新从最新 10 个初始化。缓存不使用 localStorage 或 cookie。SSE、重连、页面重新可见、窗口获得焦点和切回 chat 都核对服务器最新状态，补齐尚未下载的新Agent（超过 10 个也分批补齐），同时保留已有内容。流式通知仅更新发生变化的 Agent，不逐 token 重读项目列表和已缓存历史，不增加 throttle、debounce 或定时批处理。已下载的 pending 思考和原文即使折叠也追赶当前保存的内容；较旧的异步读取不得覆盖较新的同步结果。同步或加载更早失败显示可重试错误。

### 固定输入区与阅读位置

右侧标题、文件夹信息、问答及 Request/Response 在内容区独立滚动，可写 Chat 的底部圆角输入区固定；只读 Chat 隐藏整个输入区。Prompt 提示放在 placeholder，输入框从约 2 行随草稿增长/缩小，到约 8 行后内部滚动；框内右下角箭头发送按钮始终可见且尺寸固定；空白、配置缺失或无效选择时禁用。Send 从点击发送开始到整个 Agent 成功或失败结束持续禁用。确认提交期间保留原文并暂时禁用原 Chat 的输入框；HTTP 202 确认后清空提交页原 Chat 的草稿并恢复编辑，可准备下一条草稿。执行成功、失败或中断不会清空或回填下一条草稿。接受前拒绝保留原文并恢复编辑，按当前条件重新判断 Send；确认网络失败同样保留原文、恢复编辑并核对历史和 busy，未收到确认不代表拒绝。可以切换 Chat，确认不影响后来选中 Chat 或其它页面的草稿；对话选项仍可编辑，不改变已捕获请求，不自动重试。底部控件始终留在输入区；左侧固定头尾及列表滚动保持独立。加载更早记录、文本增量增长及展开/折叠保持正在阅读的内容锚点，即使已展开的思考或通信正文很长。

首次打开 chat 显示最新内容，自己提交后跟随到底部（包括进行中与回答完成）。其他页面产生的新内容或状态变化只在本来位于底部时跟随，阅读旧内容时不跳转。每个 chat 的阅读位置仅保存在当前页面；切走再返回恢复原位置，即使期间新增Agent，也不强制跳到最新。已下载历史、草稿和通信展开状态继续保留；整页刷新后重新加载最新 10 个并显示底部，不使用 localStorage 或 cookie 保存阅读位置。

### Project-owned creation and empty states / 项目内创建与空状态

Each writable Project keeps its + action. An expanded Project with no visible nonarchived Chats also offers New chat, including Projects containing only archived Chats. Populated or collapsed Projects hide the inline action; archived Projects offer neither creation action. Both open the existing form identifying the owning Project, and save only when Create is submitted. Cancel preserves the draft; creating a Project never creates a Chat automatically. The homepage guides selection or creation within a Project. Without a writable Project it points to New project in the sidebar; Archived remains accessible. Project reads distinguish initial loading, retryable failure, and successful empty results, retaining previously usable lists on read failure. A selected Chat shows first-question guidance only after successfully loading empty history; loading and errors have distinct presentation and Retry, preserving cached or partial content. Archived Chats retain their restore/read-only guidance. Unknown Chat IDs redirect to home.

每个可写项目保留 +；展开且没有可见未归档对话时，另显示新建对话按钮，包括仅有归档对话的项目。有对话或折叠时隐藏行内入口，归档项目不提供创建。两种入口都打开标明所属项目的原创建框，仅点击创建后保存，取消保留草稿，创建项目不自动创建对话。首页提示在所属项目内选择或创建；无可写项目时提示侧栏新建项目，仍可访问已归档数据。项目初始加载、可重试读取失败和成功空列表分别显示，失败保留已有列表。所选对话只有在成功加载空历史后才提示输入第一个问题；加载与失败分别显示，可重试，缓存和部分内容保留。归档对话继续显示只读及恢复提示；未知对话 ID 返回首页。

Writable Chats keep the lower-right Send button visible at a fixed size, including empty drafts. Read-only Chats hide the entire composer. Whitespace, unavailable configuration or invalid options disable Send. It disables immediately on submission and throughout the whole Agent, then recomputes availability after success, failure or rejection. Prompt stays visible and temporarily disabled until submission confirmation. Acceptance clears only the originating page and Chat draft and restores editing; later execution outcomes preserve the next draft. Rejection or lost acknowledgment preserves the original text; lost acknowledgment refreshes history and busy without automatically retrying. Chat Options edits save immediately; subsequent Model Calls use the latest saved choices. Fixed footer space prevents visibility or enabled-state changes from moving the input, while multiline drafts still grow and shrink normally.

Agent identity: each accepted prompt creates an Agent in its Chat. Model Calls reference `agents` via `agent_id`; Tool Calls store only `model_call_id` and derive task ownership through that call. Chat and Project activity derives from root Agent acceptance times, with creation-time fallback and descending ID ties; finishing answers, editing names or options, reading, archiving and restoring do not change activity.

The new schema requires a fresh database. Old schemas are rejected without migration or automatic deletion. Verification uses isolated temporary databases and fake model responses; development database deletion or rebuilding requires separate authorization.

Model Call 保存可读输出、调用错误码与错误文本；根 Agent 保存 prompt，子 Agent 仅引用创建 Tool Call；各 Agent 保存生命周期和任务自身错误码，失败摘要从所属失败调用派生。调用次数上限不会改写已成功的 Model Call。按需思考读取使用 `GET /api/agents/:id/reasoning?callId=<local-model-call-id>` 并校验所属 Agent；阅读缓存、界面 key 和滚动锚点使用稳定本地调用 ID，服务方 ID 与显示编号不确定归属。刷新、重启和分页保留已保存的部分输出及 Tool Result，不重试模型或重放工具。


### 子 Agent 委派

模型可调用 `create_sub_agent({prompt, context?, model_id?, reasoning_effort?})` 并行创建子任务，子任务可递归创建。prompt 必须为非空文本，context 默认空字符串；没有隐式祖先对话继承。子任务默认继承直接父 Agent 的有效模型与思考强度，并使用 Project 当前文件范围。可选 `model_id` 必须为 Settings 已配置模型 ID；请求说明提供当前 ID、名称和允许强度。省略 `reasoning_effort` 继承，显式 `null` 使用模型默认；只覆盖模型时保留兼容强度，否则使用新模型默认。显式不支持的强度返回工具错误。每次创建与 Model Call 从根 Chat 当前选择沿祖先创建参数合成最终配置，再校验模型能力；有效显式模型可覆盖已失效的根选择。覆盖只保存在创建工具 arguments，孙任务继承中间覆盖，不修改父或 Chat 配置；实际请求记录保留当时使用的值。创建立即返回 `{agent_id, status: "pending"}`，只表示已启动。

每个子任务成功、失败或取消后，运行服务将 Agent ID、真实状态、全部已有可读输出及实际错误作为普通输入自动交给直接父模型，包括失败时的部分输出。没有等待或轮询工具，也不因流式文字触发父模型调用。父任务在子任务仍运行时保持 pending 和 Chat busy；父自身失败或达到上限仍等待后代结束，通知不会重启已失败的循环。子任务失败不自动取消兄弟或使父任务失败。

八张表保留精确归属：根 Agent 保存 Chat/prompt，子 Agent 唯一引用创建 Tool Call；prompt/context、parent、根 Chat 和 Project 从关系派生。`GET /api/agents/:id` 回读来源、详情及已有调用；子 SSE 不进入根 Chat 历史或改变最近活动。现有折叠 Tool 卡片可检查完整创建参数与结果。Settings 的“执行上限”提供两个持久化正整数：每 Agent Model Calls 默认 16，每根树累计后代默认 32。`GET /api/execution-limits` 读取当前值，`PATCH /api/execution-limits` 接受 `modelCallLimit` 与/或 `subAgentLimit`，拒绝非正整数。修改或重启后后续模型请求、子任务创建读取当前值；已发请求与已创建任务继续执行。降低到已用数量以下阻止新工作；失败调用计入执行者，所有层级、成功/失败/取消后代仍累计计数，根不计、终态不退名额，无效参数或配置不创建子任务。最后允许的 Model Call 请求工具时保留请求并标记未执行，以 `modelCallLimit` 停止自身循环，不为子任务通知越限调用。任务树与详情见下方说明。


此 schema 更新仍要求新的临时或明确指定数据库；普通启动不会迁移或删除旧数据。重启保留部分记录并标记未结束工作为失败/中断，不重放模型、工具或通知。

### 停止 Agent / Stop an Agent

Each running root Agent has a Stop button in chat history, including archived read-only Chats. Stopping… is immediate local feedback; the Agent remains pending and the Chat stays busy until the Agent and descendants have actually stopped and cleaned up. Stop interrupts in-flight model requests and controlled tools, retains saved partial output and records, and marks unfinished work cancelled. Completed work retains its original result. Stopping does not restore an archived Chat or enable its prompt/configuration editing, clear the next draft, or retry a model call.

运行中的根 Agent 在对话历史中提供停止按钮，归档只读对话中也可使用。点击后立即显示正在停止；实际请求、工具和后代清理结束前仍保持 pending 和对话 busy。保留已保存的部分输出与记录，未完成任务进入 cancelled，已结束任务保留原结果。停止不会恢复归档、开放输入或配置编辑、清空下一条草稿或重试模型。

`POST /api/agents/:id/cancel` stops the target subtree and returns its terminal status, saved readable output and error only after cleanup. A model can call `cancel_sub_agent({agent_id})` for one of its direct children, stopping that child and descendants while the parent and siblings continue. Ordinary user cancellation still notifies the direct parent; the same terminal result already delivered by the cancellation tool is not delivered twice.

### 任务树与 Agent 详情 / Task tree and Agent details

Each root prompt in Chat history has a **Task tree** button. The tree shows recursive children with their own Pending, Succeeded, Failed or Cancelled state. Expand a node to see deeper descendants; select any node to use the same Agent output, thinking, Tool Call and lazy communication view as root history. The detail shows the full prompt, explicit context and unmodified creation arguments, including model/reasoning overrides. A successful `create_sub_agent` Tool Call means the child was created; its own tree status shows whether its execution succeeded.

Use the task path, sibling links or **Back to chat** to navigate. The selected Agent is encoded in the URL, so refresh and reconnect restore its persisted tree and details. Task details have no prompt composer. **Stop** acts on the selected pending Agent and its descendants, including in archived Chats; siblings and parents continue, and Cancelled appears only after cleanup. Child updates do not enter root history, change recent activity or release Chat busy.

对话历史中每个根 prompt 的“任务树”可展开递归后代并查看各自状态。点击节点复用根任务的输出、思考、Tool 卡片和按需通信读取，详情展示完整 prompt、显式背景及原始创建参数（包括模型与思考强度覆盖）。创建工具成功只代表子任务已创建，不代表子任务执行成功。任务路径、兄弟链接和“返回对话”用于导航；URL 保存所选 Agent，刷新或重连恢复持久化关系。子任务详情无追加输入；“停止”只取消所选进行中节点及后代，归档中仍可用，清理结束后才显示已取消。
