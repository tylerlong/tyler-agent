# Tyler Agent

这是一个 TypeScript/Node.js 网页项目。当前功能是提交一次 prompt，经 Node.js 直接调用 OpenRouter Responses API，并在网页显示文本回答。

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

打开 `http://127.0.0.1:3000`。也可通过 `PORT` 环境变量修改端口。填写运行服务的电脑上的目标文件夹路径和 prompt（例如 `1 + 1 等于几？`），然后提交。

服务会确认目标文件夹存在且是文件夹。目前只把 prompt 发送给模型；不会发送文件夹路径、读取或修改文件，也没有工具调用、多轮对话或历史记录。每次提交都是独立的非流式请求。

## OpenRouter 调试日志

网页上的“OpenRouter 调试日志”单选项可开启或关闭服务端日志。开关默认关闭，由服务进程内存保存；所有连接到同一服务的浏览器窗口共用它。刷新页面会重新读取服务状态，重启服务则恢复关闭。其他已打开的窗口不会实时更新，刷新后即可看到当前状态。

开启后，在运行 `pnpm start` 的 terminal 查看每次 OpenRouter 调用的编号、请求 URL、method、body，以及响应 status、body 和耗时；headers 不输出。JSON body 会缩进显示，无法解析为 JSON 的 body 按原文显示。网络失败也会记录错误；调用开始时的开关状态决定该次是否记录。认证信息会被遮盖，但 prompt 和模型回答可能原样出现在本地 terminal 中。日志不发送到网页，也不会由应用写入文件。这些记录供排障和自行复现使用；再次调用不保证得到相同回答。

## 检查

```sh
pnpm typecheck
pnpm test
```

自动测试模拟 OpenRouter 响应，不需要真实密钥或付费请求。后续再添加受目标文件夹约束的本地文件工具，例如 `listFiles`、`readFile` 和 `patchFile`。
