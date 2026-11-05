# Yukino Desktop

基于 `@yukino.js/yukino` 的 Electron 工作区。

```sh
pnpm install --registry https://registry.npmmirror.com
pnpm dev
```

首次启动在设置中添加服务商。`~/.yukino/config.yaml` 支持 MCP、Hooks、记忆和沙箱配置。

- 会话：跨项目历史、恢复、流式输出、推理过程、授权、提问、任务中追加要求、停止。
- 工作台：目标与 Token 预算、任务依赖、Agent 与团队进度、后台输出与停止、工作流阶段与恢复、工具搜索、Skills、MCP、记忆、沙箱、检查点恢复。
- 交互：命令中心、可编辑的任务建议、附件、回复复制、明暗主题、窄窗口导航。
- 编辑器：Monaco、文件树、Git 变更、实时刷新、差异对比、草稿、冲突检查、原子保存。
- 快捷键：`⌘/Ctrl K` 命令中心、`⌘/Ctrl B` 会话侧栏、`⌘/Ctrl J` 编辑器、`⌘/Ctrl N` 新会话、`⌘/Ctrl ,` 设置、`⌘/Ctrl S` 保存。

编辑器关闭时保留草稿；切换项目、关闭文件或退出时处理未保存内容。文本文件上限 2 MB，不编辑二进制文件或项目外文件。变更对比以本次编辑前内容或 Git HEAD 为基线。

复用 Base UI、cmdk、TanStack Query / Virtual、Monaco、Streamdown、React Resizable Panels、Lucide 与 Sonner。Agent 执行、授权、团队、工作流和会话持久化使用 Yukino 原生能力。

```sh
pnpm happy:fix
pnpm test:ui
pnpm build
node tests/electron-smoke.mjs
```

界面测试使用模拟 Agent；Electron 测试使用临时项目和独立应用数据目录，不发送模型请求。macOS 默认使用本机 Chrome，其他平台可运行 `pnpm exec playwright install chromium` 或通过 `CHROME_PATH` 指定浏览器。
