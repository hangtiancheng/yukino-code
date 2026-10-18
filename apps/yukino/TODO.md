# Yukino 缺陷修复计划

> 本周期仅制作计划，**不实施源码修复**。所有修复项均未开始，复核完成不代表修复完成。

## 1. 基线与裁定规则

- 核验日期：2026-10-18；源码基线：当前工作区 `9f13953`。这里的“最新”指本地当前源码，未拉取或假设远端有更新。
- 输入：[claude](defects-reported-by-claude.md)、[codex](defects-reported-by-codex.md)、[pi](defects-reported-by-pi.md)、[yukino](defects-reported-by-yukino.md) 四份完整报告，包括追加轮次。
- 优先依据：当前生产调用链、声明的权限边界、README、实际依赖源码、现有测试；报告的结论和“已实测”不是本计划自动接受的事实。
- **真实缺陷**：当前实现违反可识别的行为契约、安全边界或资源/数据一致性要求。潜伏的公开库 API 缺陷与当前应用故障分别标注。
- **设计意图**：有明确策略，或报告将受支持的行为/取舍误当缺陷。设计可以调整，但本计划不以修复名义改产品策略。
- **不成立 / 未确证**：报告的触发链被源码反证，或缺乏可达性/协议证据。明确不计入真实缺陷，也不伪称已证明是设计意图；不进入实施队列。
- 混合结论必须拆开：例如“支持绝对路径 include”是设计意图，“项目来源可在未获授权时读取用户机密”是安全缺陷。
- 分类使用：安全性、隐私保护、功能正确性、并发与数据完整性、生命周期与可靠性、性能与资源、协议与打包、交互、诊断与文档、测试稳定性；一项可以有多个分类。
- **P0**：自动加载不可信项目即可执行代码/读取用户秘密，或可直接绕过显式禁止规则；优先阻断暴露路径。
- **P1**：可稳定触发的权限扩大、数据泄漏/损坏、会话串扰、关键交互悬挂、审查结果失真、核心功能组合失效。
- **P2**：影响较小、条件受限的正确性/资源/交互/诊断问题；不因修复行数少而升级。

### 本周期实际验证

- 当前 `permissions`、`feedback-redact`、`memory`、`follow-up-queue`、`lsp` 五份现有测试：**5 个文件、124 个测试通过**。这是基线检查，不能证明报告中的缺口不存在。
- 对当前函数执行合成数据探针：Bearer 和 Basic 认证头均出现“只删认证类型、保留凭据”；`isSensitiveKey("db.password")` 为 false；`intArg(-0.5)` 为 -1，而字符串 `"-0.5"` 为 0。
- 独立子进程中，`/(a+)+$/iu` 对 30 个 `a` 加 `!` 的匹配超过 1 秒，被外部超时终止。结合 Grep 的同步 `regex.test`，确认事件循环阻塞机制。
- 临时 Git 仓库按 `b→c`、`a→b` 改名，使用当前 `git diff --find-renames HEAD`，得到 `D a / M b / A c`，未得到报告假设的两条 rename。该夹具不足以证明所有 Git 版本/变更集均不可产生键碰撞，因此 C27 保留为未确证，不按已知故障修复。
- 未调用真实模型、未提交反馈、未连接项目 MCP；未进行 Linux bwrap、Windows 截屏或真实终端专项实测。未将四份报告的历史全量测试结果冒充本周期结果。

## 2. 需要先纠正的报告结论

| 原报告                                                                   | 明确裁定                                     | 当前源码事实与计划影响                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yukino M-1 中“危险模式为空即缺陷”                                        | **设计意图**                                 | `permissions/index.ts` 明写 intentionally empty。只修显式规则绕过，不擅自新增危险命令黑名单。                                                                                                                               |
| yukino M-2 / pi P17；其余报告 A2A 说明                                   | **设计意图**                                 | `a2a/server.ts` 主动选择 `UserBuilder.noAuthentication`，并限制 loopback；README 声明 loopback 服务。新增 token 属安全策略变更，不混入现有缺陷修复。                                                                        |
| codex N6 与 pi 对 include 的相反裁定                                     | **混合：语法是设计，项目来源越界是安全缺陷** | `memory/instructions.ts` 明确支持绝对路径和 `~/`，但全局用户文件与仓库文件走同一无限制展开路径。SEC-06 仅建立来源边界。                                                                                                     |
| pi P11“取消的 blocker 永久卡死且无法解除”                                | **设计意图；永久卡死的结论不成立**           | `todo/dependencies.ts` 要求 blocker completed；取消不等于交付依赖成果。`todo/index.ts.delete` 与 `teams/shared-task.ts.delete` 均删除双向依赖，TaskUpdate 暴露 deleted，也能重新打开任务。不自动把 cancelled 当 completed。 |
| pi P12“标点紧邻 @ 引用即缺陷”                                            | **设计意图**                                 | `collectAtRefs` 定义空白分词，支持引号；逗号、括号也可能是合法文件名。不可无条件剥离标点而改变字面路径。                                                                                                                    |
| claude C8“失败项永久毒化且没有移除手段”                                  | **设计意图；永久不可恢复的结论不成立**       | 失败重排和新 enqueue 触发重试有明确注释；`takeLast` 可以逐项召回，先取队尾再取失败项即可移除。直接删除失败队首可另做 UX 功能，不自动丢用户输入。会话切换不清队列另属 LIFE-03。                                              |
| codex D5.4 / pi P9：普通 session_end hook 失败覆盖结果                   | **未确证，不列真实缺陷**                     | `Agent.run` 的 finally 确会传播异常，但 `HookEngine.fire` 已捕获 action 失败并按 on_error 转成 HookResult。报告未证明普通配置能沿该链抛出；不能只看 finally 就认定可达。                                                    |
| claude C19：Glob 没返回“全局最新 1000 个”                                | **设计意图**                                 | `glob.ts` 有遍历/字节上限并提示截断，随后排序所返回的子集；描述承诺返回路径按 mtime 排序，没有承诺全局 top-K。不为该解读改成全盘扫描。                                                                                      |
| claude C10 / pi P29：历史召回首行末尾                                    | **设计意图，未证违反契约**                   | 两条召回路径的光标约定确有不同，但可见光标与实际插入位置一致，没有丢文本，也没有“历史必须落在末行”的现行约定。统一位置属于交互调整。                                                                                        |
| yukino M-3“大粘贴 O(n²)”                                                 | **真实性能缺陷，但复杂度指控不成立**         | 当前逐字符循环同步占用主线程；不能由 `slice(1)` 推断 V8 每次复制剩余字符串。UI-05 以阻塞时长和分块处理验收。                                                                                                                |
| yukino L-1 / pi P25：WriteFile 门禁失败留下空目录                        | **报告所述触发链不成立**                     | 第一道门禁在 mkdir 前；若第二道因文件已存在而拒绝，其父目录也必已存在。取消发生在 mkdir 后可能留下目录是非事务写入的副作用，不等于“拒绝已有文件时新建空父目录”。                                                            |
| yukino L-9：@ 展开异常使 UI 与上下文分歧                                 | **不成立**                                   | `expandAtRefsWithImages` 对各引用的读取/图片加载异常就地捕获，保留字面引用；未找到报告所需的常规向外 reject 路径。                                                                                                          |
| yukino L-10：goal 不计 compact token                                     | **设计意图**                                 | README goal 节明确排除 delegated agents、memory selection、compaction summaries；不擅自修改预算口径。                                                                                                                       |
| yukino L-11：同步文件锁阻塞事件循环                                      | **设计意图**                                 | `teams/file-lock.ts` 是同步 API，使用 Atomics.wait，有 5 秒获取上限。改异步架构不是本次已证缺陷；临时文件竞态与 PID 身份问题分别列 LIFE-16 / RES-05。                                                                       |
| claude C22：ACP 显示完整 transcript，与 compact 后上下文不同             | **设计意图**                                 | `acp/conversion.ts.historyNotifications` 重放用户可见历史；runtime `rebuildFromSession` 重建模型上下文。展示历史与模型上下文不必相等，不能以此删除客户端历史。                                                              |
| claude C24：forCwd 共享规则引擎                                          | **设计意图**                                 | 当前用于同项目 worktree/派生代理，README 声明 remembered patterns 对项目内代理共享；不能改为子目录独立规则而破坏父授权继承。                                                                                                |
| claude C35.4：server.close 等空闲 HTTP 连接，必须先 closeIdleConnections | **当前支持版本下该理由不成立**               | package.json 要求 Node ≥20；不能套用早期 Node 的空闲连接行为认定挂死。活动连接/WS 关闭另需独立复现，不据此追加版本兼容分支。                                                                                                |
| claude C39.2：sharp 无像素上限                                           | **不成立**                                   | 已安装 sharp 的 `node_modules/sharp/src/common.h` 设置 `limitInputPixels = 0x3FFF * 0x3FFF`。可以选择更低产品上限，但“无上限”不能当当前缺陷事实。                                                                           |
| yukino S-3：LSP Math.min 应为 Math.max                                   | **设计意图**                                 | diagnostics 至多等 2 秒，未就绪返回 pending；改 Math.max 会破坏此协议。                                                                                                                                                     |
| yukino S-5：静态文件前缀检查可路径穿越                                   | **未确证，不列真实缺陷**                     | 当前 normalize、清理前导 traversal、join 的组合未证明可生成所需兄弟目录路径。不能仅凭 startsWith 缺分隔符宣布可利用。                                                                                                       |
| yukino S-6：图片 JSON 解析前没有独立 32MB 门禁                           | **设计意图/有界取舍**                        | WS maxPayload 先限制帧，解码后再检查图片大小。报告未证明可突破现行传输上限；不能把先解析直接写成无界内存问题。                                                                                                              |
| yukino S-7：全量重绘末行残留                                             | **未确证，不列真实缺陷**                     | `terminal-output.ts` 调用方有 eraseFrame/eraseDown/eraseLines；仅查看 renderLiveFrame 的末行不能证明残影。须提供完整输出序列或终端夹具。                                                                                    |
| yukino S-8：clamp 能进入 paste 标记内部                                  | **不成立**                                   | `inputBoundary` 对标记内部 index 的第二个分支未限定 previous，因此 clamp 也返回标记起点。                                                                                                                                   |
| yukino S-9：高频输出反复 wrap 50KB                                       | **设计意图，未证性能故障**                   | 尾部渲染有固定大小预算；没有本周期延迟证据，不将合理的有限工作量本身当缺陷。                                                                                                                                                |
| claude C13：裸 base64 必然 400                                           | **该断言未确证**                             | 当前 SDK 的 file_data 类型/注释只声明 string/base64，不能据源码证明服务端一律要求 data URI。已证的 document URL 静默丢弃另列 LLM-05；不凭图片与文件编码不同就判协议失败。                                                   |
| yukino F-13：跨模型 thinking 签名必然 400                                | **未确证，不列真实缺陷**                     | 能证实无来源信息、会重放旧 thinking，尚未证明服务端对所有跨模型/端点组合都拒绝；OpenAI 思考文本也不等于 Anthropic 签名块。保留同模型合法签名，不先做破坏性清洗。                                                            |
| claude C27：rename 链必然覆盖 diffByPath                                 | **未确证，不列真实缺陷**                     | Map 双键覆盖机制存在，但报告没有给出当前 collectDiffs 的真实 Git 输出；本周期上述夹具未复现。若能给出合法变更集，需区分 old/new 命名空间后再立项。                                                                          |
| claude C39.3：connect 后设置 onclose 存在可利用微任务窗口                | **未确证，不列真实缺陷**                     | `await client.connect` 后的赋值很近，报告没有证明具体 SDK/event-loop 时序可漏回调。正常连接期间断连会拒绝初始化，不先按假设改 lifecycle。                                                                                   |

## 3. 实施顺序与完成门槛（供后续周期）

合并后共有 **77 项修复 TODO：P0 3 项、P1 33 项、P2 41 项**；设计意图与未确证结论不计入这些修复项。

1. **批次 A / P0：** SEC-01、SEC-05、SEC-06，先建立可重复、不会访问真实机密/执行仓库命令的反例，再收敛权限与来源边界。
2. **批次 B / P1：** SEC-02～04、07～13；LIFE-01～08、11～14；REV-01～03；LLM-01～03；PKG-01、WORK-01、TOOL-02、TOOL-12、UI-01。按模块拆成可独立审查的改动，不一次重写所有宿主。
3. **批次 C / P2：** 其余条目。资源、交互与诊断分别交付，避免小修掩盖授权语义变化。
4. 依赖：SEC-03 先统一路径规则，再接 WORK-01 / SEC-10 / SEC-11；LIFE-01 的交互排队与 LIFE-05 的远程 pending 生命周期使用同一“每个请求独立完成”不变量；LIFE-12 配合 LIFE-13，单实例 coalescing 不能替代跨实例写盘防护；REV-01/02 先保证输入安全，REV-03 再保证报告完整性。
5. 每项只在**针对实际故障的回归用例通过、所有生产入口接线完成、README/过期注释同步**后勾选。多宿主问题至少核对 TUI、print、Remote、ACP、A2A 与派生代理适用路径。
6. 遵循 ZERO backward compatibility：直接采用正确契约，不增加旧 schema/旧权限行为回退或版本 shim。落盘安全策略的正常 chmod/fchmod 是权限执行，不是旧格式迁移。
7. 后续源码实施使用 `pnpm lint:fix` 修 ESLint error，忽略 warning；每批最终执行 `pnpm happy:fix`。本周期仅改 Markdown，不运行会全目录格式化/修写源码的 happy:fix，文档单独检查格式与引用。

## 4. 安全与隐私修复 TODO

### [ ] SEC-01 · 所有模式执行 shell 子命令的显式 deny/ask · P0

- **判定：真实缺陷；分类：安全性 / 权限规则绕过。** 来源：codex D1、pi P1、yukino M-1 的规则部分；证据：`src/permissions/index.ts` 的 globMatch、check Layer 1/3.5。
- 事实：整串锚定匹配遇换行失配；子命令规则只在 Bash sandbox auto-allow 分支运行，bypassPermissions 也能绕过用户 deny。
- 修复：将显式规则评估前移到共享路径，覆盖 Bash、PowerShell、全部 permission mode；deny 优先于 ask/allow。定义引号、转义、换行、分隔符、嵌套执行的处理；不能靠给正则加 dotAll 代替子命令检查，也不能把朴素 split 声称为完整 shell 解析。
- 验收：危险段位于首/中/尾，使用 LF/CRLF、`;`、`&&`、`||`、`|`、`&` 均不能绕过；引号内字面分隔符不误当命令；复杂语法无法安全分析时不靠普通前缀 allow 放行。沙箱开关和 bypass 均保留显式 deny/ask。

### [ ] SEC-02 · 收窄 remembered shell 规则与命令链授权 · P1

- **判定：真实缺陷；分类：安全性 / 持久授权范围。** 来源：codex D2/D5.1、pi P2、yukino M-1；证据：`PermissionChecker.allowAlways` 的前两词加 `*`。
- 修复：生成带词边界的命令族规则；一条已授权前缀不得覆盖后续任意管道、命令替换或命令链。与 SEC-01 共享分析结果；仅在各可执行段均获授权时使用规则 auto-allow。
- 验收：批准 `git push origin main` 后，`git pushfoo` 和 `git push … && curl … | sh` 不获得该规则授权；合法同族单命令按新契约工作；显式 deny/ask 始终优先。保留“命令族授权”设计，不退化为所有调用都只能逐次询问。

### [ ] SEC-03 · 统一文件规则的规范路径，并受控处理解析错误 · P1

- **判定：真实缺陷；分类：安全性 / 路径授权、功能正确性、可靠性。** 来源：yukino H-1/H-3、codex D4、pi P6/P14、claude C49；证据：`permissions/index.ts.extractContent/check/allowAlways`、`utils/paths.ts.canonicalPath`。
- 事实：规则对原始路径匹配，而路径沙箱/持久规则使用另一种表示；字面 `allowed/../../outside` 可命中 allow。文件目录族授权本身和显式 allow 授权工作区外路径均是现行设计。
- 修复：文件类规则创建与匹配共用 cwd/`~` 展开、canonicalization；定义带 glob 的规则如何规范化固定路径部分，不保留“匹配不上就试原始路径”的后门。ELOOP/EACCES 等返回受控拒绝或工具错误，不返回未解析原路径继续授权。
- 验收：相对/绝对/家目录/符号链接别名对同一文件决策一致；穿越和 symlink 逃逸不能扩大规则范围；用户明确配置的工作区外 allow 仍可生效；解析失败不杀整个工具轮且不漏配 tool_result。

### [ ] SEC-04 · 禁止空匹配内容隐式退化为全工具授权 · P1

- **判定：真实缺陷；分类：安全性 / 授权可见性与范围。** 来源：claude C1；证据：`CONTENT_FIELDS`、`allowAlways`；`ui/permission-dialog.tsx` 只展示“allow this pattern”，未展示将持久化的实际 `*`。
- 修复：建立各工具可记忆的授权目标，审批 UI 展示实际作用域；没有稳定目标的工具不支持 scoped remember，提供单次允许；若产品需要全工具授权，必须明确显示该范围，不能由空串自动推导。
- 验收：Agent、ExitWorktree、SendMessage 和动态 MCP 工具不再从空串生成未展示的 `Tool(*)`；McpCall 的 server/tool 标识使用完整目标，不截前两词再追加任意后缀；终端/浏览器/协议响应语义一致。

### [ ] SEC-05 · 项目 MCP 连接前建立来源信任门禁 · P0

- **判定：真实缺陷；分类：安全性 / 供应链、代码执行与凭据暴露。** 来源：codex N1、pi P16、yukino H-2；证据：`config/index.ts.withProjectMcpServers`、`mcp/client.ts.connect`、各宿主自动连接路径。
- 修复：保留配置来源，项目 `.mcp.json` 在获得该配置的明确授权前不 spawn、不连接网络服务器、不展开/发送环境凭据；信任记录绑定 canonical 项目与有效配置摘要，配置改变重新判定。非交互模式未授权时明确拒绝或跳过并诊断；bypass 工具权限不等于批准仓库启动配置。
- 验收：使用只会写临时 marker 的假 MCP，未批准时 marker 不出现；不读取真实环境秘密；批准只覆盖已展示配置，reload/修改后不会沿用旧授权；用户全局自配服务器仍遵循受信本地程序策略。覆盖 TUI/print/Remote/ACP/A2A/reload。

### [ ] SEC-06 · 项目 instructions/include 的读取边界 · P0

- **判定：真实缺陷；分类：安全性 / 供应链、秘密外传。** 来源：codex N6；与 pi 的“绝对 include 是设计”拆分处理；证据：`memory/instructions.ts.discoverInstructions/addSource/expandIncludes`。
- 修复：按来源授予读取根：受信用户全局 AGENTS 可保留用户明确的绝对/家目录 include；项目来源默认只能读取 canonical 项目范围，越界须来自用户侧明确配置授权。根 AGENTS 本身、嵌套 include 和 symlink 均校验，限深/环检测不能当权限边界。
- 验收：夹具中的仓库 AGENTS 无法内联仓库外假凭据、`~/` 假密钥、`../` 逃逸或 symlink 目标；项目内合法 include、代码围栏、转义、循环检测仍正常；未授权内容不进入任何宿主的模型请求。

### [ ] SEC-07 · 修复反馈认证头、URL 与敏感键脱敏 · P1

- **判定：真实缺陷；分类：隐私保护 / 凭据泄漏。** 来源：yukino F-1、claude C4/C36/C37；证据：`feedback/redact.ts` 的替换顺序、SENSITIVE_KEY、redactUrl catch。
- 修复：在一般键值替换破坏认证前缀前完整识别 Bearer/Basic；覆盖大小写、带引号/header 命令文本；点分命名空间参与敏感键边界；URL 解析失败时对明显 userinfo 保守脱敏，不原样透传。
- 验收：短/长 Bearer、Basic、JSON/JSONL、日志与 curl header；`db.password`/`spring.datasource.password`；非法端口 URL 均不保留合成秘密。断言最终 collect/issue/附件输出，而非只测某个中间正则；非敏感正文可读。

### [ ] SEC-08 · 遥测字符串复用凭据脱敏能力 · P1

- **判定：真实缺陷；分类：隐私保护。** 来源：claude C5；证据：`telemetry/privacy.ts.scrubTelemetryPayload` 只有 env 值、home、Bearer 处理，未处理任意 URL userinfo。
- 修复：对嵌套对象/数组的字符串和自由文本内 URL 做安全脱敏，复用无遥测依赖的通用能力；保留循环保护和 home 收敛，不记录被替换值。
- 验收：未知于 env 的 URL 用户名/密码、嵌套连接串、畸形 URL 不进入 exporter payload；遥测默认关闭这一设计保持。优先依赖 SEC-07 的已验证行为，避免复制另一套不一致规则。

### [ ] SEC-09 · 敏感本地状态使用私有文件和目录权限 · P1

- **判定：真实缺陷；分类：隐私保护 / 本机数据访问。** 来源：codex N5、pi P18、yukino M-6/F-5；证据：session/history/logger/recover/file-history/permissions 等写入没有 mode，storage 根无统一保护。
- 修复：统一落实敏感目录 0700、文件 0600，覆盖转录、历史、日志、崩溃、spill/备份、计划、任务/团队/邮箱、记忆、授权与临时重命名文件；原子替换前后权限一致，打开已有私有状态时也执行权限策略。不要 chmod 工作区源码或改变恢复源码的权限语义。
- 验收：POSIX umask 022 下实测新建/追加/重写/rename 后 mode；日志 fd 路径也覆盖；其他用户不能遍历私有根。Windows 另按支持的权限模型验证，不把 POSIX mode 测试当 ACL 结论；不向测试日志输出任何用户内容。

### [ ] SEC-10 · 关闭后台记忆 Glob pattern 越界通道 · P1

- **判定：真实缺陷；分类：安全性 / 受限读作用域。** 来源：claude C43；证据：`memory/permissions.ts` 只看 file_path/path，而 `tools/glob.ts` 接收绝对 pattern。
- 修复：记忆任务对搜索基目录与实际匹配目标共同限域；拒绝可逃逸的 absolute/`..`/组合 glob，校验结果目标，处理 symlink。**Grep.pattern 是内容正则，不能按路径规则误拦**；普通用户读工具的跨项目读取设计保持。
- 验收：memory 内 path 配合外部 absolute glob、相对逃逸、brace 变体无法枚举外部假文件名；合规 memory glob、consolidation 获准 transcript 搜索正常；ReadFile 仍不可越界读取正文。

### [ ] SEC-11 · 后台记忆任务尊重显式 deny/ask · P1

- **判定：真实缺陷（规则绕过）；忽略主会话模式是设计意图。分类：安全性 / 用户规则边界。** 来源：claude C46；证据：`MemoryPermissionChecker.check` 完全覆盖基类、不使用规则引擎。
- 修复：提取共享的显式规则决策，后台记忆的 scoped allow 不能覆盖用户 deny；无人审批的后台 ask 受控拒绝/跳过。不要直接用完整 super.check 的 default 矩阵取代 memory allow，也不把主会话 plan/bypass 强行套到独立后台任务。
- 验收：WriteFile/EditFile/ReadFile/Grep/Glob 的明确 deny/ask 在允许的 memory 根内也生效；无匹配用户规则时仍能完成合法自动记忆；规则 allow 不扩大 memory 根与 .md 写入限制。依赖 SEC-03/10。

### [ ] SEC-12 · teammate shutdown 的 leader 身份校验 · P1

- **判定：真实缺陷；分类：安全性 / 团队控制权限。** 来源：claude C40；证据：`teams/index.ts.waitForNextPromptOrShutdown` 与 runPlanApproval 的 sender 检查不同；`teams/tools.ts` 允许任意成员构造 shutdown_request。
- 修复：生产和消费两端都校验 leader 权限；普通文本的 `[shutdown]` 不得绕过结构化控制消息校验。清除不再需要的旧文本控制兼容路径，不保留旁路。
- 验收：A 无法通过 typed shutdown 或伪造前缀停 B；leader 正常停队友；等待计划审批与 idle 两条路径一致；合法消息仍按 requestId 关联答复。

### [ ] SEC-13 · ExitWorktree 使用运行时持有的归属与基线 · P1

- **判定：真实缺陷；分类：安全性 / 资源归属、数据完整性。** 来源：claude C18；证据：`tools/exit-worktree.ts` 信任模型提交的 path/branch/git_root/head_commit。
- 修复：由创建时的可信记录提供 worktree 归属、repo、branch、原始 head；工具只引用该记录，不接受模型重新声明清理基线。核对 canonical 路径与 Git 注册身份，默认保留非本运行所有的 worktree。
- 验收：项目内用户自建干净 worktree、其他 repo、伪造 branch/head 均不能被当作本代理 worktree 清理；修改过的 worktree保留；`git branch -d`、dirty/locked 拒绝等已有防线保留。不把有限删除风险夸大成任意递归删目录。

### [ ] SEC-14 · 可明确识别的自由文本秘密与短值过度脱敏 · P2

- **判定：真实缺陷（明确凭据载体与可用性）；无上下文任意字符串识别不是承诺。分类：隐私保护 / 功能正确性。** 来源：claude C39.1 的 PEM/curl -u/明确服务密钥格式部分、yukino F-10；证据：`feedback/redact.ts.TEXT_PATTERNS/secretValues/redactText`。
- 修复：补私钥块、明确认证参数、sk_live_ 等已识别的服务秘密格式；短配置值不再无条件全局 replaceAll，采用敏感键/认证位置脱敏。裸 JWT 可能是非机密数据，不能把所有缺少模式的字符串都宣称为已证安全缺陷。
- 验收：不在 env/config 中的合成私钥、curl 认证信息和服务密钥被遮罩；`token: "1"` 的敏感值受保护但普通行号/日期不全部损毁；记录短值自由文本识别的实际能力边界，不声称万能脱敏。

### [ ] SEC-15 · 引用数据不得破坏 review/团队通知的结构边界 · P2

- **判定：真实缺陷（结构完整性）；分类：安全性 / 上下文数据边界。** 来源：yukino F-8、claude C47；证据：`review/format.ts` 与 `teams/index.ts.drainLeaderMailbox` 将原文插入 XML 风格封装。
- 修复：统一处理属性与正文的转义/不可混淆封装，保留原始代码文本用于 diff 和定位；团队消息的来源由宿主生成，不接受正文闭合标签冒充来源。
- 验收：含 `</file>`、`</task-notification>`、引号和 `&` 的代码/消息仍是同一个引用数据块；定位文本无损。明确转义只修结构边界，不能宣称由此消除了模型提示注入。

### [ ] SEC-16 · @ 补全扫描不下降进入符号链接目录 · P2

- **判定：真实缺陷；分类：隐私保护 / 搜索范围、性能。** 来源：claude C3；证据：`utils/file-scan.ts` 用 statSync 判断目录，进入指向工作区外或循环的链接目录；TUI 和 Remote 补全共享此实现。
- 修复：扫描目录用 lstat/受控 realpath，不下降 symlink 目录；保留合理的文件链接候选政策，限制遍历工作量。普通 ReadFile 可访问项目外文件的设计不意味着补全应主动扫描外部目录。
- 验收：链接外部假目录、父目录循环、大目录链接不进入候选、不消耗全部候选预算；正常工作区补全顺序/上限正常；Remote 端返回相同范围的结果。

## 5. 会话、交互请求与后台生命周期 TODO

### [ ] LIFE-01 · 并行 AskUserQuestion 不覆盖 TUI resolver · P1

- **判定：真实缺陷；分类：功能正确性 / 生命周期与可靠性。** 来源：yukino F-11；证据：AskUserQuestion 为 read 可并行，`ui/app.tsx` 仅一个 askResolveRef，第二次赋值覆盖第一次。
- 修复：每个请求持有独立 resolver，TUI 串行呈现或工具按交互类别串行执行；取消/卸载必须结算所有在途和排队请求，不仅当前对话框。
- 验收：同一轮两个提问依次展示、各收一个结果；回答/取消/中断/退出均不遗留 Promise；覆盖主代理与共享交互入口，不能简单把所有 read 工具串行化。

### [ ] LIFE-02 · FeedbackDialog 单次提交门禁 · P1

- **判定：真实缺陷；分类：并发与数据完整性 / 交互。** 来源：yukino F-15；证据：`ui/feedback-dialog.tsx` Enter 直接 onSubmit，无同步提交标志。
- 修复：按键处理前同步认领提交槽，失败后的重试由明确状态管理；审批 resolver 按流水线绑定，不允许第二条流程覆盖第一条。
- 验收：同一事件批次双 Enter、长按、提交后重渲染最多启动一条流水线和一次审批；取消能完成全部等待；采用 fake uploader，不真实上传/发 issue。

### [ ] LIFE-03 · 会话切换清理 follow-up 与 steering 派生态 · P1

- **判定：真实缺陷；分类：功能正确性 / 会话隔离。** 来源：claude C7；证据：`ui/use-follow-up-queue.ts` 无 reset，`ui/app.tsx` clear/resume/rewind 未清队列。
- 修复：添加明确会话 generation/reset；成功 clear/resume/对话 rewind 清理 pending 和 steering 历史 marker，在途旧 dispatch 失败也不得重入新队列；纯 code rewind 是否保留待发消息按其未变更上下文的语义处理，不误删输入。
- 验收：旧会话排队消息不会向新/恢复/回滚会话自动发送；取消切换、resume 失败不丢当前有效队列；同文本 prompt 历史只记一次；失败重排的保留输入策略仍正常。

### [ ] LIFE-04 · TUI fire-and-forget 错误边界和 resume 输入诊断 · P1

- **判定：真实缺陷；分类：生命周期与可靠性 / 诊断。** 来源：codex N3、pi P15、yukino M-5；证据：`ui/app.tsx.handleSlashCommand` 的若干 void 调用与 `recover.ts` 的 unhandledRejection 退出策略。
- 修复：在 UI 操作入口集中接管异步异常，CLI 与交互 resume 使用一致 ID 校验；预期文件/配置错误转用户可见消息，失败后状态可再次操作，不降低全局未知崩溃处理能力。
- 验收：非法 ID、会话不可读/损坏、touch/存储失败显示诊断而非结束整个 TUI；启动 --resume 和对话内 /resume 均覆盖；未处理 rejection 计数为零。

### [ ] LIFE-05 · Remote pending 请求重放、广播结算与去重 · P1

- **判定：真实缺陷；分类：功能正确性 / 生命周期与可靠性。** 来源：claude C29、C35.1；证据：`remote/server.ts.setupWebSocket/createPermissionCallback/createAskUserCallback` 只存 resolver，不存可重放 payload；成功答复不广播关闭。
- 修复：pending 记录保存 ID/payload/类型/截止时间和完成状态；新连接重放；任一客户端回答后通知其余客户端关闭；超时、cancel、disconnect 与重复答复只能完成一次。
- 验收：F5、新标签、断线重连能看见原 permission/ask，不重启工具、不重置 10 分钟计时；A 回答后 B 关闭对应 modal；过期请求不复活；多个并发请求各自配对。

### [ ] LIFE-06 · Remote WS 消息处理统一异常边界 · P1

- **判定：真实缺陷；分类：生命周期与可靠性 / 服务可用性。** 来源：claude C34；证据：`setupWebSocket` void handleWsMessage，provider change/rewind/completion 等路径未统一 catch。
- 修复：在异步分发入口 catch，记录安全诊断并向适当客户端返回受控错误；各操作 finally 释放 streaming/控制器。不要把正常业务错误升级为 process.exit。
- 验收：provider 切换、rewind IO、completion scan 等注入异常后服务器继续接收下一条请求；前端解除忙碌态；不产生 unhandledRejection；/clear 本已有内层捕获，不用错误示例证明本条。

### [ ] LIFE-07 · Remote review 释放槽后按 FIFO 派发 follow-up · P1

- **判定：真实缺陷；分类：功能正确性 / 调度。** 来源：claude C30；证据：`handleCodeReviewStart` finally 只清 streaming，与其他运行出口不同。
- 修复：把 follow-up drain 纳入统一运行完成出口，明确成功/失败/取消时的派发政策；避免 finally 中第二个异常覆盖原 review 错误。
- 验收：review 中排队的普通文本和 slash/bash 在合法结束后自动按 FIFO 运行；新消息不能越过旧队列；用户取消后的消息行为与其他 agent 运行一致。

### [ ] LIFE-08 · Remote clear 停止旧 teammates · P1

- **判定：真实缺陷；分类：会话隔离 / 生命周期与可靠性。** 来源：claude C31；证据：Remote clear 仅 stopAll background tasks，TUI clear 同时 stop teams。
- 修复：换 session 前等待旧团队停止、清理旧通知与浏览器活动投影；停止失败不得伪装已完成隔离。
- 验收：clear 后旧 teammate 不继续执行/计费，不触发新会话通知轮；前端团队面板与运行态一致；私有 TODO/background store 的既有清理仍正常。

### [ ] LIFE-09 · 计划审批状态和定时器属于当前运行 · P2

- **判定：真实缺陷；分类：功能正确性 / 交互、生命周期。** 来源：claude C32/C33；证据：`runNotificationTurn` 未重置 exitPlanSucceeded，`cancelActiveRun` 未清 planApprovalTimer。
- 修复：各运行入口统一初始化计划完成状态；所有 cancel/结算路径一起销毁 pending 与 timer，回调按请求身份判断是否仍有效。
- 验收：过期计划不会因通知轮再次弹审批；cancel 后推进假时钟不再广播过期通知；新审批的 timer 不被旧回调取消。

### [ ] LIFE-10 · TUI 会话边界重置 FileStateCache · P2

- **判定：真实缺陷；分类：功能正确性 / 编辑前读取约束。** 来源：yukino G-2；证据：`ui/app.tsx` clear/resume/rewind 复用 fileStateCacheRef，而 Remote 的对称路径新建实例。
- 修复：在成功改变对话基线或回滚文件后重建缓存；不要把旧会话读过的文件当新会话已读；失败/取消切换不提前破坏当前状态。
- 验收：A 读文件→clear/resume B→未重读编辑被拒；rewind 后按当前文件重新读取；正确新建文件仍不要求先读。

### [ ] LIFE-11 · Remote 上下文重建时读取当前指令与记忆 · P1

- **判定：真实缺陷，但范围比 G-1 原文窄；分类：功能正确性 / 上下文。** 来源：yukino G-1；证据：Remote 持有 longTermMemoryInstructions/MemoryContent 启动快照；`ConversationManager.injectLongTermMemory` 以一次性标志控制注入。
- 修复：在新会话、resume、compact 后等需要重新注入时从当前 cwd/MemoryManager 取内容，消除 handle 级永不刷新的快照；不要每轮重写历史或破坏 prompt cache。
- 验收：修改项目指令/记忆后 clear、resume、compact 重建均使用当前内容，涵盖 Remote/ACP/A2A；`enable_memory=false` 保持禁用。**不承诺**终端现状每轮重新注入；“运行中热更新追加 delta”如需支持应单独定义产品需求。

### [ ] LIFE-12 · 复用 Remote MemoryExtractor 并绑定会话/模型生命周期 · P1

- **判定：真实缺陷；分类：并发与数据完整性 / 成本。** 来源：claude C42；证据：Remote 每次 onLoopComplete new MemoryExtractor，类内 coalescing 只作用于单实例。
- 修复：handle 持有提取实例及已消费摘要游标；同一序列最多一条在跑、一条合并待办；模型切换与 session 变化显式管理实例与 generation，旧任务不能回写新会话的提示状态。
- 验收：两次快速结束主轮不会并发启动两条同 handle 提取；摘要不重复全量提取；跨进程/多 handle 的写盘冲突由 LIFE-13 解决，不能宣称单实例守卫解决所有丢数据。

### [ ] LIFE-13 · MemoryExtractor 文本回退原子、加锁且不盲覆盖 · P1

- **判定：真实缺陷；分类：并发与数据完整性。** 来源：claude C44；证据：`memory/extractor.ts.persistTextMemories` 直接 writeFileSync，绕开已有文件读取门禁。
- 修复：在同一锁内验证作用域/存在性并采用私有临时文件+rename；现有同名主题必须读取后明确合并或拒绝/换名；崩溃和失败不更新索引为成功。拒绝非法格式，不加旧协议迁移层。
- 验收：写入中途失败保留完整旧版本；并发同名提取不发生静默覆盖或混合内容；临时文件受限、无 symlink 越界；只有成功写入才进入 saved 与重建索引。

### [ ] LIFE-14 · consolidation 对目标 transcript 有精确只读权限 · P1

- **判定：真实缺陷；分类：功能正确性 / 取证链路。** 来源：claude C41；证据：`memory/consolidation.ts` prompt 要求读 getSessionsDir，而 checker 只允许 memory/cwd。
- 修复：向 consolidator 明确授予本项目选定 transcript 的只读范围，extractor 不继承此权；或预先提供限定证据，不扩权为整个 ~/.yukino。取证被拒绝时不可照常标记完整 consolidation 成功。
- 验收：可搜索/读取列出的本项目会话，不能读别的项目、config、日志或任意 home 文件；写操作仍限 memory .md；读不到证据返回受控状态而非刷掉 24 小时闸门。

### [ ] LIFE-15 · 后台记忆任务可在宿主销毁时停止并被等待 · P2

- **判定：真实缺陷（宿主生命周期缺口）；主轮结束后后台继续工作是设计意图。分类：生命周期与可靠性 / 成本。** 来源：claude C45；证据：extractor/consolidator 的 Agent 没有宿主 abortSignal，也没有统一 dispose 接线。
- 修复：任务由宿主拥有 controller/完成 Promise，退出、dispose、会话废弃时停止或明确等待，释放锁/registry；旧任务通知绑定原 generation。不要简单复用“上一主轮结束即 abort”的信号而让正常后台管线永远做不完。
- 验收：宿主停止后不再发新模型请求/写记忆/注入旧会话通知；运行中的请求可取消，锁释放；正常主轮完成允许后台任务继续。用户中断是否取消既有独立记忆任务需采用明确一致的产品语义，不能把报告推断当既有承诺。

### [ ] LIFE-16 · 清理 rewind 临时文件必须遵守会话锁 · P2

- **判定：真实缺陷；分类：并发与数据完整性。** 来源：pi P8；证据：`session/index.ts.cleanExpiredSessions` 在锁外删所有 .rewind-tmp，`truncateSessionLines` 持锁写再 rename。
- 修复：清理前识别所属会话与存活写入者，并在同一会话锁下确认是可回收临时文件；不能只凭后缀删除正在使用的文件。
- 验收：跨进程清理恰逢 rewind 的写完/rename 之间，不影响重命名提交；崩溃遗留临时文件仍能收敛；主 JSONL 完整可恢复。

### [ ] LIFE-17 · 一次性 pre_send hook 通知写入 transcript · P2

- **判定：真实缺陷（一次性通知部分）；可再生 skill 列表不是同一缺陷。分类：功能正确性 / 持久化一致性。** 来源：claude C21；证据：`agent/index.ts` 前后两次 drainNotifications 只有前一次调用 persistLastMessage。
- 修复：保证送入模型的一次性 hook 输出在持久历史中有对应记录且只写一次；可再生的 skillDelta/reminder 不必统一全量落盘。
- 验收：once pre_send 输出送出后 resume 仍可恢复，不因 drain 丢失；同轮前后 drain 不重复；compact 继续遵循现有上下文重建契约。

### [ ] LIFE-18 · Remote rewind 使用稳定快照身份 · P2

- **判定：真实缺陷（多客户端列表过期场景）；分类：并发与数据完整性。** 来源：claude C35.2；证据：broadcastRewindList 发数组 index，handleRewindAction 对当前数组再次取 index；FileHistory 会裁剪头部。
- 修复：将请求绑定 session 和稳定 snapshot ID/列表版本；执行前校验身份，过期请求明确失败。报告“后台子代理必定创建主 FileHistory 快照”的举证未被当前接线支持，不沿用；可达场景是另一客户端在选择期间完成新运行，导致列表裁剪后再提交旧选择。
- 验收：A 打开旧列表→B 完成足够运行引起裁剪→A 选择，不能回滚到另一个快照；会话切换后的旧请求被拒；不以 userText 唯一性代替身份。

## 6. Review、LLM、打包与 worktree TODO

### [ ] REV-01 · 未跟踪 symlink 保留 Git 语义，不读目标正文 · P1

- **判定：真实缺陷；分类：隐私保护 / 审查正确性。** 来源：yukino F-2；证据：`review/git.ts.untrackedFileDiffs` 用 readFile 解引用路径，合成普通文本文件 diff。
- 修复：lstat/安全打开判断类型；symlink diff 表示链接文本和类型，不读取外部目标；处理检查与打开之间替换的竞态。
- 验收：仓库链接指向外部假秘密，prompt/report/diff 均无目标正文；链接内容与 Git mode 正确；悬空链接和目录链接不挂起。

### [ ] REV-02 · 审查文件读取在分配大内存之前有硬上限 · P1

- **判定：真实缺陷；分类：性能与资源 / 可用性。** 来源：claude C26、yukino F-3；证据：`untrackedFileDiffs` readFile 后才查 10MB，collectDiffs 的 newFileContent 回调还会再次整读工作区文件。
- 修复：两条读取路径都限制类型与实际读取字节，先查元数据再有界读，避免“stat 后文件增长”绕过；超限状态单独表达，不伪装二进制，不在后续路径重新全读。
- 验收：大稀疏文件和动态增长文件不导致与文件大小等量的内存占用；review 给出 skipped/too-large 原因；binary 嗅探只需有限前缀；与 REV-01 联合覆盖特殊文件。

### [ ] REV-03 · 分组失败必须进入最终审查结果 · P1

- **判定：真实缺陷；分类：功能正确性 / 可观测性。** 来源：claude C25、yukino F-4；证据：runner 写 outcome.error 无消费者，report 无失败字段且可能输出 No issues found。
- 修复：结果携带失败组、文件、原因和完整性状态；进度区分 done/failed/aborted；保留已确认部分发现，但不将未完成审查呈现为无缺陷。
- 验收：全组失败、部分失败、取消、正常零发现四种结果可区分；TUI/Remote 报告一致；错误信息脱敏；filesReviewed 仅统计实际完成范围。

### [ ] REV-04 · 评论路径限制在合法仓库审查目标 · P2

- **判定：真实缺陷（路径约束缺失）；分类：功能正确性 / 数据边界。** 来源：yukino F-6；证据：`review/comment-tool.ts.normalizeCommentPath` 的 posix.normalize 保留前导 ../，解析评论允许模型给路径。
- 修复：路径归一与合法性验证分离；拒绝 escape/驱动器/非法绝对目标，最终评论必须属于允许的审查 diff，并按 old/new 身份定位；只做字符串 normalize 不等于 scope 校验。
- 验收：`../outside`、多层穿越与反斜线变体不能进入最终仓库内评论；合法改名评论、相对路径和空路径默认值仍按规范工作；不得为看上去“安全”的路径做静默错误重写。

### [ ] REV-05 · 合成 diff 的路径编码与解析互逆 · P2

- **判定：真实缺陷；分类：功能正确性 / 文件身份。** 来源：yukino F-7；证据：`review/git.ts.quoteDiffPath` 用 JSON.stringify，diff-parser 按 Git C-style 解码。
- 修复：使用同一套 Git 路径 quoting/unquoting，覆盖控制字符、引号、反斜线和 Unicode；不能用 JSON 的 \u 编码冒充 Git 八进制语义。
- 验收：临时仓库中的 tab/换行/控制字符/中文文件名，未跟踪 diff→parse→评论路径完整往返；不拆分换行文件名，也不吞字节。

### [ ] REV-06 · Git 审查辅助调用传播取消 · P2

- **判定：真实缺陷；分类：生命周期与可靠性 / 诊断。** 来源：yukino F-9；证据：`review/git.ts.tryGit` catch 所有错误变 null，部分 git show 回调没有传 signal。
- 修复：区分 Git 预期失败与 abort；所有审查子进程/读操作接线取消，取消后不尝试备用 Git 路径或报 merge-base 不存在。
- 验收：在 merge-base、ls-files、show/newFileContent 阶段 abort，报告为取消、及时停止子进程，保留已完成部分；真实 ref 错误仍有正确诊断。

### [ ] LLM-01 · 端到端保留 redacted_thinking · P1

- **判定：真实缺陷；分类：协议正确性 / 会话完整性。** 来源：yukino F-12；证据：已安装 Anthropic SDK 定义 redacted_thinking/data；当前 stream 只处理 thinking/tool_use，Message/Agent/session 只保存普通 thinking/signature。
- 修复：从 stream、消息类型、Agent、持久化 schema 到请求重放保留块类型、opaque data、顺序；不得把加密块转文本或伪造签名，不靠丢 thinking 解决协议问题。
- 验收：使用 SDK 事件夹具，redacted thinking 与工具调用/普通 thinking 混合后下一请求原样带回；保存/resume 往返保持，输出/日志不展示 opaque 内容；不调用真实模型作为单测。

### [ ] LLM-02 · Chat Completions 的过滤/终止原因显式映射 · P1

- **判定：真实缺陷；分类：协议正确性 / 可观测性。** 来源：claude C14、yukino F-16；证据：`llm/openai.ts` finishReason 非 length/tool_calls 一律 end_turn，Responses 对 content_filter 报错。
- 修复：区分 stop、length、tool_calls、content_filter 和不支持的原因；内容被过滤/流异常不得作为正常完成，不执行来自无效终止状态的待决工具。
- 验收：纯文本和带 tool deltas 的 content_filter 均明确失败；未知原因按明确策略诊断；stop/length/tool_calls 与缺 finish reason 的行为不回退为假成功。

### [ ] LLM-03 · compact 与 memory selector 的回答预算 · P1

- **判定：真实缺陷（小输出 cap 与预算型 thinking 组合）；分类：功能正确性 / 模型请求配置。** 来源：yukino F-14；证据：compact 和 MemoryManager selector 未传 client 已支持的 answerReserveTokens，feedback 同类调用已使用。
- 修复：按工具调用目的设置单请求回答预留/有效输出预算，避免 summary/结构化选择只剩默认 1024；不改共享客户端全局 thinking 状态；保持合法 provider 上限，不认为增大预留就能保证任意长摘要一定完成。
- 验收：小 max_output_tokens/high thinking 的夹具中参数满足预算约束；摘要结构能在确定性样例里完成，确实触顶时错误可见；selector 合法短输出与无匹配降级正常；并发主轮配置不受污染。

### [ ] LLM-04 · 小 context window 的压缩阈值有效性 · P2

- **判定：真实缺陷；分类：功能正确性 / 配置边界。** 来源：claude C48；证据：`compact/compact.ts.computeCompactThreshold` 减固定 reserve/margin 可为负。
- 修复：明确支持的 window/output 组合；对不可能满足的配置提前诊断，对合法小窗口按可用空间计算阈值；自动阈值、hard block、熔断策略保持一致。不要只 Math.max(0) 后继续无条件重复压缩。
- 验收：小窗口不会每轮强制压缩/永久触发 hard block；正常窗口行为不退化；不合法配置有明确错误，阈值边界和连续失败保护有效。

### [ ] LLM-05 · document 不支持的源不得静默丢失 · P2

- **判定：真实缺陷（公开库 API 潜伏的数据丢失）；分类：协议正确性。** 来源：claude C13 的 URL 分支；证据：`tools/types.ts` 接受 URL document，而 `documentForChat` 无相应分支，调用方跳过 null。
- 修复：按 provider 的实际支持能力转换或返回显式不支持，保留必要的文字诊断；不要自动抓取任意 URL 引入新的读取/网络语义。file_data 的 data URI 要求另用正式协议证据核实，不把未证的 400 指控混入本项。
- 验收：外部库调用构造的 document base64/text/url 块均有明确输出或错误，没有无声丢块；当前内置工具未产出 document 的事实在测试与变更说明中如实注明。

### [ ] PKG-01 · telemetry optionalDependencies 真正可缺省 · P1

- **判定：真实缺陷；分类：协议与打包 / 库可用性。** 来源：pi P5；证据：`telemetry/index.ts` 静态 export Providers→providers 静态引入 optional 包，与 initializeTelemetry 惰性降级相矛盾。
- 修复：移除该静态可达路径，仅暴露不触发 optional 加载的接口/类型，provider 实现经 guarded dynamic import；不以把 optional 改必装来绕过声明契约。
- 验收：构建后的真实 lib 产物在隔离、只含必需依赖的目录可导入和调用普通 API；启用遥测但缺 optional 包可 no-op；安装齐全时初始化正常。不能只 grep 源码或只测 CLI bundle。

### [ ] WORK-01 · worktree 工具描述与执行根/OS sandbox 接线一致 · P1

- **判定：真实缺陷（描述与功能组合）；返回绝对路径本身是设计意图。分类：功能正确性 / 隔离与权限。** 来源：codex N2、pi P4、claude 对 subagent sandbox 的补充；证据：EnterWorktree 只创建返回路径；子代理派生 checker 的 cwd 正确，但 Bash 实例的 sandbox allowWrite 仍来自宿主。
- 修复：采用当前 README 的“创建并返回路径、显式在该路径操作”契约，修正 enter/exit 的误导描述；为本运行创建的 worktree 授予对应的路径和 Bash 沙箱执行根。派生代理需要独立执行上下文，不能扩大共享 Bash 实例的全局 allowWrite 造成兄弟代理互写。
- 验收：相对路径不会被误以为已换 cwd；使用返回路径在 acceptEdits 下遵循授权策略；worktree 隔离子代理的 Bash 确能写其工作树，未获显式额外授权时不能写主工作区/其他 worktree。并发不同 worktree 与 OS denyWrite 均覆盖。依赖 SEC-03/13。

## 7. 工具、资源、UI 与诊断 TODO

### [ ] TOOL-01 · FileStateCache 键统一规范化 · P2

- **判定：真实缺陷；分类：功能正确性。** 来源：codex D5.2、pi P7；证据：`tools/file-state-cache.ts` Map 直接用传入路径，mutation queue 使用 canonical key。
- 修复：record/has/check/update/delete 共用规范键，正确处理未创建/删除/不可访问路径，不缓存一个别名而更新另一个。
- 验收：symlink 别名和 macOS /tmp 别名读取后不误报未读；文件真正变化仍拒绝编辑；删除/替换 symlink 不沿用错误目标的读取记录。

### [ ] TOOL-02 · macOS 沙箱允许必要设备 IO · P1

- **判定：真实缺陷（seatbelt）；Linux bwrap 同结论尚未确证。分类：功能正确性 / OS 沙箱。** 来源：codex D3、pi P3；证据：seatbelt deny default 仅放行 allowWrite 根，没有 /dev/null 写规则。
- 修复：对确需的设备节点最小授权，首先 /dev/null；不为了重定向给整个 /dev 写权。bwrap 的只读挂载是否拒绝字符设备 IO 必须在 Linux 实测，不能从 ro-bind 普通文件语义直接推论。
- 验收：macOS sandbox 中 stdout/stderr 重定向和 && 链正常，外部文件写仍拒绝，用户 denyWrite 不被设备授权覆盖；Linux 实测结果明确记录，只有复现相同故障才修改该后端。

### [ ] TOOL-03 · WebFetch 懒加载失败不永久锁死本地 singleton · P2

- **判定：真实缺陷（失败状态复用）；分类：生命周期与可靠性。** 来源：pi P20、yukino L-2；证据：`getTurndownService` 用 ??= 缓存拒绝 Promise。
- 修复：初始化失败后释放本地单例状态，让后续调用能按受控策略再尝试；并发首次调用仍只初始化一次。Node 模块加载器本身缓存的不可恢复加载错误不能保证仅重置 Promise 就治愈，须如实返回诊断。
- 验收：可恢复的构造失败后下一次成功；同时调用不重复构造；持久依赖缺失不产生热循环、成功实例正常复用。

### [ ] TOOL-04 · WebFetch 截断不拆 Unicode 字符 · P2

- **判定：真实缺陷；分类：功能正确性 / 文本完整性。** 来源：pi P21、yukino L-6；证据：truncateMarkdown 按 UTF-16 length 直接 slice。
- 修复：明确上限是字符还是字节，采用相应安全边界，提示预算包含包装开销；不要将 UTF-8 字节辅助函数误当 UTF-16 索引直接复用。
- 验收：emoji/代理对恰在 100000 边界时无孤立 surrogate/替换符；ASCII 上限与提示正常，缓存不因截断反复膨胀。

### [ ] TOOL-05 · IDE WebSocket 启动有超时与完整结算出口 · P2

- **判定：真实缺陷（无默认握手时限）；报告“真实 ws 必然纯 close 无 error”未确证。分类：生命周期与可靠性。** 来源：pi P24、yukino L-3；证据：`vscode/ws-transport.ts.start` 仅等待 open/error，创建 ws 未设 handshakeTimeout。
- 修复：设置合理启动时限；open/error/close/主动 close/abort 都只能 settle 一次，并清监听器/定时器；按 SDK 的 start/close 约定保留单次 onclose。
- 验收：测试服务器接 TCP 后不回握手、提前关闭、用户取消、正常握手四种路径均有界；纯 close 分支用明确 transport 夹具测试，不以模拟事件当已证生产故障。

### [ ] TOOL-06 · OSC-8 保留 URL 字面加号 · P2

- **判定：真实缺陷；分类：功能正确性。** 来源：pi P22、yukino L-7；证据：`ui/marked-terminal.ts` 将 href 中所有 + 改 %20。
- 修复：按 URL 原始语义生成链接，不套用表单编码的 plus→space；终端控制字符防护独立处理。
- 验收：路径、查询值、签名 URL 中的 `+`、`%2B`、空格各自保持正确目标，显示文本不受影响。

### [ ] TOOL-07 · Windows 截屏尺寸验证 · P2

- **判定：真实缺陷；分类：功能正确性 / 平台可靠性。** 来源：pi P26、yukino L-8；证据：ComputerUse win32 分支 Number 后直接交给 resize，macOS 有有限正数回退。
- 修复：校验有限正尺寸，优先可信图片 metadata/受控错误；畸形文本不能生成 NaN 坐标缩放。定义屏幕坐标和像素坐标的回退关系。
- 验收：空输出、提示噪声、NaN、0、负数与正常输出夹具；真实 Windows 验证缩放后点击坐标正确。macOS 上通过 mock 不等于已做 Windows 实测。

### [ ] TOOL-08 · MCP 参数转换保留 **proto** 自有字段 · P2

- **判定：真实缺陷；分类：功能正确性 / 对象健壮性。** 来源：pi P23、yukino S-2；证据：coerceBySchema 向 {} 的方括号赋值可替换输出对象原型。
- 修复：用安全自有属性构造；schema properties 的查找用 own-property 检查。不是全局 Object.prototype 污染，不夸大影响。
- 验收：JSON.parse 得到的 **proto**/constructor/toString 键序列化往返不丢失、不改变原型；嵌套对象/数组和正常强制转换均正常。

### [ ] TOOL-09 · tool-result spill 必须有净空间收益 · P2

- **判定：真实缺陷；分类：功能正确性 / 上下文预算。** 来源：claude C6；证据：applyBudget 跳过阈值仅 2000，包装后内容可能比原结果更长。
- 修复：在实际 wrapper/path 开销下判断净节省，再替换和更新 total；原文不会缩小时不写无效 spill；允许不可再缩的剩余项按已声明策略超预算。
- 验收：2000 附近边界、多路径长度、多项聚合场景 total 不因 spill 增长；统计与真正存入历史一致。报告称“提前误判达标”不严谨：当前负节省会让 total 增加，直接后果是收敛变差。

### [ ] TOOL-10 · 公共 HTTP 工具不得静默丢 RequestInit.body · P2

- **判定：真实缺陷（公开库 API 潜伏）；分类：功能正确性 / 网络 API。** 来源：claude C38；证据：`utils/public-http.ts` 接受 RequestInit，而 pinned request 直接 outgoing.end()；当前内置调用方仅 GET。
- 修复：按当前需求收窄为明确 GET/HEAD、拒绝 body/不支持选项，或完整实现有界请求体；优先收窄契约，不能仅把任意 BodyInit 直接传给 end。保留 DNS 地址钉扎与每跳验证。
- 验收：调用方传 POST/body 获明确错误或服务端收到完整正确 body；注入 fetcher 与真实 pinned 实现行为一致；不因支持 body 放松 SSRF 防线。

### [ ] TOOL-11 · 退出码提示的命令识别处理引号 · P2

- **判定：真实缺陷（提示误判）；分类：诊断正确性。** 来源：yukino S-4；证据：`tools/exit-code-hints.ts.extractBaseCmd` 无条件 split 引号内管道/分号。
- 修复：复用 SEC-01 对适用 shell 的分析能力，不能可靠判断时只显示通用退出信息；不把提示解析器当权限分析器复用而降低安全性。
- 验收：引号中的 `;rg`/`|grep` 不会令 echo 等命令被解释为搜索命令；真正管道尾命令、PowerShell 引号和路径后缀按约定处理。

### [ ] TOOL-12 · Grep 的正则匹配不能无限占用主线程 · P1

- **判定：真实缺陷（已验证底层阻塞机制）；分类：性能与资源 / 可取消性。** 来源：yukino S-1；证据：grep.ts 同步 regex.test，取消只在匹配前后检查，本周期恶意回溯夹具超过 1 秒。
- 修复：选用有硬执行时限/可终止的隔离执行方式或明确的安全正则实现；保留受支持语义并对不支持表达式诊断。不能用 Promise.race/AbortSignal 包住同步 test 就宣称可中止，也不靠简单“危险正则”启发式兜底。
- 验收：灾难性回溯样例在外部受控时限内结束，主 UI 心跳/取消仍响应；普通 Unicode/大小写匹配结果保持；测试自身在独立可杀进程/worker 内执行，不能卡死测试 runner。

### [ ] RES-01 · LSP 文档和诊断缓存有数量/字节预算 · P2

- **判定：真实缺陷；分类：性能与资源。** 来源：codex N4、yukino M-7；证据：LSP Session.documents 长期保存所有全文，无 didClose/淘汰。
- 修复：按数量及实际文本字节预算淘汰，发送 didClose 并清诊断；in-flight 文档不可被错误淘汰，重新打开版本和旧诊断处理明确。
- 验收：大量文件查询后驻留量有上限；淘汰重开仍可查询，旧诊断不串文件；dispose 清理全部；不只是清 Map 而让语言服务器继续永久持有文档。

### [ ] RES-02 · A2A 闲置会话元数据可收敛且保留上下文映射 · P2

- **判定：真实缺陷（无界驻留）；保留 contextId→sessionId 是设计意图。分类：性能与资源。** 来源：claude C15；证据：executor evictSession 释放 runtime 但 sessions Map 不 delete，dispose 才 clear。
- 修复：给闲置元数据设预算/持久化索引或明确过期协议；不得直接删除映射后让同 contextId 静默变新会话。活动和 pending approval 不能被逐出。
- 验收：大量不同 contextId 后内存有界；允许继续的旧 context 仍恢复原 transcript，确实过期的 context 给明确结果；不把“释放 runtime”和“释放所有元数据”混为一谈。

### [ ] RES-03 · MCP stdio 的异常退出清理接线 · P2

- **判定：真实缺陷（崩溃清理缺口）；分类：生命周期与可靠性。** 来源：claude C16；证据：MCP client 未 registerExitCleanup，exit-cleanup 的设计说明包含 MCP；正常 disconnectAll 已存在。
- 修复：spawn 后登记可同步执行的、由宿主拥有的子进程清理，并在正常关闭时注销；核实 SDK pid/子树归属及退出时序，不盲用负 PID 杀非 detached 进程组。
- 验收：忽略 stdin EOF 的假 MCP 在 recover/强制退出清理后不残留；正常断开幂等；一个 borrowed MCP 不能被子代理 dispose；不声称能同步 await SDK disconnectAll。

### [ ] RES-04 · 浏览器离线发送队列有上限和消息时效策略 · P2

- **判定：真实缺陷；分类：性能与资源 / 交互可靠性。** 来源：claude C35.3；证据：use-web-socket 的 pendingRef 对所有消息无界 push，重连无区别全量发送。
- 修复：按消息数与字节预算排队；过期审批回复、ping 等不保留，图片上传等大消息离线时明确反馈失败；保留用户可重试的正文，避免静默丢输入。
- 验收：长时间离线、反复图片提交、过期 permission response 后内存有界；重连不发陈旧授权、不突发重复执行；FIFO 保留与拒绝策略有用户可见结果。

### [ ] RES-05 · 文件锁识别 PID 复用，避免误认旧票据属主 · P2

- **判定：真实缺陷（条件受限的活性问题）；分类：并发与可靠性。** 来源：claude C50、yukino S-10；证据：file-lock 只用 kill(pid,0) 判存活，旧票据可能被无关同 PID 进程长期保留。
- 修复：选定可验证的进程实例身份或安全的租约机制；无法辨认身份时保持不抢活锁的安全原则，提供明确超时诊断。不能按“超过 10 秒”强删真正长期持锁者。
- 验收：模拟旧票据与复用 PID 后可识别非原属主；真正活锁不被回收；获取仍 5 秒有界、互斥成立。影响是持续获取失败，**不是**一次调用永久占用事件循环；避免为极低概率场景加入多代兼容层。

### [ ] UI-01 · Ctrl+J/换行按 Ink 实际键事件识别 · P1

- **判定：真实缺陷（文档快捷键与分支不符）；分类：交互 / 输入正确性。** 来源：pi P19、yukino M-4；证据：Input/TextField 要求 input 为 LF 且 key.ctrl；已安装 Ink 的 parse-keypress 将原始 LF 识别为 enter、ctrl=false，useInput 仍交付 LF，因而命中提交而非换行。扩展协议 ctrl+j 还可能以字母 j 交付，hasReturn 不成立。
- 修复：统一实际键事件到 newline/submit 的映射，覆盖主输入和多行 TextField；对于终端把不同按键编码成完全相同字节的情况，如实提供可区分快捷键，不承诺凭空识别 legacy Shift+Enter。
- 验收：走真实 Ink 解码夹具而非只手工造 key 对象；Ctrl+J 插入换行不提交，Enter 提交，支持的扩展协议 Shift+Enter 正常，粘贴带换行仍是 paste。

### [ ] UI-02 · Ctrl+B 由当前焦点拥有 · P2

- **判定：真实缺陷；分类：交互。** 来源：pi P27、yukino L-4；证据：全局 onBackgroundShells 仅排除 login，对 AskUser Other/plan feedback 等 TextField 仍双触发。
- 修复：用统一焦点/模态输入策略抑制全局后台化快捷键，不逐个弹窗叠加脆弱布尔判断。
- 验收：前台 shell 运行时，在各文本对话框 Ctrl+B 只移动光标；主聊天焦点 Ctrl+B 仍后台化一次；无运行任务时不产生副作用。

### [ ] UI-03 · 动态列表的 React key 使用稳定身份 · P2

- **判定：真实缺陷（重复输入可达）；分类：交互正确性。** 来源：yukino L-5；证据：ask-user 的 opt.label/q.question、issue approval 标题、rewind 文案作为 key。
- 修复：为请求/选项/草稿/快照提供稳定身份，不依赖可重复显示文本；对本来按位置固定的集合可使用符合生命周期的索引，不能每次 render 随机生成 key。
- 验收：重复问题/选项/标题/用户文本无 duplicate-key，焦点和选择不串条目；重排和下一请求切换不沿用前一请求局部状态。

### [ ] UI-04 · 忙碌 Ctrl+C 清理退出提示与计时器 · P2

- **判定：真实缺陷；分类：交互 / 生命周期。** 来源：claude C9；证据：`use-terminal-controls.ts` busy 分支只中断并重置 count。
- 修复：退出提示、计数、timer 共用重置操作；状态切换和卸载也不留下延迟回调。
- 验收：空闲第一次 Ctrl+C→工作启动→Ctrl+C，中断后无“再按退出”的陈旧提示；双 Ctrl+C 退出和非 Ctrl+C 清提示正常。

### [ ] UI-05 · 大粘贴按块处理，减少同步主线程占用 · P2

- **判定：真实性能缺陷；分类：性能与资源 / 输入响应。** 来源：pi P13、yukino M-3；证据：TerminalInput 对正文逐字符扫描/拼接。
- 修复：pasting 状态块级找结束标记，仅保留必要跨 chunk 前缀；必要时限制/分批处理超大输入。不要只改一个 slice 写法而继续每字符遍历所有判定。
- 验收：多 MB 载荷完整往返、标记拆 chunk、UTF-8 拆 chunk、正文包含 OSC 文字均正确；记录同一环境下耗时与事件循环延迟对比，不使用脆弱的机器绝对毫秒门限，也不宣称修复 O(n²)。

### [ ] UI-06 · 图片超限说明受总内联预算约束 · P2

- **判定：真实缺陷（预算不变量）；分类：功能正确性 / 交互。** 来源：claude C28；证据：at-expand 图片数量超限分支直接 appendix +=，未过 appendWithinLimit。
- 修复：走统一字节预算并只提示一次；不能因为提示导致前面已纳入的附件/内容被错误删除。
- 验收：32 个引用、图片超限、总预算刚好满时输出仍有界；提醒最多一条；实际图像块数不超过限制。影响被 MAX_AT_REFS 限住，不标成无界 DoS。

### [ ] UTIL-01 · 修正过期注释中的产品契约 · P2

- **判定：真实文档缺陷；实现所采用的策略是设计意图。分类：诊断与文档。** 来源：claude C11、pi P28；证据：app.tsx 声称 project prompts 覆盖 global，但 loader 只读全局；address.ts 注释用 `":"` 举省略端口例子，正则拒绝。
- 修复：注释与当前 README/实现对齐：prompts 仅全局；空地址示例为 `""`。不为了修注释引入项目 prompt 执行来源或放宽所有尾随冒号输入。
- 验收：文档示例都可由当前函数解析/定位；只改错误说明，相关行为测试保持。SAFE_PREFIXES 重复值可在 SEC-01 顺手清理，不单独冒充一个功能缺陷。

### [ ] UTIL-02 · 用户命令大小写归一冲突有确定结果 · P2

- **判定：真实缺陷（条件受限）；分类：功能正确性 / 诊断。** 来源：claude C12；证据：commands/loader 统一小写后 Map 覆盖依赖 readdir 顺序。
- 修复：先确定排序与冲突策略，再输出包含文件路径的诊断；对 case-sensitive FS 的 Foo.md/foo.md 和目录命名空间冲突同样处理。
- 验收：改变目录枚举顺序不会悄悄切换生效命令；冲突明确可见；全局加载范围和内置命令优先级不被改动。

### [ ] UTIL-03 · SkillCatalog 缓存版本与所读正文一致 · P2

- **判定：真实缺陷；分类：并发与功能正确性。** 来源：claude C17；证据：loadSkill 先 read 后 stat，旧正文可能标记成新 mtime。
- 修复：读前/读后版本校验或受控重读，避免把未读取的文件版本标为已加载；单纯 open+fstat 不自动保证并发写期间内容不变，需要实际一致性方案。
- 验收：在读取与 stat 之间注入修改，下一次 get 可加载新内容；不缓存新 mtime+旧正文；保留项目 skill 覆盖全局的既有设计。

### [ ] UTIL-04 · YAML 解析错误携带配置路径 · P2

- **判定：真实诊断缺陷；分类：诊断与文档。** 来源：claude C23；证据：loadSingleFile 的 yaml.load 异常没有 path 上下文，schema 错误有。
- 修复：包装为包含路径和原始行列原因的 ConfigError，保留 cause，不吞原错误/敏感配置正文。
- 验收：缩进/未闭合 YAML 能指出具体配置路径与行列；schema 错误和缺文件语义仍明确；终端错误不打印完整 API key 行。

### [ ] UTIL-05 · intArg 的类型转换与范围校验一致 · P2

- **判定：真实缺陷；分类：功能正确性 / 输入验证。** 来源：pi P30；证据：number floor、string parseInt；本周期实测 -0.5 与字符串 -0.5 不同，后者成为 0，可通过允许 offset>=0 的检查。
- 修复：定义统一的有限数字/整数字符串契约和取整规则，按工具 schema 验证范围；拒绝部分解析、NaN、Infinity 等不支持输入，不靠兜底掩盖非法值。
- 验收：相同逻辑数值不因 JSON 类型不同改变接受/拒绝；offset/limit/timeout/max_results 边界有覆盖。纠正报告“负值全部被拒、绝无现行影响”的过强结论。

### [ ] UTIL-06 · 环境 Git 探测有界且不经 shell · P2

- **判定：真实可靠性缺口（无超时）；分支名原文不等于已证命令注入。分类：生命周期与可靠性。** 来源：claude C20；证据：prompt/builder 两个 execSync git 调用无 timeout。
- 修复：使用参数数组与短时限，或纯文件读取；探测失败保持可选降级。分支信息按环境数据呈现并合理限长，不把字符串转义当提示注入的完整防护。
- 验收：模拟挂起 git，启动/构建提示在规定时限内恢复；正常仓库/无 Git/损坏 HEAD 可继续；不运行真实网络仓库或改全局 Git 配置。

### [ ] TEST-01 · LSP 超时测试不依赖 100ms 子进程启动 · P2

- **判定：真实测试脆弱性；生产默认超时策略是设计意图。分类：测试稳定性。** 来源：claude C2；证据：tests/lsp.test.ts 把 config.timeout_ms=100 同时用在 initialize 与目标等待，本周期单文件/小套件通过不能否定负载相关风险。
- 修复：通过显式测试握手同步/独立请求超时夹具，隔离“要测试的超时”和“启动语言服务器的调度时间”；不为测试新增无产品需求的用户配置，也不全局提高所有断言超时掩盖真正挂死。
- 验收：全量标准并行负载稳定通过；故意挂起/取消/损坏帧测试仍在合理时间失败；正常 initialize 超时也有独立验证。

## 8. 原报告编号追踪表

以下映射覆盖报告列出的缺陷编号；同源重复不另建修复项。表中的“排除”均对应第 2 节明确裁定，不表示默认为真。

### codex

| 编号                        | 结论 / 去向                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| D1 / D2 / D3 / D4           | 真实：SEC-01 / SEC-02 / TOOL-02（仅已证后端）/ SEC-03。                                             |
| D5.1 / D5.2                 | 真实：SEC-02 / TOOL-01。                                                                            |
| D5.3                        | 重复 SAFE_PREFIXES 无行为影响，不独立列缺陷；随 SEC-01 清理。                                       |
| D5.4                        | 普通 session_end 异常传播未确证，排除。                                                             |
| D5.5                        | 设计意图：max_tokens 时整批待决工具保守拒绝执行；见第 9 节。                                        |
| N1 / N2 / N3 / N4 / N5 / N6 | 真实：SEC-05 / WORK-01 / LIFE-04 / RES-01 / SEC-09 / SEC-06；N6 的受信全局 include 语法是设计意图。 |

### pi

| 编号                                    | 结论 / 去向                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P1 / P2 / P3 / P4 / P5                  | 真实：SEC-01 / SEC-02 / TOOL-02 / WORK-01 / PKG-01。                                                                    |
| P6 / P7 / P8                            | 真实：SEC-03 / TOOL-01 / LIFE-16。                                                                                      |
| P9 / P10                                | P9 未确证；P10 重复项/未调用 API 不独立列缺陷。allowExtraRoot 的接线缺口在 WORK-01 处理，不为了“死代码”删除需要的能力。 |
| P11 / P12                               | 设计意图，报告永久阻塞/必须剥离标点的解读排除。                                                                         |
| P13 / P14 / P15 / P16                   | 真实：UI-05（纠正复杂度）/ SEC-03 / LIFE-04 / SEC-05。                                                                  |
| P17                                     | A2A loopback/noAuthentication 是设计意图。                                                                              |
| P18 / P19 / P20 / P21 / P22 / P23 / P24 | 真实：SEC-09 / UI-01 / TOOL-03 / TOOL-04 / TOOL-06 / TOOL-08 / TOOL-05（范围修正）。                                    |
| P25                                     | WriteFile 所述空目录拒绝链不成立。                                                                                      |
| P26 / P27 / P28                         | 真实：TOOL-07 / UI-02 / UTIL-01（改注释）。                                                                             |
| P29                                     | 历史光标约定属于设计选择，不列缺陷。                                                                                    |
| P30                                     | 真实：UTIL-05；纠正“负小数差异永不影响下游”的断言。                                                                     |

### claude

| 编号                        | 结论 / 去向                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| C1 / C2 / C3                | 真实：SEC-04 / TEST-01 / SEC-16。                                                                        |
| C4 / C5 / C6 / C7           | 真实：SEC-07 / SEC-08 / TOOL-09 / LIFE-03。                                                              |
| C8 / C10                    | 已声明的失败重排与光标位置属于设计选择；“永久无法移除”不成立。                                           |
| C9 / C11 / C12              | 真实：UI-04 / UTIL-01 / UTIL-02。                                                                        |
| C13                         | URL 静默丢弃为潜伏真实缺陷 LLM-05；“裸 base64 必然无效”未确证。                                          |
| C14 / C15 / C16 / C17 / C18 | 真实：LLM-02 / RES-02 / RES-03 / UTIL-03 / SEC-13。                                                      |
| C19                         | 有限子集排序是设计意图，不承诺全局 top-K。                                                               |
| C20 / C21                   | 真实部分：UTIL-06（无超时）、LIFE-17（一次性通知）；不泛化为已证命令注入/所有 reminder 都应持久化。      |
| C22 / C24                   | 设计意图：UI 完整历史、同项目共享规则。                                                                  |
| C23 / C25 / C26             | 真实：UTIL-04 / REV-03 / REV-02。                                                                        |
| C27                         | 生产 rename 输入未确证，排除实施。                                                                       |
| C28 / C29 / C30 / C31       | 真实：UI-06 / LIFE-05 / LIFE-07 / LIFE-08。                                                              |
| C32 / C33 / C34             | 真实：LIFE-09 / LIFE-09 / LIFE-06。                                                                      |
| C35.1 / C35.2 / C35.3       | 真实：LIFE-05 / LIFE-18（修正可达场景）/ RES-04。                                                        |
| C35.4                       | 支持 Node 版本下“空闲 HTTP 阻塞 close”的理由不成立。                                                     |
| C36 / C37 / C38             | 真实：SEC-07 / SEC-07 / TOOL-10（库 API 潜伏）。                                                         |
| C39.1                       | 明确凭据载体（含已知服务密钥格式）缺口：SEC-14；裸 JWT/任意字符串通用识别不当已证缺陷。                  |
| C39.2 / C39.3               | 默认 sharp 像素上限反证“无上限”；IDE 微任务窗口未确证。                                                  |
| C40 / C41 / C42 / C43 / C44 | 真实：SEC-12 / LIFE-14 / LIFE-12 / SEC-10 / LIFE-13。                                                    |
| C45 / C46                   | 真实部分：LIFE-15（宿主生命周期）、SEC-11（用户规则）；主轮结束后后台继续、独立 memory mode 是设计意图。 |
| C47 / C48 / C49 / C50       | 真实：SEC-15（结构边界）/ LLM-04 / SEC-03 / RES-05（有界获取、有限活性影响）。                           |

### yukino

| 编号                                       | 结论 / 去向                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| H-1 / H-2 / H-3                            | 真实：SEC-03 / SEC-05 / SEC-03；H-3 中目录族授权是设计意图。                        |
| M-1                                        | 混合：SEC-01/02 修规则绕过；空危险名单与 sandbox 非危险命令 auto-allow 是设计意图。 |
| M-2 / M-3 / M-4 / M-5 / M-6 / M-7          | M-2 是设计意图；其余真实：UI-05（非 O(n²)）/ UI-01 / LIFE-04 / SEC-09 / RES-01。    |
| L-1 / L-9                                  | 报告触发链不成立，排除。                                                            |
| L-2 / L-3 / L-4 / L-5 / L-6 / L-7 / L-8    | 真实：TOOL-03 / TOOL-05（范围修正）/ UI-02 / UI-03 / TOOL-04 / TOOL-06 / TOOL-07。  |
| L-10 / L-11                                | 设计意图：预算口径 / 同步锁。                                                       |
| S-1 / S-2 / S-3 / S-4                      | 真实 TOOL-12 / TOOL-08；S-3 设计意图；S-4 真实 TOOL-11。                            |
| S-5 / S-6 / S-7 / S-8 / S-9 / S-10         | 分别：未确证 / 有界取舍 / 未确证 / 不成立 / 有界取舍 / 真实 RES-05。                |
| F-1 / F-2 / F-3 / F-4 / F-5                | 真实：SEC-07 / REV-01 / REV-02 / REV-03 / SEC-09。                                  |
| F-6 / F-7 / F-8 / F-9 / F-10 / F-11 / F-12 | 真实：REV-04 / REV-05 / SEC-15 / REV-06 / SEC-14 / LIFE-01 / LLM-01。               |
| F-13                                       | 跨模型签名必然失败未确证；不实施盲删/替换 signed thinking。                         |
| F-14 / F-15 / F-16                         | 真实：LLM-03 / LIFE-02 / LLM-02。                                                   |
| G-1 / G-2                                  | 真实：LIFE-11（收窄到重建刷新）/ LIFE-10。                                          |

## 9. 统一保留的设计边界

四份报告“设计意图/正向确认”中以下行为继续保留；不因相邻存在缺陷一并重写：

- WebFetch 可访问内网 HTTP/HTTPS，普通 ReadFile/Glob/Grep 可读项目外路径；InstallSkill 的公共网络访问限制属于另一用途。
- print 模式 bypassPermissions、用户亲手输入的 `!`/`!!` 表示直接授权；显式 deny/ask 与 Bash OS sandbox 仍按各自契约执行。
- 主/子/teammate 权限继承矩阵、永久只读代理、leader 计划审批锁；不因 remembered allow 或 sandbox auto-allow 解除锁。
- 主会话 plan/bypass 不直接决定独立后台 memory 子任务模式；其 scoped 文件边界和用户显式规则缺口按 SEC-10/11 修正。
- 受信用户配置中的 MCP/LSP 本地程序拥有宿主 OS 权限、继承所需 env；项目来源执行门禁是 SEC-05，不用删除所有 MCP env 继承代替。
- Glob/Grep 固定 SKIP_DIRS、mtime 门控、ReadFile CRLF 与 EditFile 补偿、超时前台 shell 转后台、steering 回收。
- hooks 来自用户配置，条件 new Function 不另引入比 shell hooks 更大的执行权；on_error 现有处理和 once 失败释放保留。
- MCP eager/native/dispatch 策略、受保护的 native tool_reference 透传、技能覆盖优先级、coordinator 工具收窄、print 不等待无限 shell 服务。
- StreamingExecutor 结果按 toolId 配对，不要求提交顺序；partial/max_tokens 工具响应保守拒绝不改为执行半批结果。
- A2A 当前 SDK 的终态契约不靠旧版 final 字段；不因报告提及旧接口加入版本兼容。MCP announcement 以 conversation history 自愈，不能仅凭 Set 未手动清理推断错乱。
- update 固定 registry、受支持全局包管理器检查、SSRF 地址钉扎、原子写/锁等已验证正确路径保留；修复只针对上面列明的缺口。

## 10. 本周期交付检查

- [x] 四份报告的全部缺陷编号已有追踪与明确裁定，重复项已合并。
- [x] 真实缺陷各有分类、P0/P1/P2、当前源码依据、修复方向和可执行验收条件。
- [x] 设计意图、已反证与未确证条目不进入修复实施队列；混合结论已拆分。
- [x] 仅制作计划，未开展源码实施；所有修复项保持未勾选。
- [ ] 后续实施按实际验证结果逐项更新，不能将本计划的静态推断写成已完成修复或已通过新回归测试。
