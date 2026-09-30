# Tyler Agent

TypeScript/Node.js 本地网页应用。React SPA 由 Vite 和 Tailwind 构建，原生 Node HTTP server 使用 SQLite 保存项目与对话。

## 运行

需要 Node.js 24 和 pnpm 11。

```sh
pnpm install
pnpm start
```

`pnpm start` 先构建页面再启动服务，打开 `http://127.0.0.1:3000`。`PORT` 可改变端口；修改页面后重新启动即可。

默认数据库为项目根目录的 `data/tyler-agent.sqlite`，默认目录自动创建。可指定数据库：

```sh
pnpm start --db /path/to/chat.sqlite
```

相对路径按启动工作目录解析；自定义路径的父目录须已存在且可写。数据库无法打开、未知/损坏 schema 或初始化失败时服务报错退出。

## 项目与对话

左侧点击“新建 project”，在原生 modal 中输入非空名称及至少一个文件夹路径（每行一个）。路径按服务启动工作目录解析，保存为绝对路径；创建时检查存在、可访问且为目录，并拒绝重复解析路径。所有文件夹平等，本阶段只保存配置，不读取/修改文件或向模型发送文件夹。名称允许重复。

所有 modal 始终挂载，取消或 Escape 只隐藏界面，提交期间也允许关闭，不取消请求或重置输入、错误及进行中状态；再次显示直接使用现有状态，不另行缓存或恢复。提交中禁止修改创建输入或切换创建目标，并禁止重复提交；原目标的创建入口可重新显示进行中的表单，设置仍可打开。创建成功后独立清空对应表单；失败保留输入，旧创建响应不关闭设置框。切换到不同的创建目标是显式动作，可以重置创建表单。

每个 project 可创建多个具名 chat，空 chat 立即保存，不自动生成 chat。创建成功后仅当前页面选中它；其他页面通过 SSE 更新列表，不改变选择或折叠。项目默认展开，折叠状态仅当前页面有效。右侧显示所选 project/chat 和只读文件夹；没有选择时留空。

每个 chat 的提问与追问仅使用自己的成功历史。问题与回答一起保存；模型或数据库写入失败不加入历史，错误保留在发起页面的原 chat，草稿可重试。busy 由 server 按 chat 保存：同 chat 请求进行中时所有页面禁止再次提交，server 返回 409；不同 chat（包括同项目）可以同时请求。侧栏标记运行中的 chat，目录之后失效也不阻止纯文本聊天。

选择只保存在本页 URL 的 `?chat=<id>`，刷新和浏览器前进/后退恢复；无参数不自动选择，未知 ID 留空并报错。每个 chat 的草稿仅存在当前页内存，切换恢复、刷新丢失，不跨 tab 分享。请求时可以切换 chat；回答写回原 chat，不清除后来编辑或其他 chat 的草稿。SSE 重新读取历史/busy，不覆盖草稿或选择。

列表按 server 接受合法提问的时间排序：chat 最近提问优先，project 按其 chat 中最新的活动优先。不等待模型回答，上游失败也保留活动时间；空 prompt、未知 chat 和 busy 拒绝不改变排序，回答完成不再次更新。未提问的 chat 使用创建时间，没有 chat 的 project 使用自身创建时间；时间相同时按 ID 倒序稳定排列。排序时间保存在 SQLite，重启保留。

已提交的项目、文件夹、chat、成功历史和活动时间由 server 维护，是共享数据的唯一来源。创建、排序、历史、busy 和全局调试变化通过 SSE 通知所有页面重新读取，不整页刷新；初次加载、刷新和断线重连都会读取最新数据。SSE 通知和重连不改变本页选择、折叠与未提交草稿；整页刷新通过 URL 恢复选择，折叠与草稿重新初始化。busy 和调试开关只在 server 内存中，重启分别恢复空闲和启动参数值。

新数据库自动建立数据表，不生成默认项目或对话。首次识别旧的单对话数据表时会事务性重建，**旧历史和最近文件夹将被丢弃**。新项目、文件夹和 chat 此后重启保留，不会每次启动清空。未知 schema 不自动重置。没有重命名、删除或编辑文件夹功能。

## OpenRouter 调试日志

侧栏左下角的齿轮按钮打开“设置” modal，里面的全局日志开关修改后立即提交，无需保存；没有选中 chat 也能操作。读取或更新失败显示在设置框内，隐藏后错误仍可查看，成功重试或重新核对 server 后清除；列表和模型错误仍分别显示在列表和原 chat。隐藏中的设置继续同步 server 值。`pnpm start` 默认开启；关闭启动默认值可先 `pnpm build`，再运行 `node --env-file-if-exists=.env src/server.ts`。开关由 server 内存保存；所有页面共享，刷新/SSE 重连读取最新值；重启恢复启动参数值。

模型提问使用 `.env` 中的 `OPENROUTER_API_KEY` 和 `OPENROUTER_MODEL`。`.env` 已被 Git 忽略，密钥不发送到浏览器。现有模型 HTTP 调用代码保留：日志在 server terminal 输出编号、URL、method、body、响应 status/body 和耗时，不打印 headers；JSON 缩进，非 JSON 原文输出，凭据遮盖，prompt/回答可能出现在本地日志。日志不写入文件或发送到页面。

## 检查与测试

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm format` 使用 Biome 默认 `check --write`，没有配置文件。后端使用 `node:test`，HTTP 测试启动真实 server 和临时 SQLite。Playwright Test 用真实 headless Chromium 验证 modal、取消/Escape、焦点恢复、输入校验、URL 前进后退、独立历史/草稿、延迟回包归属和两个页面的创建/活动排序/busy/历史同步、同 chat 禁用与不同 chat 并行、断线重连、空页面和未知 chat 布局；使用隔离临时数据库与目录，假模型只注入 server 外部 OpenRouter 调用边界，无真实 API key/付费调用，也不会操作用户默认数据库。E2E 数据在结束时清理。

GitHub CI 使用 Node 24/pnpm 11，运行格式、类型、构建、后端测试及同一套 headless Chromium E2E。Linux 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器和系统依赖。浏览器测试失败会令 CI 失败，并上传 `playwright-failure` artifact（保留 7 天），包含 HTML 报告和失败 trace；在 Actions run 页面下载后，可用下面的命令查看。本地失败文件同样位于 `playwright-report/` 和 `test-results/`，两者已忽略。

```sh
pnpm exec playwright show-report playwright-report
pnpm exec playwright show-trace test-results/<失败用例目录>/trace.zip
```
