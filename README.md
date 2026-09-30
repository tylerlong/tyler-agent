# Tyler Agent

这是一个 TypeScript/Node.js 网页项目。React 页面由 Vite 和 Tailwind 构建，Node.js 提供页面并直接调用 OpenRouter Responses API，在网页显示共享对话。

## 运行

需要 Node.js 24 和 pnpm 11。先在项目根目录创建 `.env`：

```dotenv
OPENROUTER_API_KEY=你的密钥
OPENROUTER_MODEL=z-ai/glm-5.3-flash
```

`.env` 已被 Git 忽略，密钥只由 Node.js 读取，不发送到浏览器。

```sh
pnpm install
pnpm start
```

`pnpm start` 会先构建前端再启动服务，无需手动构建。打开 `http://127.0.0.1:3000`。也可通过 `PORT` 环境变量修改端口。填写运行服务的电脑上的目标文件夹路径和 prompt（例如 `1 + 1 等于几？`），然后提交。修改前端代码后重新运行 `pnpm start` 即可看到新页面。

默认数据库文件位于项目根目录的 `data/tyler-agent.sqlite`。也可在启动时指定位置：

```sh
pnpm start --db /path/to/chat.sqlite
```

相对路径以启动命令的工作目录为基准。默认数据目录会自动创建；自定义路径的父目录须已存在且可写。数据库无法打开或初始化时，服务会报错退出，不会改用临时数据。数据库文件已被 Git 忽略。

服务会确认目标文件夹存在且是文件夹，但不会发送文件夹路径、读取或修改文件。最近一次通过验证的目标文件夹会保存在数据库中，刷新页面或重启服务后恢复；即使随后 OpenRouter 调用失败也会保留。每次成功的提问与文本回答会作为完整轮次写入数据库，下次提问会把完整历史一同发送给模型。所有浏览器窗口共用这段历史。服务通过 SSE 通知已打开的页面重新读取对话、最近目标文件夹、调试设置和请求进行中状态；断线重连后也会重新读取。更新不会刷新整个页面，尚未提交的输入仍留在当前页面。请求进行中时所有页面禁用提交；服务端也会拒绝并发提交（HTTP 409），请求结束后恢复。

请求失败或数据库写入失败不会加入历史。调试开关仍保存在服务进程内存中；未提交的输入和单次错误仅属于当前页面。当前没有清空按钮、历史裁剪或工具调用；上下文过长时会上报 OpenRouter 的请求失败。调用仍是非流式 HTTP 请求。

## OpenRouter 调试日志

网页上的“OpenRouter 调试日志”单选项可开启或关闭服务端日志。`pnpm start` 启动时默认开启；如果希望启动时关闭，先运行 `pnpm build`，再运行 `node --env-file-if-exists=.env src/server.ts`。设置由服务进程内存保存，所有连接到同一服务的浏览器窗口共用它。其他已打开的窗口会自动重新读取当前设置；刷新和断线重连也会重新读取。重启服务后恢复为启动参数指定的状态。

开启后，在运行 `pnpm start` 的 terminal 查看每次 OpenRouter 调用的编号、请求 URL、method、body，以及响应 status、body 和耗时；headers 不输出。JSON body 会缩进显示，无法解析为 JSON 的 body 按原文显示。网络失败也会记录错误；调用开始时的开关状态决定该次是否记录。认证信息会被遮盖，但 prompt 和模型回答可能原样出现在本地 terminal 中。日志不发送到网页，也不会由应用写入文件。这些记录供排障和自行复现使用；再次调用不保证得到相同回答。

## 检查

```sh
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

使用 `pnpm format` 运行 Biome 默认的 `check --write`，格式化、检查并修复受支持的文件；项目没有 Biome 配置文件。

自动测试模拟 OpenRouter 响应，不需要真实密钥或付费请求。后续再添加受目标文件夹约束的本地文件工具，例如 `listFiles`、`readFile` 和 `patchFile`。
