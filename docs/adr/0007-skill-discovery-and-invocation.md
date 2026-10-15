# Skill 的发现与调用

采用 [Agent Skills 格式与渐进加载](https://agentskills.io/specification)，能力分工遵循 [ADR 0005](0005-local-execution-and-model-decisions.md)。Skills 来自项目与宿主用户的 `.agents/skills`；同名来源保留，用文件路径区分，不合并或静默覆盖。使用成熟的 `yaml` 包解析 metadata，避免自写 YAML parser 或为此引入完整 Agent 框架。尚未实现。

本地发现 metadata，模型根据目录摘要选择适用 skill 并通过文件工具读取完整 `SKILL.md`；参考资料按需读取，脚本通过现有命令工具执行。文件和命令权限独立于 skill 调用，skill 内容不自动扩大权限。

每个新 Root Agent 与 Sub-agent 重新发现自己的可自动调用目录；具体任务指导通过显式 prompt 与背景传递，不自动复制父任务的上下文或本轮 skill 选择。

已知 skill 目录视为用户指定的可信只读资料源，例如 `~/.agents/skills` 和项目 `.agents/skills`。目录内符号链接直接跟随，其实际目标同样允许读取，不逐个审批或增加 skill 专用过滤策略。此读取范围由来源目录及链接关系派生，复用现有权限后端；不授予额外写权限，脚本中的操作仍受正常文件和网络权限约束。原有 Target Folder 写权限保持不变。

输入框提供 `/` 自动完成，让用户按名称、描述和来源选择 skill，同名来源可分别选择。保留文本输入框，选中的 skills 以可移除标记呈现，提交时带上确切来源；选择本身不发送任务。菜单采用常见的过滤、方向键移动、Enter 选择和 Esc 关闭行为，保留现有输入法与发送设置。界面细节按成熟设计尽力实现第一版，无需逐项确认。

本地识别 `SKILL.md` 的 `disable-model-invocation: true` 和 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false`；任一标记禁止隐式调用时，该 skill 仍可供用户选择，但名称、描述和详情均不进入模型的自动发现目录。允许隐式调用的 skills 只提供目录摘要，由模型按需读取。用户明确选中的 skill，无论是否允许隐式调用，均由本地在提交时读取完整 `SKILL.md` 并提供给模型；附带参考资料和脚本仍按需使用。
