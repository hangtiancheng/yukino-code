# Yukino (apps/yukino) 缺陷探索报告（claude）

- 探索日期：2026-10-18
- 探索范围：`apps/yukino` 的 `src/`（313 个源文件，约 6.6 万行）与 `tests/`（156 个测试文件），重点覆盖：权限系统、agent 主循环、工具层（Glob/Grep/Bash/文件/MCP/ComputerUse/LSP）、会话持久化、compact/tool-result 预算、LLM 客户端、feedback/telemetry 脱敏、images、remote/browser、UI 关键路径（app.tsx / input / follow-up 队列 / 终端控制）、commands/loader、file-scan 补全、sandbox、review/goal/todo/plan-file/conversation/history/file-history。
- 方法论：**所有结论均以代码事实 / 运行时实测为准独立核验**。前三份报告（codex / pi / yukino）的结论仅作为去重与交叉印证参考，凡引用者均已由本人复核；本轮新发现均给出可复现的实测脚本或精确代码定位。临时验证脚本运行后已删除，仓库未残留改动。

## 基线健康度（本次实测）

| 检查             | 结果                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| `pnpm typecheck` | 通过（`tsc --noEmit` 主工程 + remote/browser 子工程，exit 0）                      |
| `pnpm lint`      | 通过（--quiet，无 error）                                                          |
| `pnpm test`      | **不稳定**：隔离运行基本全绿，但全量并行时 `tests/lsp.test.ts` 概率性失败（见 C2） |

> 关于 `pnpm test`：前三份报告均记录「2410 passed / 1 skipped，全绿」。本轮实测发现该结论**只在隔离/低并发下成立**——在完整并行套件下 `tests/lsp.test.ts` 会概率性失败，多轮实测失败数随系统负载在 1~14 之间波动（详见 C2 的实测记录）。这是本轮相对既有报告的一项**更正**。

---

## 一、真实缺陷（本轮新发现，三份既有报告均未覆盖）

### C1【高危｜安全】allow-always 对「无内容字段」的工具持久化 `ToolName(*)` 通配符 allow 规则，一次批准即永久放行该工具的全部调用

- 位置：`src/permissions/index.ts`
  - `allowAlways()` line 748-751（else 分支）：
    ```ts
    const words = content.trim().split(/\s+/).slice(0, 2);
    pattern = words.join(" ") + "*";
    ```
  - `extractContent()` line 178-181：`const field = CONTENT_FIELDS[toolName]; if (!field) return "";`
  - `CONTENT_FIELDS` line 137-150：**只登记了 12 个工具**（Bash/PowerShell/ComputerUse/ReadFile/LSP/WebFetch/TaskOutput/WriteFile/EditFile/Glob/Grep/InstallSkill）。
- 机制：对**不在** `CONTENT_FIELDS` 中的工具（且非 ReadFile/WriteFile/EditFile 文件分支），`extractContent` 返回空串 `""`。空串经 `"".trim().split(/\s+/)` 得到 `[""]`，`[""].join(" ") + "*"` = `"*"`。于是 `allowAlways` 持久化一条 **`ToolName(*)` → allow** 的项目级规则，写入 `~/.yukino/projects/<key>/permissions.yaml`，跨会话长期有效。
- 受影响工具（均为 command/write 类、需 HITL 审批、且无内容字段），已逐一核对 `name` 与 `category`：
  - `Agent`（`src/subagent/agent-tool.ts:64-66`，category=`command`）——派发子代理，可执行任意被授权工具；
  - `ExitWorktree`（`src/tools/exit-worktree.ts:19-22`，category=`write`）——内部执行 `git worktree remove` + `git branch -d`，**破坏性**；
  - `EnterWorktree`（`src/tools/enter-worktree.ts:20-24`，category=`write`）；
  - `TaskStop`（`src/teams/task-stop.ts:15-18`，category=`command`）；
  - `TeamCreate` / `SendMessage` / `TeamDelete`（`src/teams/tools.ts:26/87/324`，category=`command`）——向其他代理发消息；
  - **动态 MCP 工具名**（`src/mcp/tool-wrapper.ts:51/63`，category=`command`）——工具名形如 `mcp_<len>_<server>__<tool>`，用户/模型对某个 MCP 工具点「始终允许」后，会为**该具体 MCP 工具名**持久化 `<mcpToolName>(*)`，放行其任意参数调用。
- 实测验证（运行时，构造 `PermissionChecker` + 项目规则引擎）：
  - 对一次 `Agent(...)` 调用选择「始终允许」→ 持久化规则为 **`Agent(*)` allow**；
  - 随后**任意** `Agent(...)` 调用（不同 prompt、不同 subagent 类型）→ 决策 **`allow`**，不再弹审批。
  - 对照：`Agent` 不在 `CONTENT_FIELDS`，`extractContent("Agent", {...})` 恒返回 `""`，与机制推断一致。
- 影响：这是比既有报告 D2/P2（命令族 `git push*` 过宽）**更宽**的一类越权：它不是「前缀+*」而是「纯 `*`」，等于对整类工具无条件放行。用户以为只是批准「这一次派发子代理 / 这一次退出 worktree / 这一次给队友发消息」，实际持久化了对该工具**所有未来调用**的免审批授权。`ExitWorktree(*)` 尤其危险：会静默放行后续任意 `git worktree remove`/`branch -d`；`Agent(*)`/`SendMessage(*)` 会静默放行后续任意子代理派发与跨代理消息（提示注入放大器）。
- 定性：**真实缺陷**。与代码注释意图矛盾——注释写「Command: first 1-2 words + `*` so it allows that command family」，但这些工具根本没有「命令内容」可取词，落到 else 分支纯属未预料的空串退化，`*` 通配符也非注释所述「命令族」语义。README 亦未声明「始终允许会放行该工具全部调用」。
- 修复建议：`allowAlways` 在 `content` 为空时**不应**生成 `*`。可选方案：(a) 对无内容字段的工具拒绝持久化 allow-always（回退为单次 allow，不写规则）；(b) 为这些工具在 `CONTENT_FIELDS` 或专门映射里定义有意义的匹配键（如 `Agent`→subagent_type、`SendMessage`→to、MCP→已有的 `server__tool`），据其生成收窄规则；(c) 至少把空 content 的持久化模式从 `*` 改为「不写规则并提示用户该工具不支持 always-allow」。

### C2【中危｜测试/CI】`tests/lsp.test.ts` 在完整并行套件下概率性失败：`timeout_ms` 同时约束「LSP 子进程 initialize 握手」与「诊断请求等待」，低超时用例在 CPU 争用下超时（更正既有报告「全绿」结论）

- 位置：
  - `src/lsp/client.ts:131`：`request(method, params?, signal?, timeoutMs = this.config.timeout_ms ?? 15_000)`；
  - `src/lsp/client.ts:303-304`：`initialize()` 调用 `this.request("initialize", {...})` **未传第 4 个 timeout 参数** → 继承 `config.timeout_ms`；
  - `tests/lsp.test.ts:28/36`：`function tool(options, timeout = 1000)` 把 `timeout_ms: timeout` 注入 LSP 配置；
  - `tests/lsp.test.ts:200`：`tool({ silent: true }, 100)` —— 把 `timeout_ms` 设为 **100ms**。
- 机制：`timeout_ms` 是同一个配置项，既作为 LSP 服务器**子进程 initialize 握手**的超时（client.ts:304 不传 override），又作为每个**诊断请求**的等待超时。当用例把 `timeout_ms` 设为 100ms 时，spawn 一个真实语言服务器子进程并完成 initialize 往返，在**全量并行套件**的 CPU 争用下经常 >100ms → 握手或首个请求超时 → 该文件多个用例连锁失败。
- 实测验证（多轮）：
  - **隔离运行** `tests/lsp.test.ts`：`PASS=6 / FAIL=0`（6 次），稳定通过；
  - **完整并行套件**：`iter1: 3 failed / iter2: 8 / iter3: 10 / iter4: 11 / iter5: 14`，**5 轮全部失败**，失败用例全部集中在 `tests/lsp.test.ts`（如 `ignores stale diagnostics…`、`cancels a hung request…`、`timeouts are bounded…`、`fails malformed framing safely…`）；
  - 失败根因非逻辑错误，而是 100ms 预算在高负载下不足以完成子进程握手——属**测试对超时预算的误用**（把「请求超时」和「握手超时」混为一谈），而非被测代码缺陷。
- 影响：`pnpm test`（CI 全量并行）**不可靠**，会出现与代码改动无关的随机红。前三份报告均记录「全绿」，是因为它们（很可能）在隔离或低负载环境跑，或未复现该竞态——本轮予以更正。
- 定性：**真实缺陷（测试侧）**。被测 `client.ts` 的超时设计本身合理（生产默认 15s），但测试用 100ms 复用了同一参数去约束子进程握手，是脆弱的测试。
- 修复建议：为 `initialize()` 单独传入一个与 `timeout_ms` 解耦的、宽松的握手超时（如固定 15s 或独立 `init_timeout_ms` 配置），使 `timeout_ms` 只约束 initialize 之后的请求；或测试改用 `timeout_ms=100` 时同步给 initialize 提供独立预算 / 使用 mock 传输而非真实子进程。

### C3【中低危｜安全/隐私】@补全用的 `scanCwdFiles` 跟随符号链接，可枚举工作区外任意目录（与 Grep/Glob 的「不跟随符号链接」防护不一致）

- 位置：`src/utils/file-scan.ts:35-46`：
  ```ts
  let isDir = false;
  try { isDir = statSync(full).isDirectory(); } catch { ... continue; }
  if (isDir) { walk(full, relPath); } else { out.push(relPath); }
  ```
  调用方：`src/ui/input.tsx:393`（终端 @-mention 补全）、`src/remote/server.ts:3151`（远程浏览器补全端点）。
- 机制：用 `statSync`（**跟随**符号链接）而非 `lstatSync` 判断是否目录，因此对指向目录的符号链接会 `walk` 进入。对照 `src/tools/grep.ts:280-288`（明确 `lstat` → 若是 symlink 则「follow file symlinks, but never descend into symlinked directories」）与 `src/tools/glob.ts:87-88` 注释（`follow` stays false, symlinked directories are never descended, cycle-safe），三者防护策略**不一致**——file-scan 是唯一会下降进入符号链接目录的。
- 实测验证（standalone 复现 `scanCwdFiles` 逻辑，fixture：`repo/etc_link -> /etc`、`repo/uplink -> ..`）：
  ```
  total: 2000  visited: 2301
  count starting with "etc_link/": 250        ← 250 个 /etc 下的工作区外文件被枚举进补全候选
  sample: etc_link/afpovertcp.cfg, etc_link/aliases, etc_link/apache2/...
  ```
  - `etc_link -> /etc`：`/etc` 下的文件被当作工作区内候选返回（信息泄漏面：本地敏感路径/文件名进入 @-补全下拉与远程浏览器补全）；
  - `uplink -> ..`：指向父目录的自环符号链接会被反复下降，靠 `max=2000` 上限与 `out.length>=max` 早退**兜住不崩溃**（空目录自环实测 `count:0` 不崩），但仍会浪费遍历并可能把父目录内容纳入候选。
- 影响：
  1. **隐私/信息泄漏**：仓库内一个符号链接（可能是依赖安装、`.worktreeinclude`、或恶意 PR 引入）即可让 @-补全枚举工作区外文件名；远程服务器补全端点会把结果返回给浏览器前端。
  2. **性能**：符号链接指向大目录树时遍历被拖慢（虽有 2000 上限）。
- 定性：**真实缺陷**（与同库 Grep/Glob 自身确立的「不下降符号链接目录」防护矛盾；file-scan 注释只说「shallow workspace file scan」，未声明会跟随符号链接出工作区）。
- 修复建议：改用 `lstatSync(full)` 判断，遇到符号链接目录时**不下降**（与 grep.ts 一致）；或对 `full` 做 `realpath` 后校验仍在 `root` 之内再 walk。

### C4【中低危｜安全/隐私】feedback 脱敏 `redactText` 泄漏 HTTP `Basic` 凭据：键值脱敏只吃掉 `Basic` 这个词，base64 的 `user:pass` 原样保留

- 位置：`src/feedback/redact.ts`
  - `TEXT_PATTERNS` line 47-59：有 `Bearer\s+` 专门规则（line 55-58），但**没有** `Basic\s+` 规则；
  - 键值脱敏正则 line 82-95：`(["']?([\w.-]{1,128})["']?[ \t]*[:=][ \t]*)("(?:...)"|'(?:...)'|[^\s,;}\]]+)`——value 分支 `[^\s,;}\]]+` **遇空格即止**，只能吃到第一个非空白 token。
- 机制：`Authorization: Basic dXNlcjpwYXNz` 中，键值脱敏匹配 key=`Authorization`，value=`Basic`（第一个非空白 token，被 `[^\s...]+` 截断），于是替换成 `Authorization: <redacted>`，而后面的 base64 凭据 `dXNlcjpwYXNz`（= `user:pass`）**完整保留**。`Bearer` 因为有 `Bearer\s+[A-Za-z0-9._~+/-]{20,}` 专门规则而不受影响，`Basic` 没有对应规则。
- 实测验证（运行时调用 `redactText`）：
  ```
  "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0"
    => "Authorization: <redacted> dXNlcm5hbWU6cGFzc3dvcmQxMjM0"   ← base64(user:password) 泄漏
  "curl -H \"Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0\" https://example.com"
    => "curl -H \"Authorization: <redacted> dXNlcm5hbWU6cGFzc3dvcmQxMjM0\" ..."  ← 同样泄漏
  ```
  对照：`Authorization: Bearer abc...xyz` 正确脱敏为 `<redacted> abc...`（注：Bearer 的 token 部分其实也被键值规则先吃掉 `Bearer` 后由专门规则处理，最终 token 被 `[redacted]` 覆盖——但 Basic 无此兜底）。结构化 JSON 路径（`redactJsonValue`）因整键命中 `authorization`→`<redacted>` 而**安全**，泄漏仅发生在**自由文本**（transcript / 日志 / issue 正文）路径。
- 影响：用户会话记录/日志里若出现 `Authorization: Basic <base64>` 或 `curl -H "Authorization: Basic ..."`（极常见的调试写法），提交 feedback issue 时凭据不会被脱敏，随附件上传到 GitHub issue。feedback 模块的核心承诺就是「秘密不出机器」（`redact.ts` 顶部注释「values must never leave the machine」），此处与该承诺矛盾。
- 定性：**真实缺陷**。
- 修复建议：在 `TEXT_PATTERNS` 增加 `{ pattern: /\b(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, replacement: "$1<redacted>" }`（与 Bearer 规则对称）；并考虑对键值脱敏的 value 分支支持「多 token 凭据」（如 `key: word word` 形式）。

### C5【中低危｜安全/隐私】telemetry `scrubTelemetryPayload` 不脱敏 URL 内嵌凭据（userinfo），`https://user:pass@host` 原样上报

- 位置：`src/telemetry/privacy.ts:13-24`（`redact` 闭包）：只做三件事——(1) 替换命中 `API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DSN` 的**环境变量值**；(2) 替换 home 目录为 `~`；(3) `Bearer\s+` 脱敏（line 23）。**没有** URL userinfo 处理。
- 机制：与 feedback 的 `redactUrl`（`redact.ts:26-40` 用 `new URL()` 剥离 `url.username`/`url.password`）不同，telemetry 的 scrub **完全没有 URL 解析**，因此形如 `https://user:pass@host/path` 的字符串（数据库连接串、带凭据的 webhook、代理 URL）会原样进入 Sentry/OTLP 上报。
- 实测验证（运行时调用 `scrubTelemetryPayload`）：
  ```json
  {
    "request": { "url": "https://user:hunter2pass@api.example.com/v1/x" },   ← userinfo 未脱敏
    "dsn": "[redacted]",                                                     ← dsn 键命中，正确
    "plain": "https://user:hunter2pass@host/path",                           ← 未脱敏
    "note": "see https://bob:s3cr3tP4ss@db.internal:5432/mydb for creds"     ← 未脱敏
  }
  ```
- 影响：`sendDefaultPii:false`（providers.ts:308）已关闭 Sentry 默认 PII，但 scrub 是**最后一道自定义防线**，它漏掉了 URL 凭据这一常见载体。telemetry 默认可能上报到第三方（Sentry/Langfuse/OTLP collector），凭据外泄面比 feedback 更宽（feedback 需用户批准发 issue，telemetry 是自动上报）。
- 定性：**真实缺陷**（与同库 `redact.ts` 已实现的 `redactUrl` 能力不对称——能力已存在却未在 telemetry 侧复用）。
- 修复建议：在 `redact` 闭包内对匹配到的 URL 形态字符串复用 `redact.ts` 的 `redactUrl`（或等价的 userinfo 剥离逻辑）；至少增加一条 `/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi → scheme://<redacted>@` 的正则。

### C6【低危｜功能/上下文】tool-result 聚合预算 `applyBudget` 在 (2000, ~2250] 字符区间「越 spill 越大」，spill 反而增加历史占用且使 total 计算倒退

- 位置：`src/tool-result/index.ts`
  - `applyBudget` line 176-192：跳过条件是 `content.length <= TOOL_RESULT_PREVIEW_CHARS`（=2000，line 177）；
  - `buildPersistedOutputPreview` line 78-94：包装文本 = `<persisted-output>` 头 + `Output too large (N characters). Full content saved to:\n<spillPath>` + `Preview (first M characters):\n` + 前 2000 字符预览 + `\n...` + `</persisted-output>`；
  - line 191：`total -= content.length - replacement.length;`（当 replacement 比原文长时，此减法**增加** total）。
- 机制：包装文本自身有约 200~250 字符的固定开销（含 spillPath，实测 ~116 字符路径 → 固定开销 ~249 字符）。因此当原文长度在 `(2000, 2000+固定开销]` ≈ `(2000, 2250]` 时，`replacement.length > content.length`——spill **把结果变大了**。但跳过守卫用的是 `<= 2000`，没有覆盖这个「净膨胀」区间，于是这些结果仍被 spill，既浪费一次磁盘写，又让进入历史的内容比原文更长，且 `total` 被错误地「减少」了一个负数（即增大），可能让循环少 spill 该 spill 的大项。
- 实测验证（运行时，spillPath 长度 116）：
  ```
  content=2000 replacement=2249 delta=+249  ← SPILL ENLARGES (worse)
  content=2050 replacement=2253 delta=+203  ← SPILL ENLARGES (worse)
  content=2100 replacement=2253 delta=+153  ← SPILL ENLARGES (worse)
  content=2200 replacement=2253 delta=+53   ← SPILL ENLARGES (worse)
  content=2300 replacement=2253 delta=-47   ok
  content=2400 replacement=2253 delta=-147  ok
  ```
  盈亏平衡点 ≈ 2253（随 spillPath 长度浮动），而守卫阈值是 2000——`(2000, ~2253]` 是净膨胀盲区。
- 影响：边界场景（一批工具结果里恰有 2000~2250 字符的项，且聚合超 200000 触发 spill）下，历史体积不降反升，违背 applyBudget 的初衷（注释：「spilling the largest first minimizes …」）；`total` 计算出现负贡献，理论上可能让预算循环提前误判已达标。属正确性/效率问题，非安全。
- 定性：**真实缺陷**（低危，边界触发）。
- 修复建议：跳过守卫改为「spill 后不会更小」的真实判据——即 `content.length <= replacementLengthFor(content.length)`，或直接用 `content.length <= TOOL_RESULT_PREVIEW_CHARS + ESTIMATED_WRAPPER_OVERHEAD`（把 spillPath 长度计入）；并在 `total` 更新时用 `Math.max(0, content.length - replacement.length)` 防御负贡献。

### C7【中危｜功能/上下文隔离】`/clear`、`/resume`、`/rewind` 不清空 follow-up 队列：为旧会话排队的消息会自动发送到全新/已恢复/已回滚的会话

- 位置：
  - `src/ui/use-follow-up-queue.ts:9-96`：hook 公开 API 只有 `enqueue / takeLast / hasPending / messages / processing / paused`，**不存在 clear/reset**，`pending` ref 一旦入队只能被逐个消费；
  - `src/ui/app.tsx`：`followUps.*` 全文件仅 5 处引用（`grep` 证实：2333 `hasPending`、2517 `enqueue`、2832 `messages`、2875 `enqueue`、2891 `takeLast`），**没有任何一处**在 `case "clear"` / `case "resume"` / `handleRewindAction` 路径上清空队列。
- 机制：流式回合进行中，用户输入的消息经 `handleSubmit` 走 `followUps.enqueue`（app.tsx:2875）排队；回合结束队列按 FIFO 派发。若用户在排队后又触发 `/clear`（重置 sessionId、conversation 等大量派生态，但不碰 followUps）或 `/resume <id>` 或完成 `/rewind`，则队列中**为旧上下文写的消息**会被自动提交到新/恢复/回滚后的会话，触发 `runUserTurn` 消耗 token 并可能产生写操作。
  - 典型触发：流式中依次输入 `/rewind` 与「顺便修一下那个 bug」→ 两条都排队 → 回合结束派发 `/rewind` → 回滚对话框打开（重新阻塞队列）→ 用户完成回滚 → 对话框关闭解除阻塞 → 「修一下那个 bug」被自动提交到**已回滚**的会话状态。
- 证据：
  ```ts
  // use-follow-up-queue.ts —— 全部返回 API，无 clear
  return {
    messages,
    enqueue,
    takeLast,
    processing,
    paused,
    hasPending: () => pending.current.length > 0,
  };
  ```
  附带子项：`steeringHistoryRecordedRef`（app.tsx:586）同样不在这三处清理——`/clear` 后残留的陈旧 marker 会让下次提交**相同文本**时被 `processSubmission` 误判为「已记录」而跳过 prompt 历史追加（同一根因的次生问题，仅影响历史）。
- 验证方式：`tests/follow-up-queue.test.ts` 只测 FIFO/阻塞/失败重排/卸载保护，无「上下文切换清队」用例；hook 无 clear API 即机制性证据。运行时复现：流式中依次提交 `/rewind` 与任意文本，完成回滚后观察文本被自动发送。
- 定性：**真实缺陷**。
- 修复建议：给 `useFollowUpQueue` 增加 `clear()`（清空 `pending.current`、`setMessages([])`、复位 `pausedRef`/`paused`），在 `case "clear"`、`case "resume"` 成功路径、`handleRewindAction` 的非 cancel 分支调用；同时清空 `steeringHistoryRecordedRef.current`。若产品上希望保留排队消息，至少应在上下文切换时把队列退回输入框或弹确认。

### C8【中低危｜功能/可用性】失败的队首提交无丢弃通道：一次持久性失败会「毒化」follow-up 队列，此后每次新提交都先重放失败项，新消息永远发不出去

- 位置：`src/ui/use-follow-up-queue.ts:64-86`（失败重排队首 + 暂停）、`:30-38`（`enqueue` 无条件解除暂停）；`src/ui/app.tsx:2891`（`recallQueuedMessage` 只能 `takeLast` 移除**队尾**）。
- 机制：
  1. 队首消息派发失败（`send` reject）→ line 73 `pending.current = [next, ...pending.current]` 重排回队首 + line 75 `pausedRef.current = true` 暂停；
  2. 用户再提交任何新消息 → `enqueue`（line 36-37）**无条件** `pausedRef.current = false; setPaused(false)` → effect 重新派发 `pending[0]`——**仍是那条失败项** → 再次抛错 → 再次重排+暂停；
  3. 新消息永远排在毒项之后得不到执行；`recallQueuedMessage`（Up 键召回）只能 `takeLast` 移除队尾，队列长度 ≥2 时用户**没有任何手段移除队首**。
  - 持久失败源示例：内联 `/resume <id>` 指向不可读/损坏的会话文件（`session/index.ts` 的 `readFileSync` 抛错，即既有报告 M-5/P15 的同一 throw 源，但**经队列派发时** reject 被 `send` 的 catch 捕获转为重排，不崩溃）；`/memory clear` 的 fs 异常等。
- 证据：
  ```ts
  // 失败重排队首（注释声明"不丢用户输入"）——但没有任何对应的"丢弃"出口
  pending.current = [next, ...pending.current];
  pausedRef.current = true;
  // enqueue 无条件解除暂停 → 下一次提交必然先重放毒项
  pausedRef.current = false;
  setPaused(false);
  ```
- 验证方式：单测即可复现——`send` 恒 reject，先入队 A 再入队 B，断言 B 永不被 send、A 被反复 send（现有测试 `keeps pending messages paused after a dispatch error` 只断言暂停，未覆盖「新 enqueue 后重放毒项」的循环）。
- 定性：**真实缺陷**。
- 修复建议：为失败项提供出口——连续失败 N 次（或失败后下一次 enqueue 时）把毒项移出队列、以 system 消息展示全文让用户自行复制重试；或让 `recallQueuedMessage` 支持按索引召回/删除队首。

### C9【低危｜交互】Ctrl+C 忙碌分支不清除陈旧的「再按一次退出」提示与定时器，提示语义与实际行为相反

- 位置：`src/ui/use-terminal-controls.ts:34-56`；提示渲染于 `src/ui/app.tsx`（`ctrlCHint`）。
- 机制：空闲时按一次 Ctrl+C → `setCtrlCHint(true)` + 启动 2s 定时器（line 47-54）；2s 内前台工作开始（后台任务/队友通知触发 `runNotificationTurn`、goal 自动续跑等，无需用户输入即可让 `hasRunningWork` 变真），此时按 Ctrl+C 走忙碌分支：
  ```ts
  if (hasRunningWork) {
    onInterrupt();
    ctrlCCountRef.current = 0;
    return; // ← 不清 ctrlCHint、不清 ctrlCTimerRef
  }
  ```
  结果：屏幕仍显示「Press Ctrl+C again to exit.」，而下一次 Ctrl+C 实际执行的是**中断**而非退出——提示与行为相反，最长误导 2 秒（直到定时器自然到期）。
- 验证方式：读码即可确认——`setCtrlCHint(false)` 只出现在 line 53（定时器回调）与 line 60（非 ctrl+c 按键复位分支），均不在忙碌分支。
- 定性：**真实缺陷**（低危，纯交互误导）。
- 修复建议：忙碌分支同时 `setCtrlCHint(false)` 并 `clearTimeout(ctrlCTimerRef.current)`（抽一个共用的 `resetCtrlC()`）。

### C10【低危｜交互】历史召回的多行条目光标落在第一行行尾，与队列召回（末行行尾）不一致，继续输入会插进首行中间

- 位置：`src/ui/input.tsx`
  - 历史召回（Up）line 817-824、历史召回（Down）line 839-846：
    ```ts
    const entryLines = entry.split("\n");
    setLines(entryLines);
    setCursorLine(0); // ← 落在第 0 行
    setCursorCol(entryLines[0].length);
    ```
  - 队列消息召回 line 787-791（对照，正确）：
    ```ts
    setCursorLine(recalledLines.length - 1); // ← 落在末行
    setCursorCol(recalledLines[recalledLines.length - 1].length);
    ```
- 机制：prompt 历史支持多行条目（按 JSONL 存整条提交）。召回多行历史后光标停在**第 0 行行尾**，用户直接继续输入会把文本插进第一行中间；且与同文件队列召回（停在末行行尾）的行为不一致，违反直觉。
- 验证方式：`tests/input-navigation.test.ts` 覆盖了 `moveInputVertically` 但未覆盖历史召回光标位；手工复现：提交一条 3 行消息，清空输入框，按 Up。
- 定性：**真实缺陷**（低危，交互一致性）。
- 修复建议：历史召回统一为 `setCursorLine(entryLines.length - 1); setCursorCol(entryLines.at(-1)!.length)`（Up/Down 两处同改）。

### C11【卫生级｜文档/代码不符】app.tsx 注释声称「项目级 prompts 覆盖全局」，实现只读全局目录，合并语义完全不存在

- 位置：
  - `src/ui/app.tsx:1028-1029` 注释：
    ```ts
    // Load user-defined slash commands from ~/.yukino/prompts/*.md
    // (user home, then project — project wins on a name collision).
    ```
  - 实现 `src/commands/loader.ts:12-13`：`const base = yukinoPath("prompts")`（= `~/.yukino/prompts`），`loadUserCommands` 只 `walkDir(base, base)`；grep 全库无任何项目级 prompts 目录读取。README:55 也只承诺「global prompt templates from `~/.yukino/prompts/`」。
- 影响：注释描述了未实现（或已移除）的「project wins on a name collision」合并语义，会误导维护者在项目目录放模板并疑惑为何不生效。
- 定性：**真实缺陷**（卫生级，注释与实现不符）。
- 修复建议：删改注释与实现对齐；或补上项目级 `<cwd>/.yukino/prompts` 加载并实现覆盖语义。

### C12【卫生级｜确定性】用户命令加载器大小写折叠重名去重依赖 readdir 顺序，跨平台/跨机器不确定且无警告

- 位置：`src/commands/loader.ts:17-21`（`byName.set(cmd.name, cmd)` 后者覆盖前者）、`:52-58`（`commandName` 对每段 `toLowerCase()`）。
- 机制：`Foo.md` 与 `foo.md` 都归一为 `foo`，`byName.set` 后者覆盖前者——胜者由文件系统 `readdirSync` 返回顺序决定，跨平台/跨机器不确定，用户无从得知哪个生效（也无任何 `log.warn`）。目录命名空间同理（`Sub/x.md` vs `sub/x.md` → `sub:x`）。
- 定性：**真实缺陷**（卫生级，非确定性）。
- 修复建议：归一化名冲突时保留首个并 `log.warn`，或按文件名排序保证确定性。

> **C13–C24 说明**：以下条目源自分区审计代理的发现，但**均已由我本人逐条以代码事实独立复核**（读取相关源码、grep 调用方与生产路径、对照测试与同库其他实现）后才收录，遵守「其他 agent 结果仅供参考、以代码事实为准」的约束。其中 C13–C19 为确证的真实缺陷，C20–C24 为机制成立但触发依赖环境/属设计边界的疑似缺陷（已明确标注置信度）。特别地，**C13/C18 与我第一节的 C1/C6 由不同分区代理与我本人三方独立收敛到同一结论**（`Tool(*)` 通配符、applyBudget 净膨胀），交叉印证增强了可信度。

### C13【中危｜功能（当前潜伏）】OpenAI 协议路径把 document 块的 `file_data` 填成裸 base64，缺 `data:` URI 前缀；`documentForChat` 还静默丢弃 `url` 源

- 位置：`src/llm/openai.ts`
  - `documentForResponses` line 548-553（base64 源）、554-563（text 源）；
  - `documentForChat` line 581-586（base64 源）、587-598（text 源），且**无 `url` 源分支**（对比 `documentForResponses` line 544-547 有 `file_url`）。
- 机制：document 块的 `file_data` 直接填入裸 base64 字符串，而 OpenAI 官方 Responses / Chat Completions 的 `file_data` 要求 data URI 形式（`data:application/pdf;base64,<...>`）。同文件 `imageDataUrl`（line 515-528）对图片**正确**拼了 `` `data:${mediaType};base64,${data}` `` 前缀——同一文件内图片与文档处理不一致，最能说明这是疏漏而非设计；且 `normalizeDocumentBlock`（`tools/types.ts:80-130`）已保证 `media_type` 恒为 `application/pdf`/`text/plain`，前缀所需信息齐全却被忽略。
- **重要限定（潜伏性）**：我 grep 全 `src/` 确认**当前没有任何生产代码产出 `document` 类型的 contentBlock**——ReadFile 图片路径产 `image` 块（`read-file.ts:255`）、MCP 产 `image`/`text` 块（`mcp/client.ts:127-184`）、ComputerUse 产 `image` 块；`document` 仅在 `tools/types.ts` 的防御性归一化里被接受。因此该缺陷**当前不可触发（潜伏）**，一旦将来有工具（如 PDF 读取）开始产出 document 块即会激活。据实降级标注，不夸大为「现行高危」。
- 定性：**真实缺陷（当前潜伏）**。
- 修复建议：`documentForResponses`/`documentForChat` 统一改为 `` file_data: `data:${mediaType};base64,${data}` ``（text 源用 `data:text/plain;base64,...`）；`documentForChat` 补 `url` 分支或在丢弃时告警。

### C14【低危｜功能/可观测性】Chat Completions 路径把 `finish_reason:"content_filter"` 静默映射为 `end_turn`，与 Responses 路径（抛 LLMError）行为不对称

- 位置：`src/llm/openai.ts:1092-1099`（Chat 路径 else 分支吞掉 `content_filter`）对照 `:434-442`（Responses 路径对 `content_filter` `throw new LLMError`）。
- 机制：`openai-compat` 提供商返回 `finish_reason:"content_filter"` 时，Compat 路径把**被安全过滤器截断的部分输出**当作一次完整成功的 `end_turn` 提交——agent 认为回合正常结束，半截内容被持久化，用户得不到任何「输出被过滤」信号。而官方 Responses 路径对同一语义 `content_filter` 会抛错，且 `tests/llm-stream-boundaries.test.ts:381/388` 断言 `rejects.toThrow("content_filter")`——证明项目语义就是「抛错」。`finishReason` 的 JSDoc 明确列举了 `content_filter` 却在分支中未处理，属映射遗漏。
- 定性：**真实缺陷**（低危，仅 openai-compat 路径；被过滤时静默降级）。
- 修复建议：`:1092` 映射中显式 `if (finishReason === "content_filter") throw new LLMError(...)`，与 Responses 路径对齐。

### C15【低危｜资源泄漏】A2A executor 的 `sessions` Map 条目永不删除，随 contextId 单调无界增长

- 位置：`src/a2a/executor.ts:378`（`sessions.set`）、`:431-442`（`evictSession` 只把 `session.runtimePromise = null`，**不删 Map 条目**）。
- 机制：30 分钟空闲驱逐保留 `contextId→sessionId` 映射以便透明重建 transcript——**这部分是设计意图，不计缺陷**。缺陷在于：grep 证实全文件**无 `sessions.delete(...)`**（仅 `dispose()` 里 `sessions.clear()`），条目无上限/LRU/TTL。长驻 A2A 服务每见一个新 contextId 就永久增一条记录，进程生命周期内单调不减；叠加 pi P17（A2A 无鉴权、loopback-only），同机任意进程可脚本化制造无界条目（轻微 DoS 放大）。
- 定性：**真实缺陷**（低危，长驻进程内存缓慢增长）。
- 修复建议：给 Map 加软上限（超限按最久未活跃删除已驱逐条目）；或驱逐时若 sessionId 已持久化到磁盘则直接 `sessions.delete(contextId)`（映射可经 `rebuildFromSession` 再生）。

### C16【低危｜健壮性/进程清理】MCP stdio 子进程未注册同步退出清理，崩溃路径下与 `exit-cleanup.ts` 注释自身声明的意图不符（与 LSP 不对称）

- 位置：`src/mcp/client.ts:198-236`（stdio 分支 `new StdioClientTransport` + `client.connect`，**全程无 `registerExitCleanup`**，该文件未 import 它）；对照 `src/lsp/client.ts:44-46`（spawn 后立即 `registerExitCleanup(() => this.killTree())`）；`src/bootstrap/exit-cleanup.ts:4-5` 注释**点名**「MCP disconnectAll」需被崩溃路径的同步 sweep 兜底。
- 机制：优雅退出走 `await mcpManager.disconnectAll()`（异步）无问题；但崩溃路径（`recover.ts` 的 uncaughtException/EIO/EPIPE → `runExitCleanups()` 同步 + `process.exit()`）**永不 await disconnectAll**，而 `runExitCleanups` 只 sweep 经 `registerExitCleanup` 注册的回调——LSP/后台 Bash/PowerShell/ComputerUse 都注册了，**唯独 MCP stdio 没有**（grep `registerExitCleanup` 命中 7 文件，`src/mcp/` 零命中）。注释声明的意图与实现不一致。
- **缓解**：MCP stdio 子进程非 detached（SDK `spawn(..., {shell:false})`），多数 server 在 stdin EOF 时自退，实践中多数不长期残留；真正会残留的是忽略 stdin EOF 或自身 fork 子进程的劣质 server。
- 定性：**真实缺陷**（低危，仅崩溃路径 + 劣质 server 才残留孤儿）。
- 修复建议：stdio 分支拿到 transport 后注册 `registerExitCleanup(() => process.kill(transport.pid, "SIGKILL"))`（SDK 已暴露 `pid` getter），并在 `disconnect()` 中注销，语义对齐 LSP。

### C17【低危｜功能/热重载竞态】SkillCatalog.loadSkill 先读内容后取 mtime（read-then-stat），加载期并发写会缓存陈旧正文且固化到下次编辑

- 位置：`src/skills/catalog.ts:145`（`readFileSync` 取内容，T1）→ `:159`（`statSync` 取 mtime，T2>T1）→ `:164-168`（内容@T1 配 mtime@T2 入缓存）；配合 `get()`（:189-192）热重载判据 `currentMtime !== entry.loadedMtimeMs`。
- 机制：若 T1 与 T2 之间文件被并发写入一次，则缓存正文=旧内容、`loadedMtimeMs`=新 mtime；之后 `get()` 比较 `statSync().mtimeMs`（=T2）与 `loadedMtimeMs`（=T2）相等 → 跳过重读 → 持续返回旧正文，直到下次编辑使 mtime 再变。经典 TOCTOU 顺序缺陷——正确顺序应为 stat-before-read（读取期间若被改写，记录的 mtime 会早于新写入，下次 `get()` 必然检测到重载，fail-safe）。
- 定性：**真实缺陷**（低危，触发窗口极窄；无安全影响，纯本地正确性）。
- 修复建议：把 mtime 采集移到内容读取**之前**，或用同一次 `openSync`+`fstatSync` 保证 mtime 与内容取自同一版本。

### C18【低中危｜安全/功能】ExitWorktree 的 `path`/`branch`/`git_root`/`head_commit` 全由模型控制且无归属校验，acceptEdits 下项目内路径可零询问删除注册 worktree（与 C1 复合放大）

- 位置：`src/tools/exit-worktree.ts:55-58`（四参数直接 `strArg(args, ...)`）、`:74-78`（`hasWorktreeChanges(path, headCommit)` 的 headCommit 来自模型）、`src/worktree/index.ts:389-400`（`removeAgentWorktree` 执行 `git worktree remove -- <path>` cwd=`gitRoot` + `git branch -d -- <branch>`）、`src/permissions/index.ts:584/701-707`（Layer 4 沙箱只检查 `args.file_path||args.path`）。
- 机制：ExitWorktree category=`write`，但 `git_root`/`branch` 不经任何路径沙箱或归属校验；工具不校验 `path` 是否为 yukino 自建 worktree（`~/.yukino/worktrees/**`），任何 git 注册 worktree 均可命中。合法 yukino worktree 在 `~/.yukino/worktrees`（不在沙箱允许根）→ 各模式 ask；**但若 `path` 恰在项目目录内**（用户自己 `git worktree add ./wt`），acceptEdits 经 Layer 6 `modeDecide(acceptEdits, write)→allow` **零询问执行**；或 C1 的 `ExitWorktree(*)` 规则命中后 `explicitEffect=allow` 直接短路 Layer 4。模型可先用 Bash（safe command `git rev-parse`）取 head sha 填 `head_commit` 绕过变更检测。
- **缓解**（故不定中危）：`git worktree remove` 拒绝 dirty/locked worktree、`branch -d`（非 `-D`）拒绝未合并分支（`tests/worktree-safety.test.ts:234-249` 锁定），破坏面限于「干净的注册 worktree + 已合并分支」。
- 定性：**真实缺陷**（低中危，需 acceptEdits/allow 规则 + 项目内 worktree 的组合条件）。
- 修复建议：`execute` 内校验 `path` 位于 `yukinoPath("worktrees")` 之下（或维护本会话 worktree 白名单）；`git_root` 经 `path/.git` 指针反推而非采信参数；权限层把 `git_root` 也纳入 Layer 4。

### C19【低危｜功能/文档不符】Glob 先按遍历顺序截断 1000 条、后按 mtime 排序，违背工具描述承诺的「sorted newest modification first」

- 位置：`src/tools/glob.ts:85-127`（`SearchOutput(1000)` 在 `globIterate` 的 readdir 遍历序下累计满 1000 即 `break`，**之后**才对已收集子集做 mtime 降序排序）对照 `src/tools/descriptions.ts:43`（描述承诺 `sorted newest modification first`）。
- 机制：当匹配 >1000 个时，被丢弃的可能恰是最新文件——「返回最新的 1000 个」语义不成立，排序只是对**任意（遍历序）子集**排序。截断提示（`glob.ts:131`）只说「Use a more specific pattern」，未告知模型「结果可能不含最新文件」。glob v13 无内置 mtime 排序，遍历序即 readdir 序。`tests/search-tools.test.ts` 的 Glob 用例均 <1000 文件，无截断顺序语义锁定。
- 定性：**真实缺陷**（低危，仅在匹配 >1000 时显现，且是「结果误导」而非崩溃）。此条修正我在第四节初判的「可接受取舍」——经与描述承诺逐字对照，认定与文档不符，升级为缺陷。
- 修复建议：收集全部匹配（带总量上限如 10000 防内存失控）后排序再截前 1000；或在截断提示中如实声明「截断按遍历顺序，非按时间」。

### C20【疑似·低危｜健壮性/提示注入面】`detectEnvironment` 用无超时的 `execSync`（shell）探测 git，且分支名原文注入系统提示词

- 位置：`src/prompt/builder.ts:46/53`（`execSync("git rev-parse ...")` **未传 timeout**）、`src/prompt/sections.ts:95`（`` ` - Git branch: ${env.gitBranch}` `` 原样插值，无转义/长度截断）。
- 机制：
  1. **无超时阻塞启动**：NFS/网络盘仓库、损坏 `index.lock`、git 询问凭据等场景下，每次构建系统提示词时同步挂起主线程；try/catch（:59-61）只兜抛错、兜不住挂起。对照项目其他地方对子进程普遍谨慎（update 用 execFile 数组参数、bash 有看门狗）。
  2. **分支名原样进系统提示词**：git 分支名允许 `!$&'()*+;=@` 等字符（禁空格与换行），克隆恶意分支名仓库可向 system prompt 注入**单行**文本（`\n` 被 git 禁止，故无法多行越狱）。危害受限于单行 + 模型对 system 段环境信息的信任度。
- 定性：**疑似缺陷·待验证**（低危；挂起需特定环境，注入面为单行且影响有限）。
- 修复建议：改用 `execFileSync("git", [...], { timeout: 2000 })`（免 shell + 有超时），对 `gitBranch` 做长度截断 + 控制字符过滤，或复用 `src/worktree` 已有的纯文件系统 HEAD 读取（零子进程）。

### C21【疑似·低危｜一致性】agent 主循环 system-reminder 持久化策略不一致：`pre_send` 钩子通知与 skillDelta reminder 不写入 transcript

- 位置：`src/agent/index.ts:495-524`。turn_start 钩子 drain（:496-499）与 `notificationFn()`（:501-506）**逐条 `persistLastMessage()`**；但 skillDelta reminder（:509-516）与 `pre_send` 钩子后第二次 drain（:521-524，注释「Pre-send and turn-start prompts must reach the request they prepare」）**不 persist**。
- 机制：guidance/skillDelta 每轮重算、resume 后可再生，无实质损失；**唯独 pre_send 钩子通知**是从 hookEngine 队列 drain 的**一次性消费**内容——不持久化意味着 resume 后 transcript 永久缺失这段，重放上下文与原始运行分叉（钩子作者预期其输出进入会话历史）。注释未解释两次 drain 为何持久化策略不同。
- 定性：**疑似缺陷·待验证**（低危；可能是有意的「只服务当前请求」设计，也可能是漏写——无测试锁定，无注释固化意图）。
- 修复建议：统一策略——要么所有 drain 的钩子通知都 persist，要么注释声明 pre_send 通知为 ephemeral 属设计。

### C22【疑似·低危｜一致性】ACP `session/load` 重放忽略压缩边界：客户端 transcript 显示被压缩掉的历史，与 runtime 实际上下文不一致

- 位置：`src/acp/conversion.ts:226-241`（`historyNotifications` 只 `continue` 跳过 `COMPACT_BOUNDARY` 记录本身，边界**之前**被压缩掉的 user/assistant 消息照常重放，且不含 summary）对照 runtime 侧 `src/session/index.ts` `rebuildFromSession`（注释明示边界前消息「NOT replayed — that's the whole point of compaction surviving a resume」）。
- 机制：一次 `session/load`（replay）中，推给 ACP 客户端的 `session/update` 序列包含边界之前已被压缩掉的每条消息、且不含 summary；而模型实际携带的是「summary + keep 尾 + 边界后消息」。结果客户端 transcript ≠ 模型上下文，用户可能困惑于「模型记得/忘记」与屏幕显示不符；按重放消息计费/统计 token 也会偏差。`tests/acp-agent.test.ts` 无 compact/boundary 相关用例锁定，代码亦无注释声明「刻意全量重放」。
- 定性：**疑似缺陷·待验证**（低危；可能是有意的「UI 全量 transcript」设计，但与 runtime 语义存在可见偏差且无注释/测试固化意图）。
- 修复建议：若意图与模型上下文一致，`historyNotifications` 应复用 `rebuildFromSession` 输出（可把 summary 作为一条系统通知下发）；若意图是全量 UI 历史，加注释固化并在边界处下发可视分隔通知。

### C23【疑似·极低危｜错误处理一致性】`loadSingleFile` 未把 YAML 解析异常包装为 `ConfigError`，报错丢失配置文件路径上下文

- 位置：`src/config/index.ts:143-151`。`yaml.load(data)`（:145）抛出的 `YAMLException` 携带行/列 mark 但**不含文件路径**；而 schema 校验失败路径（:147-150）统一带 `Invalid configuration in ${path}` 前缀。
- 机制：`config.yaml` 语法错误（tab 缩进、未闭合引号）时，上层 `main.tsx` 一律 `console.error("Error: " + asErrorString(err))`，用户看到 `YAMLException: bad indentation at line 3...` 却不知是哪个文件。grep 确认全仓无 `instanceof ConfigError` 分支逻辑，故仅诊断信息不一致、不影响控制流。config/index.ts 其余全部错误抛出均为 `ConfigError`，唯 YAML 解析一处漏包。
- 定性：**疑似缺陷·待验证**（极低危，仅诊断体验）。
- 修复建议：`try { yaml.load(data) } catch (e) { throw new ConfigError(\`Invalid YAML in ${path}: ${msg}\`) }`。

### C24【疑似·极低危｜架构隐患】`forCwd()` 共享 `ruleEngine`：项目规则永远按原始 cwd 的 project key 解析与追加（当前调用方均为同项目 worktree，故现状无危害）

- 位置：`src/permissions/index.ts:550-563`（`forCwd` 里 `checker.ruleEngine = this.ruleEngine` 直接共享）、`:339-342`（RuleEngine 构造时固化 `projectPath(cwd)`）。
- 机制：`forCwd(worktreePath)` 后 PathSandbox 按新 cwd 重建，但规则文件仍从原始 cwd 的 project key 加载，worktree 内触发的 allow-always 也追加到**原项目**规则文件。对 worktree 隔离（同一项目）是合理连续性；但若将来 `forCwd` 被用于切换到**另一个项目目录**，规则会错位。经逐一核对当前全部调用点（`remote/server.ts`、`subagent/spawn.ts`、`agent-tool.ts`、`ui/app.tsx`、`print-mode.ts`）**均为同项目 worktree/skill-fork 场景**，故现状无实际危害。
- 定性：**疑似缺陷·待验证**（极低危，架构性隐患而非现行缺陷）。
- 修复建议：在 `forCwd` 注释显式声明「仅限同一项目的目录切换」；或按新 cwd 的 projectKey 重建 RuleEngine 并显式继承用户级规则。

### C25【中危｜正确性】`/review` 组失败被静默吞没：`outcome.error` 只写不读，失败组在进度与报告中与成功组无法区分

- 位置：`src/review/runner.ts:276-291`（写入点 :279）、`src/review/types.ts:121-131`（`CodeReviewResult` 无任何错误字段）、`src/review/report.ts:34-87`（只区分 `result.aborted`）。
- 机制：并发组审查中任一组抛异常（provider 429/5xx、网络中断、解析崩溃）时，catch 块仅把错误字符串写入局部 `outcome.error`；随后
  1. `finally`（:281-290）无条件打印 `Group N/M done (label)`——失败组与成功组文案完全相同；
  2. 本人 grep 全仓确认 `outcome.error` **零读取方**（`src/review/` 内其余 `.error` 命中为 comment-tool 的 LLM 输出校验 :292 与 stream 事件重抛 :594，均无关）；
  3. `CodeReviewResult` 类型无 `errors`/`failedGroups` 字段；`formatReviewReport` 唯一异常出口是 `aborted`；
  4. 两条消费路径（`ui/app.tsx:2928-2938`、`remote/server.ts:3711-3757`）都只渲染 `formatReviewReport(result)`。
     结果：4 组中 2 组 provider 全 500 时，用户看到「Group 1/4 done … 4/4 done」+ 正常统计摘要，**无任何迹象表明一半代码根本没被审查**。`filesReviewed`（:324-326 按 `o.completed` 过滤）虽少计，但报告中该数字仅为统计，用户无从知道差值意味着失败。
- 意图核查：README `/review` 章节无「失败静默」声明；tests（review.test.ts / review-runner-events.test.ts）无断言锁定组失败上报行为；:283 注释「Comments produced before a failure (or an interrupt) are kept」表明作者意识到失败路径、有意保留部分评论——但「保留部分结果」与「上报失败」并不冲突，后者是遗漏。
- 定性：**真实缺陷**（中危：审查结果的完整性保证被静默破坏，用户可能对未审查代码给出错误信任）。
- 修复建议：`CodeReviewResult` 增加 `failedGroups: { label; files; error }[]`，runner 汇总时从 `outcomes.filter(o => o.error)` 填充；`formatReviewReport` 在有失败组时输出显著警告段；进度消息对失败组改为 `Group N/M failed (label): <error>`。

### C26【中危｜资源】workspace 审查对未跟踪文件「先整读入内存、后判 10MB 上限」，超大未跟踪文件可打出无界内存占用甚至 OOM

- 位置：`src/review/git.ts:118-136`（`untrackedFileDiffs`：读取在 :125，大小检查在 :129）。
- 机制：
  ```ts
  content = await readFile(join(cwd, f));                          // ← 先无界读取
  if (content.length > MAX_UNTRACKED_FILE_SIZE || looksBinary(...)) // ← 后判 10MB
  ```
  工作区若存在多 GB 未跟踪文件（构建产物、日志、数据库 dump、模型权重——凡 `git ls-files --others --exclude-standard` 列出且未被 .gitignore 排除的一切），审查启动阶段即把整文件载入 Node 堆；单个足够大的文件可直接 OOM 杀掉 CLI 进程。10MB 上限防住了 diff 进入上下文，却**没防住读取本身**。
- 对照：同库其他路径均为「读前门禁」——`at-expand.ts:179` 先 `statSync` 对照 `MAX_RANGE_FILE_BYTES` 再读；`images/index.ts` 有 `MAX_IMAGE_INPUT_BYTES` 前置约束。`git.ts` 是同一防线模式的漏网点。grep 确认 `untrackedFileDiffs` 仅被 `collectDiffs`（workspace 模式）调用，无上游大小过滤；README/注释/测试均无「有意先读」声明。
- 定性：**真实缺陷**（触发需要工作区存在超大未跟踪文件，条件受限但后果为进程级）。
- 修复建议：读取前先 `statSync`，`size > MAX_UNTRACKED_FILE_SIZE` 直接跳过（可记入 `excluded: too-large`）；二进制嗅探只对前 N KB 采样。

### C27【低危｜正确性·疑似】`diffByPath` 以 old/new 双键索引，重命名链 `a→b`+`b→c` 下键 `b` 冲突，后写覆盖先写

- 位置：`src/review/runner.ts:224-232`（`newPath` 与 `oldPath` 双键 `set`，无冲突检测）。
- 机制：当一次变更集同时含 `a→b` 与 `b→c` 两个 diff（常规两点 `git diff -M` 会合并为 `a→c`，但逐 commit 拼接、rename 检测阈值等场景可产出两个独立 diff）时，键 `"b"` 被争夺，后写覆盖先写。消费方均直接 `get(path)` 无冲突检测：`FileReadDiff` 工具（`file-read-diff.ts:52`，给子代理看「其他文件的变更」）、评论 resolve（runner.ts:494/:527）、cross-file 证据收集（:447/:482-501）——都可能拿到**错误文件的 diff**，导致子代理基于错误证据下结论或评论定位错行。
- 定性：**疑似缺陷·待验证**（机制经代码确认成立；日常触发概率低——常规 rename 链会被 git 合并，故降为低危疑似）。
- 修复建议：写入前检测键冲突（已有该键且非同一 diff 时），为 old/new 键分命名空间（`old:`/`new:` 前缀）或保留数组；至少冲突时打日志。

### C28【极低危｜卫生】`@` 引用图片数超限提示绕过 `appendWithinLimit` 预算，且逐张重复追加

- 位置：`src/conversation/at-expand.ts:152-156`。
- 机制：正常路径所有附录内容都经 `appendWithinLimit` 受 `MAX_INLINE_TOTAL_BYTES`（300KB）约束；但图片超限提示走裸 `appendix +=`：
  ```ts
  if (imageBlocks.length >= MAX_IMAGES_PER_MESSAGE) {
    appendix += `\n\nError: too many images attached (limit ...)`; // ← 绕过预算
    continue;
  }
  ```
  两个小问题叠加：(1) 不受总字节预算约束（预算不变量上的针孔）；(2) 每超一张图追加一次，同一提示最多重复 `MAX_AT_REFS - MAX_IMAGES_PER_MESSAGE = 32 - 10 = 22` 次（UX 噪音）。因 `MAX_AT_REFS = 32` 硬性封顶，泄漏量以 KB 计，无实际危害。注释（:125「only exceeding the per-message image limit appends an error note」）只声明了「会追加提示」这一意图，未声明「绕过预算」与「重复追加」。tests/at-expand.test.ts 无锁定该提示的用例（grep「too many images」零命中）。
- 定性：**真实缺陷**（极低危，卫生问题）。
- 修复建议：提示语改走 `appendWithinLimit`，并用布尔标志确保只追加一次。

### C29【中高危｜正确性】远程页面刷新/新标签后，挂起的 permission / ask_user 请求永不重放，运行悬挂至 10 分钟超时后自动 deny

- 位置：`src/remote/server.ts:1290-1359`（connection handler）、`:3953-4013`（`createPermissionCallback`）、`:3923-3948`（`createAskUserCallback`，`pendingAsks.set` 于 :3944）。
- 机制：agent 运行触发权限请求时，回调 `broadcast({type:"permission_request"})` 并把 **resolver（一个闭包函数）** 存入 `pendingPermissions`（:4002-4006），等待 `PENDING_REQUEST_TIMEOUT_MS`（:180，10 分钟）超时后自动 `deny`（:3985-4000）。新 WS 连接建立时（:1299-1328）服务器补发 `connected`/`status`/`commands`/`history`/`usage`/空 `provider_list`，并**专门重放 `planApprovalPending`**（:1326-1328）——唯独不重放 `pendingPermissions`/`pendingAsks`。
- 关键：`pendingPermissions` 只存 resolver，**不存请求 payload**（id/toolName/description），故即便想重放也无数据可发。WS 断线重连（页面不刷新）时浏览器 reducer 状态在内存里、对话框仍在，这条路径没问题；但**页面刷新（F5）/新标签打开邀请 URL/token 轮换整页重载**后，前端从 `initialState` 重建，权限/提问对话框彻底丢失且不再出现，服务器端 resolver 仍挂着，运行卡死直到 10 分钟超时 deny。
- 意图核查：`planApprovalPending` 独享重放待遇，说明「重连后恢复挂起交互」是已被意识到的需求，permission/ask 属遗漏而非有意省略；README Remote 章节与 tests（remote-parity/remote-boundaries，`pendingPermissions` 仅在 boundaries:557 作字段断言）均无「刷新后不恢复」的声明。
- 定性：**真实缺陷**（中高危：远程交互模式下审批对话框可被一次刷新永久丢失，运行被动挂起 10 分钟）。
- 修复建议：`pendingPermissions`/`pendingAsks` 除 resolver 外同时保存请求 payload；connection handler 仿照 `planApprovalPending` 逐个重放。

### C30【中危｜终端 parity 缺口】code review 结束的 finally 不 `drainFollowUps()`，review 期间排队的消息滞留且此后顺序颠倒

- 位置：`src/remote/server.ts:3780-3783`（`handleCodeReviewStart` 的 finally）、`:1950-1951`（`drainFollowUps`）、`:3316`（wakeupTimer）。
- 机制：review 运行期间 `streaming=true`，浏览器发来的消息进 `handleSteeringMessage`——slash/bash 命令 `enqueueFollowUp`，普通文本因 `steer()` 失败（review 无 `currentAgent`，:640-646 返回 false）也 `enqueueFollowUp`。review 的 finally 只做 `this.reviewController=null; this.streaming=false;`，**唯独缺 `await this.drainFollowUps()`**。对照其他释放 streaming 槽的路径——`handleUserMessage`（:1742）、`runNotificationTurn`（:1806）、`changeProviderConfiguration`（:2581）——均 drain，仅 review 漏。
- 兜底失效：`wakeupTimer` 守卫 `if (!current || this.streaming || this.followUps.length > 0) return;`（:3316）在 followUps 非空时**显式跳过**，只负责通知唤醒，救不了滞留消息。结果队列滞留到用户下次主动发消息；而 `handleUserMessage` 先跑新消息、结尾才 `drainFollowUps()`（:1742），造成**旧排队消息在新消息之后执行**的顺序颠倒。
- 终端 parity 基准（本人核对）：`use-follow-up-queue.ts:50-86` 的 effect 依赖 `blocked`（含 isStreaming），终端 review 以 `setIsStreaming(false)` 结束后 streaming 一释放**立即自动 drain**——远程缺这一环。
- 定性：**真实缺陷**（中危：远程 review 期间的排队消息无限期滞留 + 顺序颠倒）。
- 修复建议：finally 中 `this.streaming=false;` 后追加 `await this.drainFollowUps();`（与 `changeProviderConfiguration` 一致）。boundaries:292 的 review 测试只断言 streaming 槽抢占/释放，未覆盖 drain，不冲突。

### C31【中低危｜终端 parity 缺口】远程 `/clear` 只停后台任务、不停 teammates，旧 team 继续跑并可能把汇报灌进新会话

- 位置：`src/remote/server.ts:2319-2339`（handleLocalUICommand "clear" 分支）、`:652-666`（`clearConversation`）。
- 机制：终端 `/clear`（app.tsx:1744-1745）`await Promise.all([backgroundTaskManager.stopAll(), teamManager.stopAll()])` 同停两者；远程 `/clear`（:2321）只 `await this.agentHandle.backgroundTaskManager.stopAll()`，`clearConversation()`（:652-666）轮换 session、重置 conv/taskList/fileHistory，但**完全不触碰 teamManager**。
- 后果：(a) `/clear` 后 teammates 继续后台跑、烧 token、往 leader mailbox 投通知，`wakeupTimer`（:3320 `hasLeaderNotifications()`）会在「已清空」的会话上突然启动通知轮，把旧 team 汇报灌进新会话；(b) 前端 teammates 面板残留——`teammateTimer`（:3287 `getAllTeammateStates()`）按签名广播，states 不变就不再发 `teammates` 帧。
- 排除误报（本人核对）：todos/backgroundTasks 无此问题——`taskList.useStore()` 与 `backgroundTaskManager.useSession()` 都会 `emitChange()`，经订阅链向浏览器重播空列表；唯独 teammates 依赖 `stopAll()` 改状态，而远程从不调用。
- 定性：**真实缺陷**（中低危：资源/成本泄漏 + 会话串扰 + UI 残留）。
- 修复建议：clear 分支改 `await Promise.all([backgroundTaskManager.stopAll(), teamManager.stopAll()])`（终端同款）；前端 `clear` 分支同时重置 `teammates:[]` 兜底。

### C32【中低危｜终端 parity 缺口】`runNotificationTurn` 不重置 `exitPlanSucceeded`，通知轮 `loop_complete` 可重复弹出已过期的 plan 审批对话框

- 位置：`src/remote/server.ts:1780-1807`（`runNotificationTurn`，:1785-1787 置位段）、`:2041-2046`（plan 审批门）、`:3586-3596`（过期定时器）、`:1185`（实例字段）。
- 机制：`exitPlanSucceeded` 是**实例字段**（:1185），仅在 `handleUserMessage`（:1653）、prompt 型命令（:2174）、`/plan args`（:3452）被重置；ExitPlanMode 成功时置 true（:2001-2002）。`runNotificationTurn`（:1785-1787）重置了 `streaming/runCanceled/turnCount`，**唯独漏 `exitPlanSucceeded`**。触发路径：plan 模式 ExitPlanMode 成功 → 弹审批 → 用户 10 分钟不理 → 审批过期（:3587 置 `planApprovalPending=false`，但 `permissionMode` 仍 "plan"、`exitPlanSucceeded` 仍 true）→ 后台 teammate/任务完成产生通知 → wakeupTimer 触发 `runNotificationTurn` → 该轮 `loop_complete` 时审批门 `permissionMode==="plan" && exitPlanSucceeded`（:2042-2043）**再次为真** → 同一旧计划第二次弹审批；此时点 "yolo" 会对早已过期的计划执行 bypassPermissions 并注入 "Execute this plan"。
- 终端 parity 基准（本人核对）：终端 `exitPlanSucceeded` 是 `runAgentTurn` 内**局部变量**（app.tsx:2420 `let exitPlanSucceeded=false`），每轮（含通知轮）天然重置——远程提升为字段后漏配通知轮，是明确的移植缺陷。
- 定性：**真实缺陷**（中低危：过期计划可被二次审批并意外进入 bypass 执行）。
- 修复建议：`runNotificationTurn` 置位段加 `this.exitPlanSucceeded=false;`（与 `handleUserMessage:1653` 对齐）。

### C33【低危｜资源/UX】`cancelActiveRun` 清 `planApprovalPending` 却不清 `planApprovalTimer`，取消后最长 10 分钟误播 "Plan approval expired"

- 位置：`src/remote/server.ts:4202-4205`（`cancelActiveRun`）、`:3586-3596`（timer 回调）。
- 机制：`cancelActiveRun` 置 `runCanceled=true`、清 `steeringHistoryRecorded`、`planApprovalPending=false`（:4205），**但无 `clearTimeout(this.planApprovalTimer)`**。对照正规关闭 `handlePlanApprovalResponse`（:3611-3615）标志与 timer 一起清。cancel 后 timer 继续存活，到期执行 `planApprovalPending=false` 并广播 "Plan approval expired after 10 minutes."——用户早已取消，却在最长 10 分钟后收到莫名过期消息。
- 定性：**真实缺陷**（低危：仅一条延迟的误导性 system 消息，无状态破坏）。
- 修复建议：`cancelActiveRun` 补 `if (this.planApprovalTimer){clearTimeout(this.planApprovalTimer);this.planApprovalTimer=null;}`。

### C34【低危｜健壮性/防御深度】`handleWsMessage` 顶层 switch 无 try/catch + `void` 调用 + `recover()` 把 unhandledRejection 升级为 `process.exit(1)`：部分处理器意外抛错可杀死整个远程服务器进程

- 位置：`src/remote/server.ts:1343`（`void this.handleWsMessage(...)`）、`:1389-1562`（switch 无顶层捕获）、`:2563-2583`（`changeProviderConfiguration` 为 `try/finally` **无 catch**）、`:2783`（`handleRewindAction` 同步无捕获）、`:3137`（`sendFileCompletions` 同步无捕获）、`src/recover.ts:137-148`、`src/main.tsx:198`。
- 机制：入口 `void this.handleWsMessage(ws, parsed.data)`（:1343）返回的 promise 无人接管；`handleWsMessage`（:1389-1562）switch **无顶层 try/catch**。多数分支内部有捕获（`handleUserMessage`:1709、review:3773、`handleImageUpload`:3089、`broadcastModelList`:2549），但**存在裸露路径**：`changeProviderConfiguration`（:2577-2582 `try{await change()}finally{...}` 无 catch）、以及 `rewind_action`→`handleRewindAction`、`file_complete_request`→`sendFileCompletions` 等同步无捕获处理器。任何这类异常沿 `void` promise 上浮为 `unhandledRejection`；远程入口 `main.tsx:198` 调 `recover()`，其 `unhandledRejection` 处理器（recover.ts:137-148）记录日志后 `process.exit(1)`。净效果：**一个未被内层捕获的处理器异常就能让整个远程服务器进程退出**，所有浏览器客户端断线（每 3s 徒劳重连）；终端模式下同样异常只炸当前 UI 轮次。
- 修正代理举证（本人核对）：分区代理原举 `/clear`（`backgroundTaskManager.useSession` 在 `pendingTaskIds.size>0` 时 throw、`taskList.useStore` 存储损坏时 throw "Duplicate task IDs"）为例——**此例不成立**：`/clear` 走 `user_message`→`handleUserMessage`，其 try/catch（:1709）会捕获这些 throw。真实裸露面是上列 `changeProviderConfiguration`/`handleRewindAction`/`sendFileCompletions` 等**不经 `handleUserMessage`** 的分支。throw 源本身属实（task-manager.ts:76-78、todo/index.ts:90-92），只是触发路径需修正。
- 定性：**真实缺陷**（低危：需特定分支抛错才触发，但后果为服务级进程退出，防御深度不足）。
- 修复建议：`ws.on("message")` 改为 `this.handleWsMessage(ws, parsed.data).catch(err=>{log.error({err},"ws message handler failed"); this.broadcast({type:"error",...})})`；或在 `handleWsMessage` 内包顶层 try/catch。低成本高收益兜底。

### C35【低危｜疑似·待验证】远程分区四条次要疑似缺陷（多端审批不互关 / rewind 快照 index TOCTOU / 前端离线队列无上限 / stop 依赖 close 回调）

> 以下四条机制经本人读码确认成立，但触发依赖特定环境或影响面小，统一列为疑似·待验证，不逐条升级为真实缺陷。

1. **多客户端审批不互关**（`server.ts:1431-1451`）：`permission_response` 处理只 `resolver()`+`pendingPermissions.delete(id)`，**不广播已决帧**；对照超时/取消路径有 `request_expired` 广播（:3978-3981/:3993-3996）。客户端 A 应答后，客户端 B 的 modal 对话框持续悬挂遮挡输入，B 点击时服务端因 resolver 已删而静默忽略。修复：应答成功后广播 `request_expired`/新增 `request_resolved`，前端据此关闭对应项。
2. **rewind 快照 index TOCTOU**（`server.ts:2769-2779` 按数组下标发 index、`:2799` `getSnapshots()[snapshotIndex]` 重取）：`streaming` 守卫（:2791）挡前台运行，但**后台 subagent 不占 streaming 槽**；若对话框打开期间后台 agent 调 `makeSnapshot` 且超过 `MAX_SNAPSHOTS=100`（file-history/index.ts:20）触发头部裁剪（:206-212），所有 index 左移，用户点选的 index 命中**更早快照**（回滚过头），执行时未复核 `snap.userText`。修复：快照引入稳定 id（timestamp+seq）按 id 定位，或执行前比对 userText/timestamp。
3. **前端离线队列无上限、重连盲发**（`browser/src/hooks/use-web-socket.ts:228-235` `pendingRef.push` 无界、`:147-149` onopen 全量 splice 补发）：断线期间累积 (a) 已失效的 `permission_response`（噪声）；(b) **大体积 `image_upload`**（每张最多 32MB base64，重连瞬间涌入可能触发服务端 maxPayload/内存尖峰）；(c) 队列无长度上限。修复：入队前丢弃时效消息（permission/ask response、ping），image_upload 不入队直接回报失败，并设队列上限。
4. **`stop()` 依赖 `server.close()` 回调**（`server.ts:4162-4166`）：WS 客户端已显式 `ws.close()`（:4156 前），但普通 HTTP keep-alive 空闲连接会使 `server.close()` 等到自然超时才回调，`stop()` 的 promise 悬挂（Node ≥18.2 有 `closeIdleConnections()` 而未调用）。CLI 退出通常伴随 process.exit，影响有限。修复：`server.close()` 前调 `this.server.closeIdleConnections()`。

### C36【低危｜安全/隐私】feedback `redactUrl` 对「畸形但含凭据」的 URL 原样返回，自由文本路径随之泄漏 `user:pass`

- 位置：`src/feedback/redact.ts:26-43`（`redactUrl` 的 `catch { return value; }`）、文本嵌入点 `:79-81`。
- 机制：`redactText` 先用 `\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s<>"'`]+`（:79）抓 URL 再交 `redactUrl`；`redactUrl`内`new URL(value)` 一旦抛错（端口 >65535、非法字符等），`catch` 分支**原串原样返回**（:41-42），`user:pass@` 不做任何处理。这与 C5（telemetry 完全不解析 URL）不同——feedback **有** URL 剥离能力（:29-32 正常路径正确清 username/password），只是畸形 URL 走了透传兜底。
- 实测验证（运行时调用 `redactUrl`/`redactText`）：
  ```
  redactUrl("https://user:pass@host:99999/x")      → "https://user:pass@host:99999/x"   （port 非法，new URL 抛错）
  redactText("GET https://user:pass@host:99999/x") → "GET https://user:pass@host:99999/x"  ← 凭据泄漏
  ```
  对照：合法 URL `https://user:pass@host/x` 被正确脱敏为 `https://host/x`。触发场景常见——日志/工具输出里带错误端点的连接串（`connect to https://dbuser:dbpass@db:99999 refused`）。
- 定性：**真实缺陷**（低危：需 URL 恰好畸形才触发；与「秘密不出机器」承诺矛盾，fail-open 方向错误）。
- 修复建议：`catch` 分支退化为保守正则剥除 userinfo（`\/\/[^@\s/]+@` → `//<redacted>@`），宁可误伤不可透传泄漏。

### C37【低危｜安全/隐私】feedback 脱敏：点号分隔的敏感键名（`db.password`、`spring.datasource.password`）不被识别，配置值原样上传

- 位置：`src/feedback/redact.ts:7-8`（`SENSITIVE_KEY` 边界 `(?:^|[-_])…(?:$|[-_])`）、`:83`（键捕获 `[\w.-]{1,128}` 允许 `.`）、`:13-15`（`isSensitiveKey` 只归一 camelCase→snake_case）。
- 机制：键值脱敏正则（:83）的键捕获 `[\w.-]` **允许点号**，故 `db.password` 作为整体被捕获；但 `SENSITIVE_KEY`（:8）要求敏感词左侧是行首/`-`/`_`，**`.` 不在边界集**，`isSensitiveKey("db.password")` 返回 false（实测确认）→ 判为非敏感、整行原样保留。注释（:5-6）声称 camelCase 与 snake_case 归一，但未考虑点分命名空间——这正是 Spring/Java 配置与 JDBC 属性最常见形态。
- 实测验证：
  ```
  redactText("spring.datasource.password=hunter2secret") → 原样泄漏
  redactText("db.password: letmein123")                  → 原样泄漏
  isSensitiveKey("db.password")                          → false
  （对照）redactText("mysql --password=hunter2secret")   → "mysql --password=<redacted>"（正常遮罩）
  ```
  触发路径：`collect.ts:535` 的 `collectConfigFile` 把用户 YAML 配置原文 `redactText` 后放进 environment.json 附件——点分键配置项直接随行上传 secret Gist。
- 定性：**真实缺陷**（低危：仅影响点分命名空间的键，但该形态在企业配置中极常见）。
- 修复建议：`SENSITIVE_KEY` 边界扩为 `(?:^|[-_.])`；`isSensitiveKey` 归一化时把 `.` 也当分隔符。

### C38【低危｜潜伏】`fetchPinnedAddress` 静默丢弃 `init.body`，仅因当前唯一调用方是 GET 而未爆雷

- 位置：`src/utils/public-http.ts:137-174`（`fetchPinnedAddress`：`request(url, { headers, lookup, method, signal }, cb)` 后 `outgoing.end()`，:172 **从不写 body**）。
- 机制：`fetchPublicHttpUrl(input, init)` 签名接受完整 `RequestInit`；未注入 `fetcher` 时走 pinning 路径（:212 `fetchPinnedAddresses`→:184 `fetchPinnedAddress`），`init.body` 被无声丢掉。grep 确认全文件无对 `init.body` 的引用。当前唯一调用方 `install-skill-tool.ts:145-149` 只做 GET（`{ signal }`，无 body/method），故不触发；但该模块经 lib barrel 对外导出（`src/index.ts:48 export * as Utils` → `utils/index.ts:8 export * as PublicHttp`），未来任何 POST/PUT 调用方会得到「200 但服务端没收到 body」的诡异行为，且无断言拦截。
- 定性：**真实缺陷（潜伏）**——与 C13（OpenAI document 裸 base64）同类：机制成立但当前无生产触发方，如实标注为潜伏而非现行故障。
- 修复建议：函数入口断言 `init.body === undefined`（显式 GET-only），或补 `outgoing.end(init.body)`。

### C39【低危｜疑似·待验证】feedback/telemetry/images/vscode 分区三条次要疑似缺陷（redaction 模式库形态空缺 / sharp 解码内存放大 / IDE 断连回调窗口）

> 以下三条机制经本人读码或实测确认成立，但均属「边界/尽力而为」判断或触发依赖特定输入，统一列为疑似·待验证。

1. **redaction 模式库形态空缺**（`redact.ts:47-59` `TEXT_PATTERNS`）：模式库只覆盖 sk-ant/sk-/AKIA/AIza/gh*\_pat/github_pat/xox*/Bearer 八类。实测以下常见秘密形态在**无敏感键名上下文**时全部原样通过 `redactText`：PEM 私钥块（`-----BEGIN RSA PRIVATE KEY-----...`）、裸 JWT（`eyJ...`）、`sk_live_`（Stripe live key，31 字符 + 下划线不满足 `\bsk-[A-Za-z0-9_-]{20,}` 的连字符前缀组合）、`curl -u user:pass`。**缓解因素**（本人核对）：`feedbackRedactor` 用 `secretValues(process.env/config/runtime)` 做**字面值全文替换**（`collect.ts:105/:535`），凡出现在环境/配置敏感键里的值都会被替换——上述泄漏仅限「不在已知敏感键值中」的秘密（工具输出、用户文件内容、历史命令）。是否接受为 best-effort 边界属设计判断，故列疑似。修复：补 PEM 块级遮罩、JWT 模式，`sk_live_`/`sk_test_` 提为独立模式。
2. **sharp 解码 ≤50MB 构造图片的内存放大（解压炸弹）无显式像素上限**（`images/index.ts:41` `MAX_IMAGE_INPUT_BYTES=50MB`、`:219/:239/:248` `sharp(buf)`）：50MB 是**磁盘字节准入**（:145 读前 `st.size` 门禁），但准入后交给 sharp/libvips 解码时，yukino 侧无 `limitInputPixels` 之类**像素**上限（grep 确认 `sharp(buf)` 均无该选项）；一个几十 MB 的高压缩比 PNG 声称超大尺寸时解码内存由 libvips 内部控制。**缓解因素**：≤3.75MB 直通不解码、sharp 为官方打包依赖跟随上游修复、全程可 abortSignal 打断，libvips 对损坏数据较稳健。修复：`sharp(buf, { limitInputPixels: N })` + metadata 预检尺寸。
3. **`connectToIde` 断连回调丢失窗口**（`vscode/ide-client.ts:80-97`）：`await client.connect(transport)`（:80）resolve 后才赋 `client.onclose = () => opts.onDisconnect?.()`（:95-97）；若扩展端恰在此微任务窗口内断开，SDK 读到的 `client.onclose` 还是 undefined，`onDisconnect` 永不触发，UI 以为仍连着 IDE（后续发送才失败）。窗口极小、无法稳定复现，故列疑似。修复：在 `client.connect` 之前设置 `client.onclose`（SDK 允许先挂回调），或 connect 后立即检查 transport 状态。

---

## 二、独立复核：既有三份报告的关键缺陷，本轮以代码事实/实测再次确认成立

> 遵守「其他 agent 的探索结果仅供参考，以代码事实为准」——下列条目均已由本人复核代码或重跑实测，确认与既有报告描述一致。此处只做精简印证，不重复其完整论证。

| 既有编号                        | 缺陷                                                                          | 本轮复核方式                                                                                                                                                                       | 复核结论                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| codex D1 / pi P1 / yukino H-1   | 多行 Bash 命令绕过锚定 deny/ask 规则；bypassPermissions 下 deny 完全失效      | 代码复核 `globMatch`（line 230-244，`^…$` 无 `s` 标志，`.` 不匹配换行）+ Layer 3.5 子命令切分仅在 `sandboxEnabled && sandboxAutoAllow && Bash` 路径；实测 `echo ok\nrm -rf /tmp/x` | **成立**：default 模式 deny→ask（被绕过），bypassPermissions→allow                                                                      |
| codex D2 / pi P2 / yukino H-3   | allow-always 命令规则过宽（无词边界 + 命令链整体放行）                        | 代码复核 `allowAlways` line 748-751（前 2 词 + `*`，`*` 匹配 `&                                                                                                                    | ;`）；实测 `git push origin main && curl … \| sh`                                                                                       | **成立**：命令链跟随前缀被放行 |
| codex D3 / pi P3                | OS 沙箱禁止写 /dev/null，`&&` 链断裂                                          | seatbelt 实测（`sandbox-exec` + 生成的 profile，带 cwd 选项）                                                                                                                      | **成立**：`echo hello > /dev/null && echo DEVNULL_OK` → DEVNULL_OK 未输出，stderr「/dev/null: Operation not permitted」，cwd 内写入正常 |
| codex D4 / pi P6                | 文件类 allow-always 对相对路径不生效                                          | 代码复核（规则匹配用 `extractContent` 原始文本，持久化用 `resolveToolPath` 绝对路径）+ 实测                                                                                        | **成立**：相对路径 `src/a.ts` 始终允许后，相对路径写仍 ask                                                                              |
| pi P5                           | 库入口把 optionalDependencies（遥测栈）变硬依赖                               | 代码复核 `telemetry/index.ts:3` 静态 `export * as Providers` + 构建产物 `dist/lib/index.js` 静态 import 链                                                                         | **成立**：barrel 静态再导出架空了「guarded dynamic import」                                                                             |
| pi P14 / yukino H-1             | allow 规则短路 Layer 4 路径沙箱 + 原始未规范化路径匹配 ⇒ 路径穿越可写任意文件 | 代码复核 `check()` line 702-707（`explicitEffect !== "allow"` 短路）+ 实测穿越字符串                                                                                               | **成立**：带 `..` 的原始路径命中 `src/*` allow 并短路沙箱                                                                               |
| pi P18 / yukino M-6             | `prompt_history.jsonl` 以默认 umask（644）落盘                                | 代码复核 `history/index.ts:66` `writeFileSync` 无 mode + 实测文件权限 `-rw-r--r--`                                                                                                 | **成立**：与项目敏感文件 0600 标准不一致                                                                                                |
| pi P19 / yukino M-4             | Ctrl+J（及 Shift+Enter）换行分支为死代码                                      | 代码复核 `input.tsx:586` + `node_modules/ink/build/parse-keypress.js`（`\n` 只设 name='enter' 从不设 ctrl，ctrl+letter 分支在其后）                                                | **成立**：换行分支不可达，实际直接提交                                                                                                  |
| pi P20 / yukino L-2             | WebFetch turndown 懒加载 Promise 缓存失败态                                   | 代码复核 `web-fetch.ts:84-91`（`??=` 无失败重置）对照 `computer-use.ts:963-971`/`a2a/executor.ts:387-401`（正确重置）                                                              | **成立**：失败态被永久缓存，是离群 bug                                                                                                  |
| pi P23 / yukino S-2             | McpCall `coerceBySchema` 对 `__proto__` 键方括号赋值触发原型替换              | 代码复核 `mcp-call.ts:105-108` `out[key] = …`                                                                                                                                      | **成立**                                                                                                                                |
| pi P25 / yukino L-1             | WriteFile 在最终门禁拒绝前已创建父目录                                        | 代码复核 `write-file.ts:104-117`（mkdir 在第二次门禁前）                                                                                                                           | **成立**                                                                                                                                |
| codex D5.2 / pi P7 / yukino L-? | FileStateCache 键未规范化（symlink/`/tmp` vs `/private/tmp`）                 | 代码复核 `file-state-cache.ts`（键未 realpath）对照 `file-mutation-queue.ts`（已 canonical 化）                                                                                    | **成立**：两种拼写被当成两个文件                                                                                                        |
| pi P9 / codex D5.4              | agent run() finally 中 session_end 钩子异常覆盖正常完成语义                   | 代码复核 `agent/index.ts:1096-1099`                                                                                                                                                | **成立**                                                                                                                                |
| codex D5.3 / pi P10             | SAFE_PREFIXES 重复项（head/tail/wc 各两次）                                   | 代码复核 `permissions/index.ts`                                                                                                                                                    | **成立**：纯冗余                                                                                                                        |
| pi P8                           | cleanExpiredSessions 锁外删 `*.rewind-tmp` 窄竞态                             | 代码复核 `session/index.ts:649-651`（锁外 rmSync）对照 `:276-300`（锁内 write→rename）                                                                                             | **成立**：窄竞态窗口                                                                                                                    |

> 说明：上表中标注「yukino L-?」者，是因 yukino 报告编号体系（H/M/L/S/D）与 codex/pi 不完全一一对应，本人以**代码位置**而非编号对齐，确保去重准确。

---

## 三、设计意图（非缺陷，列出以便复核）

以下行为经 README 或代码注释确认为**有意设计**，不计为缺陷：

1. **`DANGEROUS_PATTERNS` 为空，Layer-3 危险命令拦截休眠**（`permissions/index.ts`）：注释明确「Intentionally empty … stays inert until patterns are added」。意味着 C1/D1/D2 的规则越权没有第二道内置兜底——建议尽早补充作为纵深防御。
2. **WebFetch 无 SSRF 限制**：README 明确「Direct HTTP/HTTPS access, including project intranet endpoints, remains supported」。注意不对称：`InstallSkill` 用了 `fetchPublicHttpUrl`（SSRF 加固），WebFetch 没有；如需收紧可复用 `src/utils/public-http.ts`。
3. **print 模式（`-p`）恒为 bypassPermissions**：README 明确「Print mode intentionally bypasses permission prompts」。结合 C1/D1 需注意：CI 场景下 deny 规则是多行命令/通配符越权的唯一防线。
4. **ReadFile/Glob/Grep 可读取项目外任意路径且免审批**：README 明确「read-only tools can access paths outside the working directory without path approval」。（C3 的 file-scan 符号链接问题不在此列——那是补全候选枚举，非工具读取，且与 Grep/Glob 自身的符号链接防护矛盾。）
5. **Glob/Grep 跳过固定目录集合**（SKIP_DIRS：`.git`/`.agents`/`.yukino`/`node_modules`/`dist`/`__pycache__`）：工具描述明确声明「skips fixed directories … not rules from .gitignore」。
6. **A2A 服务仅强制 loopback、无 token**（`a2a/server.ts:46-48/101/107`）：loopback-only 边界为设计意图（ACP-WS 则 loopback+token）。
7. **`.mcp.json` 项目级 MCP 无信任门禁，启动即 spawn**（pi P16 已记）：经复核 `config/index.ts:286-349` 确无门禁——此条 pi 归为「安全/供应链缺陷」，本人认同其风险描述，但因 pi 已详细记录且属既有结论，此处不重复计为本轮新发现，仅印证。
8. **hooks 条件表达式用 `new Function` 求值**（`hooks/index.ts`）：注释论证配置文件本身即授予任意 shell 执行权，不引入新权限。
9. **`yukino update` 固定 npm registry 且仅在确认全局包管理时执行**（`update/install.ts`，本人通读确认健全）：供应链加固，设计良好。
10. **follow-up 失败重排队首+暂停**（`use-follow-up-queue.ts:69-77`）：注释明确「must not silently lose user input」——「不丢输入」本身是设计意图；C8 报告的是该设计**缺少配套丢弃出口**导致的毒化后果，二者不矛盾。

---

## 四、检查过且确认健壮的部分（本轮抽样，供覆盖度参考）

- **tool-result 预算**：`applyBudget` 的 exemptIds（spill read-back 防循环）、`isSpillReadback` 的路径段边界匹配、`writeSpill` 的 `wx` flag + EEXIST 幂等复用——除 C6 的净膨胀盲区外，其余逻辑健全。
- **images**：`sniffMediaType` 魔数嗅探（PNG/JPEG/GIF/WebP，GIF 检查 `>=6` 字节但只比对前 3 字节 `GIF`——足够区分，不构成缺陷）、`MAX_IMAGE_INPUT_BYTES` 50MB 读前门禁、`compressWithSharp` 每次新建 `sharp(buf)` 实例（注释明确避免复用陷阱）、质量阶梯 80/60/40/20 + 减半重试 3 次——逻辑正确。
- **commands/loader**：`renderBody` 模板替换（`${N:-fallback}`、`${@:s:l}`、`$ARGUMENTS`）边界（`$0`、越界索引）安全降级为空串；`parseCommandArgs` 引号/转义解析正确；`parse` 对含 `/` 的命令名返回 null（避免把路径误判为命令）。
- **Grep**：`toUnicodePattern` 对 `\w/\b/\d` 的 Unicode 属性改写 + u-mode 失败回退、二进制 NUL 嗅探、25MB 大文件跳过、lstat 符号链接防护（不下降 symlink 目录）、traversal 条目/深度双上限——健全。
- **Glob**：`globIterate` 的 `follow:false`（symlink 目录不下降，cycle-safe）、`matchBase`、mtime 排序、`SearchOutput` 的 matches/bytes 双上限——机制本身健全。（注：「先按遍历序截断 1000、后按 mtime 排序」这一点，我初判为可接受取舍，但经分区审计交叉复核后认定它与工具描述「sorted newest modification first」的承诺冲突，已升级为缺陷 **C19**，见第五节。）
- **telemetry/privacy**：`scrubTelemetryPayload` 的 WeakSet 防循环、环境变量值替换、home→`~`、键名黑名单（authorization/api_key/password/secret/credential/token/dsn/cookie）——除 C5 的 URL userinfo 盲区外健全。
- **feedback/redact**：结构化 JSON 路径（`redactJsonValue`/`redactValue`）整键命中即 `<redacted>`、`redactUrl` 用 `new URL()` 剥离 userinfo + 敏感查询参数、`redactJsonLines` 逐行回退——除 C4 的自由文本 Basic 凭据盲区外健全。
- **use-follow-up-queue**：unmount 守卫（`mounted.current`）、`pausedRef` 同步暂停防热循环、`active` 防重入——除 C7/C8 的清队/丢弃缺失外，并发语义本身正确。
- **use-terminal-controls**：卸载时 clearTimeout、非 ctrl+c 按键复位 ctrlCCount——除 C9 的忙碌分支遗漏外健全。
- **input.tsx 导航**：`moveInputVertically`/`locateInputCursor`/`inputBoundary` 的 cells 非空、caret 保留、clamp——除 C10 的历史召回光标位外健全。
- **review 分区**（除 C25/C26/C27 外，本人复核代理清单后抽样确认）：`git.ts` 所有 git 调用走 `execFile` + `--end-of-options` + `-c core.quotepath=false`，ref 注入防御（`validateReviewInput` 拒绝 `-` 开头）到位；`diff-parser.ts` 的 C 风格路径引号与 hunk 边界（`\ No newline`、空 hunk）处理完备；`filter.ts` 解析失败默认全 approve 是提示词声明+测试锁定的设计意图；`comment-tool.ts` Zod 校验、行号 clamp、重复抑制正确；每组独立 `CommentCollector`（runner.ts:236-239 注释明确防跨组索引污染）。
- **goal/plan-file/todo/history/file-history 分区**（本人复核代理清单后抽样确认）：goal 的 blocked 三连击 streak 连续性、budget_limited 挂起/恢复均被测试锁定；plan-file `wx` 独占创建 + 随机 slug；todo 的 `nextId` 防 ID 复用、依赖环/互惠/自依赖/悬空校验、tmp+rename 原子落盘；history 文件锁 + 原子追加 + 10k 上限；file-history rewind 的 baseline 保留/重试语义被测试完整锁定。conversation 分区除 C28 外：system-reminder 转义（`<` 先行）、`ensureToolPairing` 双边界测试、user-bash 输出 UTF-8 安全截断 + spill 0600 均健全。

---

## 五、结论与建议优先级

| 编号 | 结论                                                                                | 严重度     | 定性                 | 建议优先级                                                                 | 与既有报告关系                                   |
| ---- | ----------------------------------------------------------------------------------- | ---------- | -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| C1   | allow-always 对无内容字段工具持久化 `ToolName(*)` 通配符 allow                      | 高         | 真实缺陷             | **P0**（空 content 不生成 `*`；为 Agent/SendMessage/MCP 等定义收窄匹配键） | **新发现**（比 D2/P2 的命令族过宽更宽：纯 `*`）  |
| C2   | `tests/lsp.test.ts` 全量并行下概率性失败（timeout_ms 混淆握手与请求）               | 中         | 真实缺陷（测试侧）   | **P1**（initialize 用独立宽松超时）                                        | **新发现 + 更正**既有「全绿」结论                |
| C3   | `scanCwdFiles` 跟随符号链接，枚举工作区外目录                                       | 中低       | 真实缺陷             | **P1**（改 lstat，不下降 symlink 目录，与 grep.ts 对齐）                   | **新发现**（与 Grep/Glob 防护不一致）            |
| C4   | `redactText` 泄漏 HTTP `Basic` 凭据                                                 | 中低       | 真实缺陷             | **P1**（增加 `Basic\s+` 规则，与 Bearer 对称）                             | **新发现**                                       |
| C5   | `scrubTelemetryPayload` 不脱敏 URL userinfo                                         | 中低       | 真实缺陷             | **P1**（复用 `redactUrl`）                                                 | **新发现**（与 feedback `redactUrl` 能力不对称） |
| C6   | `applyBudget` 在 (2000,~2250] 区间 spill 净膨胀                                     | 低         | 真实缺陷             | P2（跳过守卫用真实盈亏平衡点）                                             | **新发现**                                       |
| C7   | `/clear`/`/resume`/`/rewind` 不清 follow-up 队列                                    | 中         | 真实缺陷             | **P1**（hook 加 `clear()` 并接线三处）                                     | **新发现**                                       |
| C8   | follow-up 队首失败无丢弃通道，毒化队列                                              | 中低       | 真实缺陷             | P2（失败项出口 / 按索引召回）                                              | **新发现**（与 M-5/P15 共享 throw 源，后果不同） |
| C9   | Ctrl+C 忙碌分支不清陈旧退出提示                                                     | 低         | 真实缺陷             | P3（抽 `resetCtrlC()`）                                                    | **新发现**                                       |
| C10  | 历史召回多行光标落首行（与队列召回不一致）                                          | 低         | 真实缺陷             | P3（统一落末行）                                                           | **新发现**                                       |
| C11  | 注释称项目级 prompts 覆盖全局，实现只读全局                                         | 卫生       | 真实缺陷             | P3（删改注释或补实现）                                                     | **新发现**                                       |
| C12  | 命令加载器大小写折叠去重依赖 readdir 顺序                                           | 卫生       | 真实缺陷             | P3（冲突 warn 或排序）                                                     | **新发现**                                       |
| C13  | OpenAI document 块 `file_data` 裸 base64 缺 `data:` 前缀（当前潜伏，无生产产出方）  | 中（潜伏） | 真实缺陷             | P2（拼前缀 + Chat 补 url 分支）                                            | **新发现**（分区审计→本人复核，确认潜伏）        |
| C14  | Chat 路径 `content_filter` 静默映射 `end_turn`（vs Responses 抛错）                 | 低         | 真实缺陷             | P2（显式抛 LLMError 对齐）                                                 | **新发现**                                       |
| C15  | A2A executor `sessions` Map 条目永不删除，无界增长                                  | 低         | 真实缺陷             | P3（软上限 / 驱逐即删）                                                    | **新发现**                                       |
| C16  | MCP stdio 子进程未注册同步退出清理（与 LSP 不对称，违背 exit-cleanup 注释）         | 低         | 真实缺陷             | P3（注册 `registerExitCleanup` 对齐 LSP）                                  | **新发现**                                       |
| C17  | SkillCatalog loadSkill read-then-stat，并发写固化陈旧正文                           | 低         | 真实缺陷             | P3（改 stat-before-read）                                                  | **新发现**                                       |
| C18  | ExitWorktree 参数全由模型控制、无归属校验（与 C1 复合放大）                         | 低中       | 真实缺陷             | P2（校验 path 归属 + git_root 反推）                                       | **新发现**（与 C1 复合）                         |
| C19  | Glob 先截断后排序，违背描述「sorted newest first」                                  | 低         | 真实缺陷             | P3（全收集后排序再截 / 修正提示）                                          | **新发现**（修正本报告 §四初判）                 |
| C20  | detectEnvironment execSync 无超时 + 分支名原文注入系统提示词                        | 低         | 疑似·待验证          | P3（execFileSync+timeout，分支名过滤）                                     | **新发现**                                       |
| C21  | pre_send 钩子通知/skillDelta reminder 不持久化（与其他 reminder 不一致）            | 低         | 疑似·待验证          | P3（统一策略或注释固化）                                                   | **新发现**                                       |
| C22  | ACP session/load 重放忽略压缩边界，transcript≠runtime 上下文                        | 低         | 疑似·待验证          | P3（复用 rebuildFromSession 或注释固化）                                   | **新发现**                                       |
| C23  | loadSingleFile 未把 YAMLException 包成 ConfigError，报错缺路径                      | 极低       | 疑似·待验证          | P3（包装 ConfigError）                                                     | **新发现**                                       |
| C24  | forCwd 共享 ruleEngine，规则按原 cwd project key（当前调用方均同项目）              | 极低       | 疑似·待验证          | P3（注释固化或按新 cwd 重建）                                              | **新发现**（架构隐患）                           |
| C25  | /review 组失败静默吞没（outcome.error 只写不读，报告无失败迹象）                    | 中         | 真实缺陷             | **P1**（CodeReviewResult 增加 failedGroups + 报告警告段）                  | **新发现**（分区审计→本人复核确证）              |
| C26  | workspace 审查未跟踪文件先整读后判 10MB，可 OOM                                     | 中         | 真实缺陷             | **P1**（读前 statSync 门禁，与 at-expand 对齐）                            | **新发现**（分区审计→本人复核确证）              |
| C27  | diffByPath old/new 双键在重命名链下冲突覆盖                                         | 低         | 疑似·待验证          | P3（键分命名空间或冲突检测）                                               | **新发现**                                       |
| C28  | @图片超限提示绕过 appendWithinLimit 且重复追加                                      | 极低       | 真实缺陷             | P3（走预算 + 布尔去重）                                                    | **新发现**                                       |
| C29  | 远程刷新后挂起 permission/ask 永不重放，悬挂 10 分钟自动 deny                       | 中高       | 真实缺陷             | **P1**（pending 保存 payload + 连接时重放）                                | **新发现**（remote 分区→本人复核确证）           |
| C30  | 远程 review 结束不 drainFollowUps，排队消息滞留+顺序颠倒                            | 中         | 真实缺陷             | **P1**（finally 补 drain，对齐终端 effect）                                | **新发现**（终端 parity 缺口）                   |
| C31  | 远程 /clear 不停 teammates，旧 team 续跑+串扰新会话+UI 残留                         | 中低       | 真实缺陷             | P2（clear 补 teamManager.stopAll）                                         | **新发现**（终端 parity 缺口）                   |
| C32  | runNotificationTurn 不重置 exitPlanSucceeded，过期 plan 二次弹审批                  | 中低       | 真实缺陷             | P2（通知轮补重置，对齐终端局部变量）                                       | **新发现**（终端 parity 缺口）                   |
| C33  | cancelActiveRun 清 pending 标志却不清 planApprovalTimer，误播过期                   | 低         | 真实缺陷             | P3（补 clearTimeout）                                                      | **新发现**                                       |
| C34  | handleWsMessage 顶层无 catch + void 调用 + recover 升级为 exit(1)                   | 低         | 真实缺陷             | P2（入口 .catch 兜底）                                                     | **新发现**（修正代理举证）                       |
| C35  | 远程四条次要疑似（多端审批不互关/rewind index TOCTOU/离线队列无界/stop close 回调） | 低         | 疑似·待验证          | P3                                                                         | **新发现**                                       |
| C36  | redactUrl 畸形 URL catch 透传，user:pass 泄漏（与 C5 同根不同层）                   | 低         | 真实缺陷             | P2（catch 分支保守剥 userinfo）                                            | **新发现**（feedback 分区→本人实测确证）         |
| C37  | 点分键名（db.password）不识别为敏感键，配置值原样上传                               | 低         | 真实缺陷             | P2（SENSITIVE_KEY 边界加 `.`）                                             | **新发现**（feedback 分区→本人实测确证）         |
| C38  | fetchPinnedAddress 静默丢弃 init.body（当前唯一调用方为 GET，潜伏）                 | 低         | 真实缺陷（潜伏）     | P3（断言 GET-only 或写 body）                                              | **新发现**（同类 C13 潜伏）                      |
| C39  | feedback/images/vscode 三条次要疑似（模式库空缺/sharp 像素上限/IDE 断连窗口）       | 低         | 疑似·待验证          | P3                                                                         | **新发现**                                       |
| 二   | 既有 D1/D2/D3/D4/P5/P14/P18/P19/P20/P23/P25/P7/P9/P10/P8 等                         | —          | 本轮复核**全部成立** | 见各自报告                                                                 | 独立印证                                         |
| 三-1 | 危险命令黑名单休眠                                                                  | —          | 设计意图             | 建议补充 DANGEROUS_PATTERNS 作 C1/D1/D2 兜底                               | 印证                                             |
| 三-2 | WebFetch 无 SSRF 限制                                                               | —          | 设计意图             | 如需收紧复用 public-http                                                   | 印证                                             |

### 本轮核心增量（相对 codex/pi/yukino 三份报告）

1. **C1（`ToolName(*)` 通配符越权）** 是本轮最重要的新发现：它揭示 `allowAlways` 的 else 分支对**所有无内容字段的 command/write 工具**（含破坏性的 `ExitWorktree`、可派发子代理的 `Agent`、跨代理 `SendMessage`、动态 MCP 工具）退化为纯 `*` 通配符 allow，一次「始终允许」= 永久放行该工具全部调用。这比既有报告聚焦的「Bash 命令族过宽」覆盖面更广、危害更直接。
2. **C2（lsp 测试 flaky）** 更正了三份报告一致的「`pnpm test` 全绿」结论：在全量并行 + CPU 争用下 `tests/lsp.test.ts` 概率性失败（实测隔离 6/6 通过、并行 5/5 失败），根因是测试用 100ms 的 `timeout_ms` 同时约束了 LSP 子进程 initialize 握手。
3. **C3/C4/C5** 是三条独立的「防护不对称」缺陷：file-scan 跟随符号链接（vs Grep/Glob 不跟随）、redactText 漏 Basic（vs 已处理 Bearer）、telemetry scrub 漏 URL userinfo（vs feedback redactUrl 已处理）——能力在同库其他位置已正确实现，只是未在这些路径复用。
4. **C7/C8** 揭示 follow-up 队列在上下文切换（/clear、/resume、/rewind）与持久失败下的两类正确性问题，均经代码事实确认（hook 无 clear API、enqueue 无条件解除暂停、takeLast 只删队尾）。
5. **C13–C19**（分区审计交叉印证）：本人对分区代理的发现逐条以代码事实复核后新增确证——其中 **C13（OpenAI document 裸 base64）** 经 grep 确认当前无生产产出方而如实标注为「潜伏」；**C14/C15/C16/C17** 为四处「同库其他路径已正确处理、此处遗漏」的低危一致性缺陷；**C18（ExitWorktree 参数无归属校验）** 与 C1 的 `ExitWorktree(*)` 规则形成复合放大；**C19（Glob 截断先于排序）** 修正了本报告 §四的初判。**C13/C18 与 C1/C6 一样，由分区代理与本人独立收敛到同一结论，交叉印证。**
6. **C20–C24** 为五条「机制成立但触发依赖环境/属设计边界」的疑似缺陷，均已明确标注置信度（待验证/极低危），不作夸大定性。
7. **C25–C28**（review/conversation 分区，本人逐条代码复核确证）：**C25（/review 组失败静默吞没）** 是其中最重要的——`outcome.error` 全仓零读取方、`CodeReviewResult` 无错误字段、报告唯一异常出口是 `aborted`，失败组与成功组在进度和报告中完全无法区分，破坏审查完整性保证；**C26（未跟踪文件先整读后判 10MB）** 与同库 `at-expand.ts`/`images` 的「读前门禁」模式相悖，超大未跟踪文件可 OOM 整个 CLI；**C27（diffByPath 重命名链键冲突）** 机制成立但常规 git rename 合并使触发罕见，如实降为疑似；**C28（图片超限提示绕过预算 + 重复追加）** 为极低危卫生问题。该分区代理另有 20+ 条候选（filter 全 approve、relocate 回退、goal streak、todo 依赖环校验等）经测试/注释/README 三方对照判定为设计意图或无害，按「宁可少报」未收录。
8. **C29–C35**（remote/browser 分区，本人逐条代码复核确证）：该分区整体防护质量高（WS 鉴权 timing-safe + Origin 校验、双向 zod schema、streaming 槽同步抢占无竞态、timer 全 unref + stop() 逐一 clear），六条真实缺陷集中在两类根因——**(1) 终端→远程移植的状态重置/收尾遗漏**：C30（review 不 drainFollowUps）/C31（/clear 不停 teammates）/C32（通知轮不重置 exitPlanSucceeded），三者均是终端靠 React 局部变量或 effect 依赖天然获得的行为，服务端提升为实例字段/手写 finally 后漏配；**(2) 挂起交互的重放与异常兜底不完整**：C29（刷新后 permission/ask 不重放，`pendingPermissions` 只存 resolver 不存 payload）/C33（cancel 不清 planApprovalTimer）/C34（顶层 switch 无 catch + `void` + recover 升级 exit(1)）。其中 **C29/C30 用户可感知影响最大，C34 是唯一可致整进程退出的项**。**C34 修正了代理举证**：代理原举 `/clear` 的 throw 为例，但本人核对该路径经 `handleUserMessage:1709` 的 try/catch 捕获、**不成立**；真实裸露面是 `changeProviderConfiguration`（try/finally 无 catch）与 `handleRewindAction`/`sendFileCompletions` 等不经 `handleUserMessage` 的同步分支——throw 源属实但触发路径需修正，已如实标注。C35 为四条机制成立但触发依赖特定环境/影响面小的疑似项（多端审批不互关、rewind index TOCTOU、前端离线队列无界、stop 依赖 close 回调）。该分区另有 6 条候选（cancel 后 drain、subagentStates 每轮清空、todos 残留、rAF 合帧、steeringHistoryRecorded 清空、stop 丢 followUps）经 parity 对照或测试锁定判定为设计意图，未收录。
9. **C36–C39**（feedback/telemetry/update/images/logger/storage/theme/vscode/utils 分区，本人逐条代码复核 + 运行时实测确证）：该分区代理上报的 5 条真实缺陷（F1–F5）与 3 条疑似（S1–S3）中，**F1（Basic/多词值泄漏）≡ 已录 C4**（同一 `[^\s,;}\]]+` 值分支机制，C4 修复建议已涵盖多 token 情形，不重复计数）、**F4（scanCwdFiles 符号链接）≡ 已录 C3**（含远程 file_complete 调用方，与 C3 同一根因，不重复计数）；其余经本人复核新增为 C36–C39——**C36（redactUrl 畸形 URL catch 透传 user:pass）** 与 C5（telemetry 不解析 URL）同根不同层：feedback 有剥离能力但畸形 URL 走 fail-open 兜底，实测 `https://user:pass@host:99999/x` 原样泄漏；**C37（点分键名不识别）** 实测 `spring.datasource.password=…`/`db.password: …` 原样泄漏、`isSensitiveKey("db.password")=false`，而 `--password=` 正常遮罩，键捕获允许 `.` 但 SENSITIVE_KEY 边界集不含 `.`；**C38（fetchPinnedAddress 丢 body）** 与 C13 同类如实标注「潜伏」——grep 全文件无 `init.body` 引用、唯一调用方 GET-only，但经 lib barrel（`src/index.ts:48`→`utils/index.ts:8`）对外导出，未来 POST 调用方将得到「200 但无 body」；**C39** 为三条疑似（redaction 模式库空缺/sharp 像素上限/IDE 断连微任务窗口），其中模式库空缺经实测确认 PEM/裸 JWT/sk_live/curl -u 四种形态在键名上下文缺失时原样通过，但 `secretValues` 字面值替换兜底（collect.ts:105/:535，本人核对）限制了实际影响面，如实列为疑似。该分区另有 5 条候选（browser 通道不写 dedup、附件上传 secret Gist、logger 无轮转、telemetry 部分初始化降级、analyze 最小 prompt）经 README/注释对照判定为设计意图或 opt-in 取舍，未收录；其健壮清单（update 版本正则与 tag 白名单、Gist 空内容封装、zip CRC32、telemetry 数据最小化与降级、storage sessionPath 白名单、theme 零不可信输入、lockfile NFC 归一）经本人抽样核对成立。

> 验证环境：macOS（seatbelt 实测）、Node v24.16.0、`pnpm typecheck`/`lint` 通过；`pnpm test` 存在 C2 所述 flaky。所有运行时实测脚本（权限 `Tool(*)`/穿越、seatbelt /dev/null、file-scan 符号链接、redactText Basic、scrubTelemetryPayload userinfo、applyBudget 净膨胀、dist 静态导入链）均在项目目录内执行后删除，仓库无残留改动（`git status` 仅剩三份既有报告与本报告为 untracked）。

---

# 第二轮探索补充报告（C40–C50）

> 本轮聚焦第一轮未深挖的分区：**teams（协作/邮箱/文件锁）、memory（提取/固化/权限）、compact（阈值/熔断）、llm（消息构建）、permissions（路径归一化）、skills（目录优先级）、subagent（工具过滤/worktree）**。方法与第一轮一致：分区并行审计 → **本人对每条候选逐一以代码事实复核**（必要时本机 node 实验）→ 丢弃误报 → 明确定性「真实缺陷 / 疑似·待验证 / 设计意图」。5 个分区代理中有 4 个在收尾前因 API 连接中断（ENOTFOUND）未产出最终记录，其思路块中的候选已由本人独立复核；memory 分区代理产出完整报告，9 条候选本人逐条核对代码后收录 6 条、降级/合并 3 条。所有条目均给出精确 file:line、机制、交叉验证（测试/注释/README）与定性。

## 一、真实缺陷（本轮新增，均已代码复核确证）

### C40【中低危｜安全/权限模型】teammate 可绕过 leader 独占权关停同级 teammate：`waitForNextPromptOrShutdown` 不校验发送方，而 `SendMessage` 允许任意成员发 `shutdown_request`

- **位置**：`src/teams/index.ts:442`（`const shutdown = msgs.find((m) => isShutdownRequest(m));` — **无 `from` 校验**）；对照 `src/teams/index.ts:518-519`（`runPlanApproval` 内 `messages.find((message) => message.from === LEADER_NAME && isShutdownRequest(message))` — **有** `from===LEADER_NAME` 校验）；`src/teams/tools.ts:205-206`（`case MSG_SHUTDOWN_REQUEST: structured = shutdownRequest(this.senderName, message);` — 任意 senderName 均可构造关停请求）；对照 `src/teams/tools.ts:179-188`（仅 `MSG_PLAN_APPROVAL_RESPONSE` 做 `this.senderName !== LEADER_NAME` 门禁）；`src/teams/task-stop.ts:108-110`（`if (!this.leaderAccess) return { output: "Only the leader can stop teammates.", isError: true };`）。
- **机制**：`isShutdownRequest`（`src/teams/protocol.ts`）既接受 typed `MSG_SHUTDOWN_REQUEST`，也接受任何 `text` 以 `[shutdown]`（`SHUTDOWN_PREFIX`）开头的消息，且**不检查发送方**。空闲 teammate 在 `waitForNextPromptOrShutdown` 轮询自己的邮箱，命中的第一条关停消息即触发终止流程。因此 teammate A（其 `SendMessageTool` 以 `senderName=memberName` 实例化，见 `src/subagent/agent-tool.ts:563`）可 `SendMessage(to="B", type=shutdown_request)`，或发送 `content="[shutdown] …"` 的普通文本，令 B 关停——**绕过了 `TaskStop` 明确设定的「只有 leader 能停 teammate」特权模型**。同一特权在 `runPlanApproval` 路径已正确用 `from===LEADER_NAME` 收紧，两条路径不一致，证明这是遗漏而非设计。
- **交叉验证**：`task-stop.ts` 的 leader 门禁、`tools.ts` 的 plan_approval_response leader 门禁、`runPlanApproval` 的 from 校验，三处共同确立了「关停/审批是 leader 特权」的意图；`waitForNextPromptOrShutdown` 与 `SendMessage` 的 shutdown 分支是该意图的两处缺口。无测试覆盖「teammate 关停 teammate 应被拒」。
- **定性**：**真实缺陷**。危害面限于团队信任边界内（一个行为异常或被提示注入的 teammate 可 DoS 同级），但破坏了 leader 对团队生命周期的独占控制。
- **修复建议**：`waitForNextPromptOrShutdown` 与 `runPlanApproval` 对齐，只认 `message.from === LEADER_NAME` 的关停；并在 `SendMessageTool` 对 `MSG_SHUTDOWN_REQUEST`/`[shutdown]` 文本增加与 plan_approval_response 同款的 leader 门禁（非 leader 拒绝）。

### C41【中危｜功能】consolidation 子代理被指示检索会话 transcript，但 `MemoryPermissionChecker` 必然拒绝——「Phase 2: Gather」取证阶段是静默死路径

- **位置**：`src/memory/consolidation.ts:111`（`const transcriptDir = getSessionsDir(this.cwd);`）、`:125`（`new MemoryPermissionChecker(this.cwd, true)`）、`:199`（prompt 注入 `Session transcripts: ${transcriptDir} …`）、`:209`（`Phase 2: Gather … Search transcripts for specific missing context`）；`src/memory/permissions.ts:44-48`（read 分支只放行 `insideMemory` 或 `allowProjectReads && isPathWithin(memoryCwd, path)`）；`src/storage/index.ts:30-32`（`getSessionsDir = yukinoPath("sessions", projectKey(cwd))`）。
- **机制**：`transcriptDir` 解析为 `~/.yukino/sessions/<key>`。`MemoryPermissionChecker` 的 `memoryRoots` 是 `[projectPath(cwd,"memory"), yukinoPath("memory")]`（`permissions.ts:16`），`allowProjectReads=true` 只额外放行**项目 cwd 内**的路径。`~/.yukino/sessions/<key>` 既不在任一 memory 根内，也不在项目 cwd 内（除非用户恰在 `$HOME` 运行）→ 子代理对 transcript 的每一次 Grep/ReadFile 都在 `agent/index.ts:1326` 的 checker 处被 deny。工具级 deny 不是 agent 级 error，`run()` 正常结束 → `markConsolidationSucceeded`（`consolidation.ts:97`）照常重置 24h 闸门。结果：**「对照 transcript 核查记忆漂移」的整个取证能力被自家沙箱封死且静默失效**，consolidation 退化为仅凭 memory 目录自洽整理，却每 24h「成功」一次。
- **交叉验证**：`tests/consolidation.test.ts` 的 E2E 用例 `skipIf(!YUKINO_TEST_API_KEY)` 且从不断言 transcript 访问；`tests/permissions.test.ts` 只测 memory 目录内写放行/外写拒绝，未覆盖 sessions 目录读。prompt 与 checker 由同一文件（`consolidation.ts`）引入，属实现自相矛盾。
- **定性**：**真实缺陷**（设计的核心能力被自身权限沙箱封死，失败被吞没）。
- **修复建议**：要么把 `getSessionsDir(cwd)` 加入 consolidation 子代理 checker 的只读根，要么从 prompt 删除 transcript 检索指示、改为把所需 transcript 摘要预先注入 prompt（不给子代理检索权）。

### C42【中高｜并发/数据丢失】remote server 每次 loop 完成都 `new MemoryExtractor`，跨实例并发使 coalescing 契约失效，新建记忆文件竞态可静默覆盖丢数据

- **位置**：`src/remote/server.ts:601`（`new MemoryExtractor(this.client, this.cwd).extract(summary).catch(() => {});`，位于 `onLoopComplete`）；对照 `src/ui/app.tsx:437`（`const memExtractingRef = useRef(false);`）、`:2385`（`memExtractorRef.current ??= new MemoryExtractor(client, cwd);`）、`:2372`（`memCursorRef` 游标去重）、`:2375/2404`（`memExtractingRef` 前后置守卫）；`src/memory/extractor.ts:41-42`（doc 承诺 `at most one extraction is queued`）、`:57-63`（`inProgress`/`pendingContext` 是**实例字段**）。
- **机制**：coalescing 依赖**实例复用**（`inProgress`/`pendingContext` 是实例状态）。app.tsx 用 `??=` 复用单实例 + `memExtractingRef` 二次守卫；server.ts **两者皆无**——每次 `onLoopComplete` 都新建实例，`inProgress` 恒为 `false`，合并逻辑永不生效。远程用户连发两条消息（或多个远程会话共享同一 cwd）时，第一个提取子代理仍在跑（LLM 往返数十秒），第二个又孵化一个新子代理。两个子代理各有独立 `FileStateCache`：对**新建**文件（提取的典型产物），`write-file.ts:93-104` 的 read-before-write 闸门对不存在文件直接跳过；又因 server 端**没有 app.tsx 的 `memCursorRef`**，两次 `slice(-40)` 摘要高度重叠 → 提炼出同名 slug 概率高 → 后写者**整文件覆盖**先写者，无报错，记忆静默丢失；同时 N 个并发子代理各自烧 token。
- **交叉验证**：grep 全部测试无 server 端提取并发/coalescing 用例；`extractor.ts` 头注释明确声明合并契约，server.ts 实现直接违反。
- **定性**：**真实缺陷**（契约与实现不一致 + 数据丢失竞态 + 成本翻倍）。
- **修复建议**：server 端改为复用单个 `MemoryExtractor` 实例并加 `memExtracting` 守卫 + 摘要游标，与 app.tsx 对齐；或把合并状态（`inProgress`/`pendingContext`）提升为按 cwd 键的进程级单例。

### C43【中危｜安全/沙箱作用域】Glob 绝对路径 pattern 绕过 `MemoryPermissionChecker` 读作用域——记忆子代理可枚举文件系统任意绝对路径

- **位置**：`src/memory/permissions.ts:24`（`const requested = args.file_path ?? args.path ?? this.memoryCwd;` — **从不检查 `args.pattern`**）；`src/tools/glob.ts:92-103`（`globIterate(pattern, { cwd: basePath, … })` — pattern 原样交给 glob 库）。
- **机制**：checker 只解析 `file_path`/`path`，Glob 的 `pattern` 完全不进入权限判定；glob 库对**绝对** pattern 忽略 `cwd`。**本机实验证实**：`globIterate('/etc/hosts*', { cwd:'/tmp', dot:true, matchBase:true, nodir:true })` → `['/etc/hosts.equiv','/etc/hosts']`。故记忆子代理（extractor 严格模式 `allowProjectReads=false`，consolidation 亦然）可用 `Glob { pattern:"/Users/*/.ssh/id_*", path:"<memory dir>" }` 枚举任意绝对路径的**文件名与目录结构**（mtime 排序）。读不到内容（`ReadFile` 的 `file_path` 有 canonicalPath 校验），但足以测绘攻击面或经 LLM 输出侧信道泄漏路径清单。威胁模型现实：consolidation/extractor prompt 自身把 transcript/memory 标注为「evidence, not instructions」，即项目方承认存在提示注入面；被注入的子代理可利用此通道。
- **交叉验证**：`tests/harness-data.test.ts` 只测 `MEMORY_NAME: ../escape` 路径穿越与 symlink 写逃逸，无 Glob pattern 逃逸用例；pi 报告总结 memory 防护时只列「名称白名单正则防路径注入」，未意识到 pattern 通道。
- **定性**：**真实缺陷**（沙箱读作用域绕过 / 信息泄漏面；仅枚举不含内容读，故定为中危）。
- **修复建议**：`MemoryPermissionChecker.check` 对 Glob/Grep 额外校验 `args.pattern`——含前导 `/` 或 `..` 的绝对/越界 pattern 一律 deny，或在 Glob 工具侧对 memory 子代理拒绝绝对 pattern。

### C44【中危｜数据损坏/丢失】extractor 文本回退写盘非原子、无锁、无存在性检查——崩溃致记忆文件损坏，同名既有记忆被静默整体覆盖

- **位置**：`src/memory/extractor.ts:251-252`（`mkdirSync(dir,{recursive:true}); writeFileSync(filePath, this.formatMemoryFile(mem), "utf-8");` — 直接写，无 tmp+rename、无 `withFileSyncLock`、无 `existsSync` 闸门）；对照 `src/memory/manager.ts:299-318`（`writeIndex` 标准：`withFileSyncLock` + 临时文件 + `renameSync` + `finally rmSync`）；`src/memory/manager.ts:136-165`（`readMemory` 对 `parseFrontmatter` throw 者返回 null → 记忆从 load/index/recall 全链路消失）；`tests/memory.test.ts:245-268`（证实 malformed frontmatter 文件被全链路跳过）。
- **机制**：三重叠加问题——(1) **非原子**：`writeFileSync` 先 O_TRUNC 再写，进程中途被杀（CLI 退出/OOM/断电）留下截断文件；若截断切在 frontmatter 中（`---` 开头无闭合），`parseFrontmatter` throw → 该记忆**逻辑丢失**。(2) **无跨进程锁**：UI 实例与 remote server 对同一项目同时走回退路径写同名文件时交错截断，产生内容拼接损坏。(3) **静默覆盖**：回退路径无 `existsSync`、不经 `FileStateCache` read-before-write 闸门；LLM 输出的 `MEMORY_NAME` 与既有记忆同名时（manifest 只是「建议去重」，模型可能复用名），既有内容被无提示整体替换——而主路径 WriteFileTool 对已存在文件强制先读，回退路径绕过了这道保护。
- **交叉验证**：同仓库 `manager.ts` 对 MEMORY.md 采用完整 lock+tmp+rename，证明项目自身认可该标准，回退路径未复用属遗漏。回退路径确有 `MemoryPermissionChecker.check`（`extractor.ts:244-250`）做**作用域**校验，但无**原子性/存在性**校验。测试只验证回退解析正确性，无崩溃/并发/覆盖场景。
- **定性**：**真实缺陷**（数据损坏 + 数据丢失；原子性缺失 + 保护闸门旁路）。
- **修复建议**：回退写盘复用 `manager.ts` 的 `withFileSyncLock` + tmp+rename；写前 `existsSync` 检查，命中既有文件时改名或走 read-before-write。

### C45【中低危｜生命周期/成本】后台 extractor / consolidator 子代理完全无 abortSignal 接线——中止/退出后仍继续烧 token 并写记忆

- **位置**：`src/memory/extractor.ts:184-192`（`new Agent({ client, registry, checker, conversation, cwd, fileStateCache, maxIterations:5 })` — **无 `abortSignal`**）；`src/memory/consolidation.ts:130-138`（`maxIterations:15`，同样无 `abortSignal`）；`src/agent/index.ts:106/211`（`Agent` 支持 `abortSignal` 配置）；对照 `src/memory/manager.ts` recall selector 路径传了 `controller.signal`（findRelevantMemories）。
- **机制**：`Agent` 支持 `abortSignal`（主 agent、甚至 memory recall selector 都传了），唯独这两个后台子代理没传。后果链：用户 Ctrl+C 中止主对话或退出后，(a) 提取子代理最多 5 轮、consolidation 最多 15 轮的 LLM 调用继续跑完（网络 I/O 持有事件循环，进程延迟退出或被迫 kill）；(b) 用户中止的往往正是「这轮对话有毒」的场景，记忆提取仍会把该轮摘要落盘为持久记忆；(c) 若进程被强杀在 WriteFile 中途，留下部分写入文件（与 C44 叠加）。remote server 端 `abort()`（`server.ts:636-640`）同样只中止主 agent，不触及后台记忆任务。
- **交叉验证**：grep 两文件无任何 `abortSignal`/`AbortController` 引用；无测试覆盖「中止后后台记忆任务停止」。recall 路径传 signal 而 extract/consolidate 不传，说明是遗漏。
- **定性**：**真实缺陷**（生命周期缺口：成本 + 中止语义违背 + 与 C44 数据损坏联动）。
- **修复建议**：为两个后台子代理注入与主 loop 联动的 `AbortController.signal`；宿主中止/退出时 abort。

### C46【中低危｜权限模型盲区】`MemoryPermissionChecker.check` override 完全绕开用户 `permissions.yaml` 规则引擎——显式 deny 规则管不住后台记忆写入

- **位置**：`src/memory/permissions.ts:19-49`（`override check(...)` 从头到尾不调用 `super.check()`、不触碰 `ruleEngine`）；对照 `src/permissions/index.ts:607-621`（基类 Layer 1 规则先行）、`:311` 附近注释（deny 规则「不可被覆盖」）。
- **机制**：基类 `PermissionChecker.check` 第一层即用户配置的 `permissions.yaml`（全局 + 项目级）。`MemoryPermissionChecker` 构造函数经 `super(memoryCwd,"default")` 照常创建了 `RuleEngine`，但 override **完全不查它**——用户写 `- rule: "WriteFile(*)" effect: deny` 做全面禁写，后台提取/consolidation 子代理照样写 memory 目录。同理 `plan` 模式（「Plan mode forbids mutations」）对后台记忆写入无效。
- **交叉验证**：`tests/permissions.test.ts:634-637` 注释「mode is already "default" and its check() override never reads mode, so this assignment is a no-op」表明**模式被忽略是测试作者知情的**（半个设计意图）；但**规则引擎被绕过**在测试、注释、四份既有报告中均无讨论——pi/yukino 报告都把它当作纯正面防护记录（写入限死在两个 memory 目录的 .md 内）。
- **定性**：**真实缺陷（规则绕过部分）+ 设计意图（mode 忽略部分）**。泄漏面有限（仅 memory 目录 .md），但「用户控制平面对后台写入存在盲区」成立。
- **修复建议**：override 在返回 allow 前先过一遍用户规则引擎的 deny 判定（deny 不可覆盖）；或在文档明示「后台记忆写入不受 permissions.yaml / plan 模式约束」。

### C47【低危｜安全/提示注入】`drainLeaderMailbox` 把未转义的 `msg.text`/`msg.from` 直接插进 `<task-notification>` XML 交给 leader 模型

- **位置**：`src/teams/index.ts:991-1016`（`lines.push(\`<task-notification team="${team.name}">\`)`…`lines.push(\`from=${msg.from}${metadata ? … : ""}: ${msg.text}\`)`…`lines.push("</task-notification>")`）。
- **机制**：teammate 发来的 `msg.text` 与 `msg.from` 均模型可控且**未做 XML 转义**，直接拼进交付给 leader 模型的 `<task-notification>` 结构。teammate（或被提示注入的 teammate）可在 text 中放 `</task-notification>` 提前闭合标签，再注入任意伪造指令到 leader 上下文。对照：`src/skills/catalog.ts:281-286` 的 `escapeSkillXml` 已为技能注入做了 `&<>` 转义，此处未复用。`Team.sendMessage`（`index.ts:696`）仅用 `SHUTDOWN_PREFIX` 守卫 uiState 显示，**仍原样投递** content。
- **交叉验证**：`escapeSkillXml` 证明项目具备 XML 转义能力却未在此路径复用；无测试覆盖「teammate 文本含 XML 标签」。
- **定性**：**真实缺陷**（提示注入面；低危——需 leader 模型被诱导执行注入指令，且团队多为半可信协作场景）。
- **修复建议**：`drainLeaderMailbox` 对 `msg.text`/`msg.from` 复用 `escapeSkillXml` 或等价转义；或改用不依赖 XML 边界的结构化交付。

### C48【低危｜功能·config-gated】`computeCompactThreshold` 无下界钳制——用户配置较小 `context_window` 时阈值转负，导致每轮强制压缩且熔断器永久失效

- **位置**：`src/compact/compact.ts:69-79`（`computeCompactThreshold` 返回 `effective - margin`，**无 `Math.max(0, …)` 之类下界**）；`:62-64`（`SUMMARY_OUTPUT_RESERVE=20000`、`AUTO_COMPACT_SAFETY_MARGIN=13000`、`MANUAL_COMPACT_SAFETY_MARGIN=3000`）；`:325-342`（`manageContext`：`autoThreshold`/`hardBlock`/`forced = tokens >= hardBlock`/熔断器 `!forced && consecutiveFailures>=MAX_CONSECUTIVE_FAILURES`）；`src/config/provider-config.ts:242-247`（`getContextWindow` 接受任意 `>0` 安全整数）、`:255-262`（`getMaxOutputTokens = min(configured, contextWindow)`）。
- **机制**：设用户配 `context_window = 8000`（合法）。`getMaxOutputTokens = min(128000, 8000) = 8000` → `effective = 8000 - min(8000,20000) = 0` → `autoThreshold = 0 - 13000 = -13000`、`hardBlock = 0 - 3000 = -3000`。因 `tokens ≥ 0 > autoThreshold` 恒成立，`manageContext` 每轮都越过 `:328` 的早退；又 `forced = tokens >= -3000` **恒为 true** → `:334-342` 的熔断器分支（`!forced && …`）永不进入 → **`doCompact` 每轮都跑**（越过 `MIN_COMPACT_PREFIX=2` 后）。`doCompact` 在可保留消息过少时返回「Compaction skipped」（`:628` 附近 `keepStart` 检查），净效果是每轮浪费一次摘要往返或空跳过，且**连续失败熔断保护被彻底禁用**。阈值转负的触发面比直觉更宽：凡 `context_window < ~33000` 即可使 `autoThreshold` 转负（默认 `maxOutput=128000` 时 `min(maxOutput,20000)=20000`），`< 23000` 使 `hardBlock` 转负。
- **交叉验证**：默认 `context_window=1_000_000`（`provider-config.ts:94`），故默认配置不触发；需用户显式配小窗口（本地/小模型网关场景常见）。无测试覆盖小窗口阈值。
- **定性**：**真实缺陷**（config-gated，低危：非默认触发，但一旦触发导致每轮强制压缩 + 熔断失效）。
- **修复建议**：`computeCompactThreshold` 对结果做 `Math.max(某正下界, …)` 钳制；或 `manageContext` 在 `autoThreshold <= 0` 时直接跳过自动压缩并告警「context_window 配置过小」。

### C49【低危｜健壮性】`canonicalPath` 对非 ENOENT/ENOTDIR 错误（含 ELOOP 符号链接环）re-throw，`PathSandbox.check` 无 try/catch，`run()` catch 再 re-throw——符号链接环令整个写工具轮抛异常而非返回受控工具错误

- **位置**：`src/utils/paths.ts:24-46`（`canonicalPath` 的 catch 仅吞 `ENOENT`/`ENOTDIR`，其余 `throw error` — 含 ELOOP）；`src/permissions/index.ts:213-224`（`PathSandbox.check` 调 `canonicalPath(resolveToolPath(...))`，**无 try/catch**）、`:702-703`（Layer 4：write 类工具 + filePath 触发 `this.sandbox.check(filePath)`）；`src/agent/index.ts:1325-1327`（`this.checker.check(...)` 无本地 try/catch）、`:1090-1092`（`run()` 的 catch **`throw error` 再抛**）。
- **机制**：模型经 Bash 造出符号链接环（`ln -s a b; ln -s b a`）或工作区本就含环，随后对该路径调用 WriteFile/EditFile（category=write）→ Layer 4 `PathSandbox.check` → `canonicalPath` 命中 ELOOP → re-throw → 冒泡穿过 `checker.check`（无 catch）→ `run()` 的 catch（`:1090`）**再抛** → 未被转成 `tool_result` 错误事件，整个 agent 轮以异常终止。在 TUI（`app.tsx:2554/2557` try/catch）与 print-mode（loop 在 try 内）中被上层捕获并显示为错误消息，不致进程崩溃，但该轮已 yield 的 tool_use 丢失配对的 tool_result（下轮靠 `ensureToolPairing` 兜底），且**任何**指向该环路径的写操作都持续失败——不是一次性抖动。
- **交叉验证**：`canonicalPath` 的注释只声明处理「final file or some parent directories do not exist yet」（ENOENT/ENOTDIR），未考虑 ELOOP/EACCES 等；无测试覆盖符号链接环下的权限检查。
- **定性**：**真实缺陷**（健壮性：受控工具错误退化为轮级异常；低危——上层有 try/catch 兜底，不崩进程，但破坏单轮语义与工具配对）。
- **修复建议**：`PathSandbox.check` 对 `canonicalPath` 包 try/catch，捕获后返回 `deny`（保守拒绝）而非抛出；或 `canonicalPath` 对 ELOOP 等返回原始 resolve 路径 + 记 warn。

## 二、疑似·待验证（机制成立，触发概率/影响面小，如实标注）

### C50【极低危｜健壮性·疑似】`teams/file-lock.ts` 陈旧票据回收依赖进程存活探测，PID 复用可致票据永不回收 → 该锁永久 DoS

- **位置**：`src/teams/file-lock.ts:15`（`LOCK_STALE_MS=10_000`）、`:56`（`isProcessAlive` 用 `process.kill(pid,0)`，EPERM 亦返回 true）、`:123-127`（陈旧清理 `if (now - info.mtimeMs > LOCK_STALE_MS && (ownerPid === null || !isProcessAlive(ownerPid))) unlinkSync(entryPath);`）。
- **机制**：bakery 锁的「陈旧条目回收」仅在**属主进程已死**时触发。若持票进程崩溃后其 PID 被系统**复用**给另一无关存活进程，`isProcessAlive(ownerPid)` 因 `process.kill(pid,0)` 成功（或 EPERM）返回 true → 陈旧票据被误判为「仍活跃」→ 永不回收 → 该 mailbox 文件锁永久无法获取（DoS）。
- **交叉验证**：codex 报告（`:117`）与 pi 报告（`:181`）均复核了 bakery 算法并把「陈旧条目仅在属主进程死亡时回收」列为**优点**，未考虑 PID 复用边角；`LOCK_ACQUIRE_TIMEOUT_MS=5_000` 使获取方 5s 超时抛错而非无限阻塞（部分缓解）。触发需「崩溃 + PID 精确复用 + 10s 窗口内」三者叠加，概率极低。
- **定性**：**疑似·极低危**（机制真实，触发需 PID 复用碰撞，且超时抛错限制了影响面为「该锁不可用」而非「进程挂死」）。
- **修复建议**：票据文件记录属主进程的启动时间（`ps -o lstart` 或 `/proc/<pid>/stat` starttime）做二次校验，PID 相同但启动时间不同即判死；或用带 TTL 的租约文件（属主定期续约，过期即回收）。

## 三、设计意图（本轮复核确认为非缺陷，列出以便复核）

- **三-1（设计意图）`tool_reference` 直通 Anthropic（`anthropic.ts:200`）**：`buildAnthropicMessages` 对 tool_result 的 `contentBlocks` 原样透传（含 `tool_reference`），不经 `userBlocksFor` 的拒绝分支。这是 **native deferred-loading（`defer_loading`/`tool_reference`）beta 路径**：仅当 `registry.mcpLoadingMode === "native"` 时由 `ToolSearch`（`tool-search.ts:110-116`）产出 `tool_reference` 块，且 `anthropic.ts:322-324` 注释明确「This field is only accepted with the beta header」，`stream()` 相应地带 `NATIVE_TOOL_USE_BETA`（`:324/394`）。`userBlocksFor`（`:132-148`）拒绝 `tool_reference` 是因为**用户消息**不该含该块，与 tool_result 直通不矛盾。**设计意图，非缺陷。**
- **三-2（设计意图）skill 目录「项目覆盖全局」优先级（`catalog.ts:96-102`）**：`skillDirPaths()` 顺序为 `~/.agents/skills` → `~/.yukino/skills` → 项目 `.agents/skills`，`loadSkill` 用 `entries.set(name,…)` 后者覆盖前者 → **项目级覆盖全局**。这与 README:51（「in increasing priority」）、README:176（「Later entries override earlier names」）一致，并被 `tests/skills.test.ts:527`（「preserving project-over-user precedence」）、`:581`（「retains source precedence」）测试锁定。**设计意图，非缺陷。**（第一轮代理曾疑此为「克隆仓库可覆盖用户技能」的供应链面，但技能体本身仍受宿主工具权限约束、且 README 明示优先级，故不构成缺陷；技能**安装**路径的 SSRF/符号链接加固另见 pi/codex 报告的正面结论。）
- **三-3（印证既有，非本轮新增）subagent worktree × OS 沙箱 allowWrite**：分区代理提出「worktree 隔离的子代理 Bash 写入在 sandbox 下失败」。本人复核：worktree 建于 `yukinoPath("worktrees", projectKey(root), slug)`（`worktree/index.ts:306`）即 `~/.yukino/worktrees/…`，确在 `BashTool.sandboxConfig.allowWrite = [cwd, tmpdir()]`（`bootstrap/sandbox.ts:22-23`）之外。**但**：(a) codex N2:203 已确认**子代理 worktree 路径是正确的**——`agent-tool.ts` 经 `forSubagent(wt.path)`→`forCwd(wt.path)`→`new PathSandbox(wt.path)` 把权限沙箱根设到 worktree；(b) 真正的缺陷面是**交互式 `EnterWorktree` 工具作用于主 agent** 时既不切换 `ctx.cwd`（`enter-worktree.ts:67-69` 仅返回路径字符串）也不把 worktree 加进 `allowWrite`/`allowedRoots`——此即 **pi P4** 与 **codex N2** 已完整覆盖的缺陷（含 `allowExtraRoot`/`PathSandbox.addRoot` 全库无生产调用方的死代码佐证）。**本轮不重复计数，印证 pi P4 / codex N2 成立。**

## 四、本轮结论与建议优先级

| 编号 | 结论                                                                                                             | 严重度             | 定性                               | 建议优先级                                                                                 | 与既有报告关系                              |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| C40  | teammate 可绕过 leader 独占权关停同级（`waitForNextPromptOrShutdown` 无 from 校验 + SendMessage 无 leader 门禁） | 中低               | 真实缺陷                           | **P1**（两处对齐 `runPlanApproval` 的 `from===LEADER_NAME` + shutdown 分支加 leader 门禁） | **新发现**（团队特权模型不一致）            |
| C41  | consolidation「Phase 2」transcript 检索被自身权限沙箱全 deny，取证阶段静默死路径                                 | 中                 | 真实缺陷                           | **P1**（sessions 目录加入只读根，或删 prompt 指示改预注入摘要）                            | **新发现**                                  |
| C42  | remote 每 loop `new MemoryExtractor` 破坏 coalescing，新建记忆文件并发覆盖丢数据                                 | 中高               | 真实缺陷                           | **P1**（复用单实例 + 守卫 + 游标，对齐 app.tsx）                                           | **新发现**（remote 分区 → 本人复核确证）    |
| C43  | Glob 绝对 pattern 绕过 memory 读作用域，可枚举任意绝对路径                                                       | 中                 | 真实缺陷                           | **P1**（checker 校验 pattern，或 memory 子代理拒绝绝对 pattern）                           | **新发现**（本机实验确证）                  |
| C44  | extractor 回退写盘非原子/无锁/无存在检查，崩溃损坏 + 同名静默覆盖                                                | 中                 | 真实缺陷                           | **P1**（复用 writeIndex 的 lock+tmp+rename + existsSync 闸门）                             | **新发现**                                  |
| C45  | 后台 extractor/consolidator 子代理无 abortSignal，中止后仍烧 token 并写记忆                                      | 中低               | 真实缺陷                           | P2（注入联动 AbortController.signal）                                                      | **新发现**                                  |
| C46  | `MemoryPermissionChecker.check` 绕开用户 permissions.yaml 规则引擎                                               | 中低               | 真实缺陷（规则）+ 设计意图（mode） | P2（allow 前过 deny 规则，或文档明示盲区）                                                 | **新发现**                                  |
| C47  | `drainLeaderMailbox` 未转义 text/from 插入 `<task-notification>` XML                                             | 低                 | 真实缺陷                           | P2（复用 `escapeSkillXml`）                                                                | **新发现**                                  |
| C48  | `computeCompactThreshold` 无下界钳制，小窗口阈值转负 → 每轮强制压缩 + 熔断失效                                   | 低（config-gated） | 真实缺陷                           | P2（下界钳制 / autoThreshold≤0 跳过并告警）                                                | **新发现**                                  |
| C49  | `canonicalPath` 对 ELOOP re-throw，符号链接环令写工具轮抛异常（非受控工具错误）                                  | 低                 | 真实缺陷                           | P3（`PathSandbox.check` 包 try/catch 保守 deny）                                           | **新发现**                                  |
| C50  | file-lock 陈旧票据回收依赖 PID 存活，PID 复用致锁永久 DoS                                                        | 极低               | 疑似·待验证                        | P3（票据记进程启动时间二次校验 / TTL 租约）                                                | **新发现**（codex/pi 复核 bakery 时未虑及） |
| 三-1 | `tool_reference` 直通 Anthropic                                                                                  | —                  | 设计意图                           | native deferred-loading beta 路径                                                          | 印证（非缺陷）                              |
| 三-2 | skill 项目覆盖全局优先级                                                                                         | —                  | 设计意图                           | README+测试锁定                                                                            | 印证（非缺陷）                              |
| 三-3 | subagent worktree × sandbox allowWrite                                                                           | —                  | 印证既有                           | 见 pi P4 / codex N2                                                                        | **不重复计数**                              |

### 本轮核心增量（相对第一轮 C1–C39 与 codex/pi/yukino 三份报告）

1. **memory 分区是本轮真实缺陷最密集处（C41–C46 共 6 条）**：根因高度一致——**后台记忆子系统（extractor/consolidator/MemoryPermissionChecker）自成一套沙箱与生命周期，却与主系统既有的正确范式脱节**：C41（prompt 指示的能力被自家 checker 封死）、C42（server 未复用 app.tsx 已验证的 coalescing 单例范式）、C43（checker 漏检 Glob pattern 通道）、C44（回退写盘未复用 manager.ts 已验证的 lock+tmp+rename）、C45（后台子代理漏接 abortSignal，而 recall selector 已接）、C46（override 绕开基类规则引擎）。其中 **C42（数据丢失竞态）与 C44（数据损坏/覆盖）危害最直接，C41/C43 是「设计了能力却被自身安全边界废掉」的两类镜像**（一个太严一个太松）。
2. **C40（团队关停特权绕过）** 揭示 teams 特权模型的**路径不一致**：`runPlanApproval` 已用 `from===LEADER_NAME` 收紧、`TaskStop` 有 leader 门禁、`SendMessage` 的 plan_approval_response 有 leader 门禁，唯独 `waitForNextPromptOrShutdown` + `SendMessage` 的 shutdown 分支两处漏配，使 teammate 可关停同级。属「同一意图在部分路径已正确实现、此处遗漏」的一致性缺陷。
3. **C48/C49** 是两条「防御边界缺一个钳制/兜底」的健壮性缺陷：C48 的 `computeCompactThreshold` 缺下界钳制（小窗口配置下阈值转负、熔断器被 `forced` 恒真短路），C49 的 `canonicalPath` 只吞 ENOENT/ENOTDIR 却 re-throw ELOOP（符号链接环令写工具轮抛异常穿透 `run()` 的 re-throw catch）。两者机制均由代码事实确证，触发面分别受「用户配小 context_window」与「工作区含符号链接环」限定，如实定为低危。
4. **C50** 为唯一疑似项：codex/pi 两轮均复核了 bakery 文件锁并把「死进程回收」列为优点，本人补充其未虑及的 **PID 复用**边角（陈旧票据可能被误判活跃而永不回收）；因需精确 PID 碰撞且 5s 获取超时限制了影响面，如实降为「疑似·极低危」，不作夸大定性。
5. **误报剔除（宁可少报）**：分区代理另提的 `tool_reference` 直通（三-1）、skill 项目覆盖优先级（三-2）经注释/README/测试三方对照判定为**设计意图**；subagent worktree × sandbox（三-3）经 codex N2:203 确认子代理路径本就正确、真正缺陷面已被 **pi P4 / codex N2** 完整覆盖，**本轮不重复计数**。memory 分区代理报告的第 9 条（consolidation 失败无退避/上限）经复核为「pi 已定性重试为优点 + 缺成本边界」，与 C45 的生命周期缺口部分重叠，按「宁可少报」未单列。

> 第二轮验证环境：macOS、Node v24.16.0。C43 的 Glob 绝对 pattern 绕过经本机 node 实验确证（`globIterate('/etc/hosts*', {cwd:'/tmp', …})` 返回 `/etc/hosts` 系，实验为只读枚举、无写入、无残留）；其余各条均以 file:line 代码事实复核（含 `tests/skills.test.ts`、`tests/memory.test.ts`、`tests/permissions.test.ts`、README、`escapeSkillXml`/`writeIndex`/`app.tsx` 正确范式对照）。本轮为**只读审计**，未改动任何源码；仅向本报告文件追加第二轮内容。
