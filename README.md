# Typos Agent

这是一个 TypeScript/Node.js 网页原型，用来逐步构建修正目标文件夹中 typos 的 agent。

## 运行

需要 Node.js 24 和 pnpm 11。

```sh
pnpm install
pnpm start
```

在浏览器打开 `http://127.0.0.1:3000`，填写运行服务的电脑上的目标文件夹路径和 prompt，然后提交。也可通过 `PORT` 环境变量修改端口。

当前服务只验证目标文件夹存在且是文件夹，随后返回固定的 `example.txt` 修改前后示例。网页标注“演示结果，未修改文件”。服务不会读取目标文件夹中的文件内容、修改文件或调用 OpenRouter。

## 检查

```sh
pnpm typecheck
pnpm test
```

后续将由 Node.js 直接通过 HTTP 调用 OpenRouter API，并在本地提供 `listFiles`、`readFile`、`patchFile` 等工具，让模型根据 prompt 修正真实文件。
