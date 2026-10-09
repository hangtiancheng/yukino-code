# AGENTS.md

Yukino is a terminal-based AI coding agent.

- Fix all ESLint errors. Ignore all ESLint warnings.
- Use `pnpm lint:fix` to automatically correct lint errors. This command is idempotent and non-destructive.
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- If fixing a bug or updating/implementing a valuable feature causes old tests to fail, follow ZERO backward compatibility: implement the correct behavior, update or remove obsolete tests, and update all outdated comments. NEVER preserve defective behavior or add compatibility logic merely to satisfy old tests.
- Use `pnpm happy:fix` as the final validation pipeline. This command is idempotent and non-destructive.
- Only add comments where the code is not self-explanatory. Usage of these comments should be rare.

## 参考 PI Coding Agent

- TUI、响应式布局、滚动行为、输入框和鼠标: 使用 React + Ink
- 提示词: @/prompt 和「各种」场景的提示词
- 所有基础工具实现、description 和 input_schema (properties)
- 消息的 steering 和 follow-up 机制
- 流式传输、中断重连
- 自动/手动上下文压缩
- skills 注册与发现, 参数传递
- 模型选择、thinking 思考等级、JSONL
- ! 和 !! 执行 bash 命令
- 统一的配置目录 ~/.yukino
- Custom Command

## 参考 Claude Code

- 预定义的 subagent: general-purpose / plan / explore
- bash/powershell 的 Ctrl+B 后台异步执行
- fork 的 subagent: 是否继承父 agent 的上下文
- run_in_background 的 subagent: 前台同步运行的 subagent、后台异步运行的 subagent
- plan 模式, `/plan` slash command
- goal 模式, `/goal` slash command
- agent team:
  - leader 和 teammates
  - 共享任务列表
  - mailbox 文件邮箱, SendMessage 通信
  - teammate 计划提交后由运行时自动批准, 工具权限仍独立审批
  - coordinator 模式限制 leader 的工具集
  - 仅 in-process teammates
- OS 沙箱: Linux Bubblewrap、MacOS Seatbelt
- checkpoint 检查点, 文件历史快照和 `/rewind` slash command
- lsp (language server protocol) 集成
- ComputerUse 工具
- 长期记忆: 记忆提取、召回和后台记忆整理
- WebSearch 工具 (基于 Bing/cheerio)、WebFetch 工具
- 可观测性: OpenTelemetry、LangFuse、Sentry
- ACP 协议集成: 结合 yukino 自身 feature
- MCP 连接, 延迟加载, `/mcp` reload
- hooks 实现, 区别是 yukino 的 hook 的 condition 是 JS 表达式

## 参考 Gemini CLI

- A2A 协议集成

## 参考 open-code-review

- `/code-review` slash command

## yukino 自研

- remote 浏览器模式
- hook 的 condition 是 JS 表达式
- 终端不开启全屏模式、不捕获鼠标: 是设计取舍, 不是缺陷
