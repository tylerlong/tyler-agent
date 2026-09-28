# Typos Agent

这是一个用 TypeScript 实现的简单 agent，用来练习模型如何通过本地工具完成任务。

启动程序时，指定一个目标文件夹并输入 prompt，例如：“找出这个文件夹里的 typos 并修正它们。”程序直接通过 HTTP 调用 OpenRouter API，不使用 OpenRouter SDK 或其他 agent 框架。

程序在本地定义并执行文件工具，例如 `listFiles`、`readFile` 和 `patchFile`。模型根据 prompt 决定调用哪些工具；程序把工具调用结果发回模型，继续这个循环，直到模型完成任务并给出总结。修改只作用于指定文件夹，完成后可以查看文件差异。

第一版的目标是跑通这个最小闭环，清楚地看到每次 API 请求、模型返回的工具调用，以及本地执行结果。
