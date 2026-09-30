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

每个 project 可创建多个具名 chat，空 chat 立即保存，不自动生成 chat。创建成功后仅当前页面选中它；其他页面通过 SSE 更新列表，不改变选择或折叠。项目默认展开，折叠状态仅当前页面有效。右侧显示所选 project/chat 和只读文件夹；没有选择时留空。

本阶段交付创建和空 chat，提问功能将在下一步接入；旧全局单对话入口已移除。选择尚未写入 URL，刷新暂时不保留选择。

新数据库自动建立数据表，不生成默认项目或对话。首次识别旧的单对话数据表时会事务性重建，**旧历史和最近文件夹将被丢弃**。新项目、文件夹和 chat 此后重启保留，不会每次启动清空。未知 schema 不自动重置。没有重命名、删除或编辑文件夹功能。

## OpenRouter 调试日志

全局日志开关在侧栏底部；没有选中 chat 也能操作。`pnpm start` 默认开启；关闭启动默认值可先 `pnpm build`，再运行 `node --env-file-if-exists=.env src/server.ts`。开关由 server 内存保存；所有页面共享，刷新/SSE 重连读取最新值；重启恢复启动参数值。

后续模型提问将使用 `.env` 中的 `OPENROUTER_API_KEY` 和 `OPENROUTER_MODEL`。`.env` 已被 Git 忽略，密钥不发送到浏览器。现有模型 HTTP 调用代码保留：日志在 server terminal 输出编号、URL、method、body、响应 status/body 和耗时，不打印 headers；JSON 缩进，非 JSON 原文输出，凭据遮盖，prompt/回答可能出现在本地日志。日志不写入文件或发送到页面。

## 检查与测试

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm format` 使用 Biome 默认 `check --write`，没有配置文件。后端使用 `node:test`，HTTP 测试启动真实 server 和临时 SQLite。Playwright Test 用真实 headless Chromium 验证 modal、取消/Escape、焦点恢复、输入校验和两个页面的创建同步；使用隔离临时数据库与目录，假模型只注入 server 外部 OpenRouter 调用边界，无真实 API key/付费调用，也不会操作用户默认数据库。E2E 数据在结束时清理。

GitHub CI 现有步骤运行格式、类型、构建和后端测试；Chromium E2E 安装及运行会在后续 CI 票接入。Linux 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器和系统依赖。失败时本地报告在 `playwright-report/`，trace 在 `test-results/`，两者已忽略。
