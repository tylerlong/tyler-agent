# Skill 的发现与调用

采用 [Agent Skills 格式与渐进加载](https://agentskills.io/specification)，能力分工遵循 [ADR 0005](0005-local-execution-and-model-decisions.md)。Skills 来自项目与宿主用户的 `.agents/skills`；同名来源保留，用文件路径区分，不合并或静默覆盖。使用成熟的 `yaml` 包解析 metadata，避免自写 YAML parser 或为此引入完整 Agent 框架。现已接入，每个 Agent 的实际模型请求保存当时目录、显式正文和诊断。

本地发现 metadata，模型根据目录摘要选择适用 skill 并通过文件工具读取完整 `SKILL.md`；参考资料按需读取，脚本通过现有命令工具执行。文件和命令使用 Full Access 与全局 Jev 审核，skill 内容不改变审核开关。

第一版按本机普通文本文件使用 Skill。特殊文件阻塞读取的取消边界暂缓处理；目前没有常规 Skill 读取明显缓慢的证据，待实际使用出现加载或取消问题再补齐，不为人工构造的特殊文件场景增加防御机制。

每个新 Root Agent 与 Sub-agent 重新发现自己的可自动调用目录；具体任务指导通过显式 prompt 与背景传递，不自动复制父任务的上下文或本轮 skill 选择。

Weft 随固定 Playwright 1.63.0 安装提供上游 `playwright-cli` skill，通过同一目录发现和选择规则使用其原文和参考资料；不复制或改写成另一份浏览器操作列表。

已知 skill 目录及目录内符号链接直接跟随实际目标读取，不生成额外文件授权。来源发现与内容预算仍按本地规则执行；模型按需读取和脚本执行均遵循普通工具的全局 Jev 审核。

输入框提供 `/` 自动完成，让用户按名称、描述和来源选择 skill，同名来源可分别选择。保留文本输入框，选中的 skills 以可移除标记呈现，提交时带上确切来源；选择本身不发送任务。菜单采用常见的过滤、方向键移动、Enter 选择和 Esc 关闭行为，保留现有输入法与发送设置。界面细节按成熟设计尽力实现第一版，无需逐项确认。

本地识别 `SKILL.md` 的 `disable-model-invocation: true` 和 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false`；任一标记禁止隐式调用时，该 skill 仍可供用户选择，但名称、描述和详情均不进入模型的自动发现目录。允许隐式调用的 skills 只提供目录摘要，由模型按需读取。用户明确选中的 skill，无论是否允许隐式调用，均由本地在提交时读取完整 `SKILL.md` 并提供给模型；附带参考资料和脚本仍按需使用。

项目来源为各 Target 的最近 Git 根到 Target 的祖先链内 `.agents/skills`；无 Git 时仅检查 Target。目录递归发现支持命名空间目录，进入一个 Skill 后只继续检查资源中的符号链接，不将参考目录当作独立 Skill。每个 Agent 固定其启动时目录，后续任务重新发现；输入框重新打开 `/` 会刷新。无文件监听或逐 Skill function tool。YAML 或文件错误保留为诊断；损坏 metadata 的来源仍可明确选择并尝试完整读取。
