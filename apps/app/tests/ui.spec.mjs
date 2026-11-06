import { expect, test } from "@playwright/test";

async function bootstrap(page) {
  await page.addInitScript(() => {
    const listeners = new Set();
    const emit = (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    let content = "export const greeting = 'Hello Yukino';\n";
    let revision = 1;
    const initial = {
      ok: true,
      cwd: "/project/yukino",
      projectKey: "project",
      providerName: "Local test",
      model: "test-model",
      sessionId: "session",
      permissionMode: "default",
      contextWindow: 128000,
      thinkingLevel: "high",
    };
    const file = () => ({
      path: "hello.ts",
      content,
      baseline: "export const greeting = 'Hello';\n",
      revision: String(revision),
      deleted: false,
    });
    window.__emit = emit;
    window.__changeFile = (text) => {
      content = text;
      revision++;
      emit({
        type: "workspace_changed",
        data: { cwd: initial.cwd, path: "hello.ts" },
      });
    };
    window.__saved = [];
    window.__runtime = {
      tools: ["Read", "Edit", "Write", "Bash", "Agent", "Workflow"],
      toolDescriptions: { Read: "读取项目文件", Edit: "修改项目文件" },
      skills: [{ name: "review", description: "审查代码" }],
      memories: [],
      mcpServers: ["local"],
      tasks: [
        {
          id: "1",
          subject: "完善工作区交互",
          status: "in_progress",
          description: "处理输入与工作区布局",
          blocks: [],
          blockedBy: [],
          metadata: {},
        },
      ],
      backgroundTasks: [],
      teammates: [],
      subagents: [],
      workflows: [],
      namedWorkflows: [],
      goal: null,
      sandbox: { enabled: false, autoAllow: false },
      hooks: false,
      coordinator: false,
      memoryEnabled: true,
      activeSkills: [],
      checkpoints: [],
      permissionMode: "default",
    };

    window.api = {
      init: async () => {
        emit({ type: "init_state", data: initial });
        return initial;
      },
      getTheme: async () => ({ mode: "light", dark: false }),
      onTheme: () => () => {},
      setTheme: async () => {},
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listSessions: async () => [
        {
          id: "session",
          firstMessage: "构建 Yukino 桌面工作区",
          cwd: initial.cwd,
          projectKey: "project",
          messageCount: 4,
          modTime: Date.now(),
          lastUserMessageTime: Date.now(),
        },
      ],
      listCommands: async () => [
        {
          name: "review",
          description: "检查代码变更",
          type: "prompt",
          isSkill: false,
        },
        {
          name: "goal",
          description: "持续目标",
          type: "prompt",
          isSkill: false,
        },
      ],
      workspaceList: async () => [
        { path: "hello.ts", name: "hello.ts", directory: false },
      ],
      workspaceSnapshot: async () => ({
        cwd: initial.cwd,
        changes: [{ path: "hello.ts", status: "M" }],
        branch: "main",
      }),
      workspaceRead: async () => file(),
      workspaceSave: async (path, text, expected) => {
        if (String(revision) !== expected) {
          throw new Error("文件已被 Agent 修改");
        }
        content = text;
        revision++;
        window.__saved.push(text);
        return file();
      },
      selectFolder: async () => ({ cwd: null }),
      newSession: async () => {
        emit({ type: "history", data: { sessionId: "new", messages: [] } });
        return { sessionId: "new" };
      },
      send: async (text) => {
        window.__sent = text;
      },
      abort: async () => {
        emit({ type: "run_state", data: { streaming: false } });
      },
      selectAttachments: async () => ["/project/image.png"],
      saveProvider: async (input) => {
        window.__provider = input;
      },
      getSettings: async () => ({
        providers: [
          {
            name: "Local test",
            protocol: "openai",
            baseUrl: "http://localhost",
            model: "test-model",
          },
        ],
        currentProvider: 0,
        model: "test-model",
        thinkingLevel: "high",
        thinkingLevels: ["low", "high"],
      }),
      getRuntime: async () => structuredClone(window.__runtime),
      requestMcpApp: async () => ({}),
      runtimeAction: async (action) => {
        window.__action = action;
      },
      runCommand: async (command) => {
        window.__command = command;
      },
      respondPlan: async () => {},
      respondAsk: async () => {},
      respondPermission: async () => {},
      setPermissionMode: async (mode) => {
        initial.permissionMode = mode;
        window.__permissionMode = mode;
        emit({ type: "init_state", data: { ...initial } });
      },
      openConfig: async () => {},
    };
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("textbox", { name: "任务输入", exact: true }),
  ).toBeVisible();
}

test("workspace layout, commands, Chinese input and collapsed drafts", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bootstrap(page);
  await page.screenshot({ path: "test-results/workspace-light.png" });
  await page.getByRole("button", { name: "hello.ts M" }).click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.waitForTimeout(800);
  const editorRegion = page.getByRole("region", { name: "文件", exact: true });
  await page.getByRole("button", { name: "代码", exact: true }).first().click();
  await expect(editorRegion).toBeHidden();
  await page.getByRole("button", { name: "代码", exact: true }).first().click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const separator = page.getByRole("separator", { name: "调整代码工作区宽度" });
  await separator.focus();
  await separator.press("ArrowLeft");
  const beforeExpand = await editorRegion.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await page.getByRole("button", { name: "展开编辑器", exact: true }).click();
  await expect(page.getByRole("main")).toBeHidden();
  await page.getByRole("button", { name: "恢复分栏", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs(
        (await editorRegion.evaluate(
          (element) => element.getBoundingClientRect().width,
        )) - beforeExpand,
      ),
    )
    .toBeLessThan(12);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "主题", exact: true }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: "test-results/workspace-dark.png",
    animations: "disabled",
  });
  const input = page.locator("textarea").first();
  await input.fill("检查中文输入");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe("检查中文输入");
  await input.fill("/rev");
  await expect(page.getByRole("option", { name: /review/ })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("/review ");
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("完善工作区交互"),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("live Agent changes preserve dirty drafts and require conflict review", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "hello.ts M" }).click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.evaluate(() =>
    window.__changeFile("export const greeting = 'Agent updated';\n"),
  );
  await expect(page.locator(".view-lines").last()).toContainText(
    "Agent updated",
  );
  const code = page.locator(".monaco-editor").getByRole("textbox").last();
  await code.focus();
  await code.press("ControlOrMeta+End");
  await code.press("Enter");
  await code.pressSequentially("// user draft");
  await expect(page.getByRole("tab").first().locator("span")).toBeVisible();
  await page.evaluate(() =>
    window.__changeFile("export const greeting = 'Second Agent update';\n"),
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "草稿已保留" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "对比磁盘", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__saved.length)).toBe(1);
  expect(await page.evaluate(() => window.__saved[0])).toContain(
    "// user draft",
  );
  await page.screenshot({ path: "test-results/workspace-edit.png" });
});

test("narrow window remains usable and project picker cancellation preserves messages", async ({
  page,
}) => {
  await page.setViewportSize({ width: 920, height: 680 });
  await bootstrap(page);
  await page.locator("textarea").first().fill("保留这条消息");
  await page.locator("textarea").first().press("Enter");
  await expect(
    page.getByRole("log").getByText("保留这条消息", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "yukino", exact: true }).click();
  await expect(
    page.getByRole("log").getByText("保留这条消息", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-narrow.png" });
});

test("provider form collects connection settings without exposing the key", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加服务商", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("Test provider");
  await page
    .getByLabel("API 地址", { exact: true })
    .fill("https://example.com/v1");
  const key = page.getByLabel("API Key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("test-key");
  await page.getByLabel("模型", { exact: true }).fill("test-model");
  await page.getByRole("button", { name: "保存并连接", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__provider?.name))
    .toBe("Test provider");
});

test("command center supports keyboard search and inserts commands without sending", async ({
  page,
}) => {
  await bootstrap(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "命令中心" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("review");
  await expect(dialog.getByRole("option", { name: /review/ })).toBeVisible();
  await page.screenshot({
    path: "test-results/command-center.png",
    animations: "disabled",
  });
  await dialog.getByRole("combobox").press("Enter");
  const input = page.getByRole("textbox", { name: "任务输入" });
  await expect(input).toHaveValue("/review ");
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await page.getByRole("button", { name: "命令中心", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("/review ");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(input).toHaveValue("");
});

test("goal budgets and task dependencies are visible and controllable", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("目标", { exact: true }).fill("完善发布流程");
  await dialog.getByLabel("Token 预算").fill("40000");
  await dialog.getByRole("button", { name: "开始", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe("/goal --budget 40000 完善发布流程");
  await page.evaluate(() => {
    window.__runtime.goal = {
      objective: "完善发布流程",
      status: "active",
      tokenBudget: 40000,
      tokensUsed: 12000,
      turnsExecuted: 3,
      activeMs: 120000,
      blockedAttempts: 0,
      lastBlockReason: null,
    };
    window.__runtime.tasks[0].blockedBy = ["2"];
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  await expect(
    dialog.getByRole("progressbar", { name: "目标预算用量" }),
  ).toHaveAttribute("value", "12000");
  await dialog.getByText("完善工作区交互", { exact: true }).click();
  await expect(dialog.getByText("前置任务 · 2")).toBeVisible();
  await page.screenshot({ path: "test-results/agent-tasks.png" });
  await dialog.getByRole("button", { name: "暂停目标", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "pause_goal" });
  await expect(dialog.getByRole("button", { name: "清除目标" })).toBeDisabled();
});

test("background work and workflow phases expose live status and cancellation", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.__runtime.subagents = [
      {
        id: "a",
        role: "reviewer",
        background: true,
        status: "running",
        tools: 4,
        turns: 2,
        activity: "Read",
      },
    ];
    window.__runtime.backgroundTasks = [
      {
        id: "bg",
        name: "运行构建",
        kind: "shell",
        status: "running",
        startedAt: Date.now(),
        output: "build succeeded",
      },
    ];
    window.__runtime.teammates = [
      {
        name: "tester",
        teamName: "release",
        status: "running",
        progress: { turnCount: 2, toolUseCount: 3, tokenCount: 1000 },
        lastMessage: "验证完成",
      },
    ];
    window.__runtime.workflows = [
      {
        runId: "wf",
        workflowName: "release",
        status: "running",
        phases: [
          { title: "检查", status: "done" },
          { title: "构建", status: "running" },
        ],
        agents: [],
        logs: ["start release"],
      },
    ];
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Agent 与协作", exact: true }).click();
  await expect(dialog.getByText("reviewer", { exact: true })).toBeVisible();
  await dialog.getByText("查看输出", { exact: true }).click();
  await expect(dialog.getByText("build succeeded")).toBeVisible();
  await dialog
    .getByRole("button", { name: "停止 运行构建", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "stop_task", id: "bg" });
  await dialog
    .getByRole("button", { name: "停止 tester", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "stop_teammate", team: "release", name: "tester" });
  await dialog.getByRole("tab", { name: "工作流", exact: true }).click();
  await expect(dialog.getByText("检查", { exact: true })).toBeVisible();
  await expect(dialog.getByText("构建", { exact: true })).toBeVisible();
  await dialog.getByText("运行日志", { exact: true }).click();
  await expect(dialog.getByText("start release")).toBeVisible();
  await page.screenshot({ path: "test-results/agent-workflows.png" });
});

test("capabilities search, memory inspection and environment controls round-trip", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.__runtime.memories = [
      {
        name: "项目约定",
        description: "使用 pnpm",
        type: "project",
        content: "pnpm happy:fix",
      },
    ];
    window.__emit({
      type: "tool_result",
      data: {
        toolId: "memory",
        toolName: "Read",
        output: "",
        isError: false,
        elapsed: 1,
      },
    });
  });
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "工具与技能", exact: true }).click();
  await dialog.getByLabel("搜索能力").fill("读取");
  await expect(dialog.locator("summary")).toHaveCount(1);
  await dialog.locator("summary").click();
  await expect(dialog.getByText("读取项目文件", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "重新加载技能" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "reload_skills" });
  await dialog.getByRole("tab", { name: "上下文与环境", exact: true }).click();
  await dialog.getByText("项目约定", { exact: true }).click();
  await expect(
    dialog.getByText("pnpm happy:fix", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "沙箱模式" }).click();
  await page
    .getByRole("option", { name: "沙箱内自动授权", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "sandbox", mode: "auto" });
  await dialog.getByRole("button", { name: "重新连接 MCP" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "reload_mcp" });
});

test("checkpoint restoration requires a scope and explicit confirmation", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.__runtime.checkpoints = [
      {
        id: "snapshot",
        text: "调整布局前",
        timestamp: new Date().toISOString(),
        files: 2,
      },
    ];
    window.api.rewind = async (id, mode) => {
      window.__rewind = { id, mode };
    };
    window.__emit({ type: "run_state", data: { streaming: false } });
  });
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "检查点", exact: true }).click();
  await expect(dialog.getByText("调整布局前")).toBeVisible();
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  expect(await page.evaluate(() => window.__rewind)).toBeUndefined();
  await dialog.getByRole("combobox", { name: "恢复范围" }).click();
  await page
    .getByRole("option", { name: "恢复文件与对话", exact: true })
    .click();
  await dialog.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__rewind))
    .toEqual({ id: "snapshot", mode: "code_and_conversation" });
});

test("empty conversations have no templates and attachments preserve intent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 920, height: 680 });
  await bootstrap(page);
  await expect(
    page.getByRole("button", { name: /了解项目|实现功能|审查变更|排查问题/ }),
  ).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "任务输入" });
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await input.fill("读取图片");
  await page
    .getByRole("button", { name: "添加文件或图片", exact: true })
    .click();
  await expect(page.getByText("image.png", { exact: true })).toBeVisible();
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe('读取图片\n@"/project/image.png"');
  await expect(page.getByText("image.png", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "显示会话", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "会话导航" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "关闭会话导航", exact: true })
    .click({ position: { x: 500, y: 200 } });
  await expect(
    page.getByRole("complementary", { name: "会话导航" }),
  ).toBeHidden();
});

test("permissions, questions and plan approval keep the Agent event flow intact", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.api.respondPermission = async (id, response) => {
      window.__permission = { id, response };
      window.__emit({ type: "permission_resolved", data: { id, response } });
    };
    window.api.respondAsk = async (id, answers) => {
      window.__answers = answers;
      window.__emit({ type: "ask_resolved", data: { id } });
    };
    window.api.respondPlan = async (id, choice, feedback) => {
      window.__plan = { id, choice, feedback };
      window.__emit({ type: "plan_approval", data: null });
    };
    window.__emit({ type: "run_state", data: { streaming: true } });
    window.__emit({
      type: "permission_request",
      data: {
        id: "permission",
        toolCallId: "edit",
        toolName: "Edit",
        args: { file_path: "hello.ts" },
        reason: "修改项目文件",
      },
    });
  });
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__permission))
    .toEqual({ id: "permission", response: "allow" });
  await expect(
    page.getByRole("log").getByText("等待授权", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__emit({
      type: "ask_request",
      data: {
        id: "ask",
        questions: [
          {
            question: "选择测试范围",
            multiSelect: false,
            options: [{ label: "完整验证" }, { label: "仅构建" }],
          },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "完整验证", exact: true }).click();
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__answers))
    .toEqual({ 选择测试范围: "完整验证" });
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: false } });
    window.__emit({
      type: "plan_approval",
      data: {
        id: "plan",
        path: "plan.md",
        content: "## 实施步骤\n\n1. 修改界面\n2. 运行验证",
      },
    });
  });
  const plan = page.getByRole("dialog", { name: "执行计划" });
  await expect(plan.getByText("实施步骤")).toBeVisible();
  await plan.getByLabel("计划修改意见").fill("增加键盘交互验证");
  await plan.getByRole("button", { name: "修改计划", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__plan))
    .toEqual({ id: "plan", choice: "feedback", feedback: "增加键盘交互验证" });
  await expect(plan).toBeHidden();
});

test("runtime refresh failures remain recoverable", async ({ page }) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("完善工作区交互", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.api.getRuntime = async () => {
      throw new Error("运行状态读取失败");
    };
  });
  await dialog.getByRole("button", { name: "刷新能力", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("运行状态读取失败");
  await page.evaluate(() => {
    window.api.getRuntime = async () => structuredClone(window.__runtime);
  });
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("stream batches preserve text around tool boundaries and support reply copying", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await bootstrap(page);
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: true } });
    window.__emit({ type: "stream_text", data: { text: "第一" } });
    window.__emit({ type: "stream_text", data: { text: "条回复" } });
    window.__emit({
      type: "tool_use",
      data: {
        toolId: "read",
        toolName: "Read",
        args: { file_path: "hello.ts" },
      },
    });
    window.__emit({
      type: "tool_result",
      data: {
        toolId: "read",
        toolName: "Read",
        output: "file read",
        isError: false,
        elapsed: 0.1,
      },
    });
    window.__emit({ type: "stream_text", data: { text: "第二条回复" } });
    window.__emit({ type: "turn_complete" });
    window.__emit({ type: "run_state", data: { streaming: false } });
  });
  const log = page.getByRole("log");
  await expect(log.getByText("第一条回复", { exact: true })).toBeVisible();
  await expect(log.getByText("第二条回复", { exact: true })).toBeVisible();
  await expect(
    log.getByRole("button", { name: "复制回复", exact: true }),
  ).toHaveCount(2);
  await log
    .getByRole("button", { name: "复制回复", exact: true })
    .last()
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("第二条回复");
  await expect(
    page.getByRole("button", { name: "停止任务", exact: true }),
  ).toHaveCount(0);
});

test("permission modes use a themed keyboard accessible select", async ({
  page,
}) => {
  await bootstrap(page);
  const mode = page.getByRole("combobox", { name: "Agent 权限模式" });
  await mode.click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.screenshot({
    path: "test-results/permission-modes.png",
    animations: "disabled",
  });
  await page.getByRole("option", { name: "允许所有工具", exact: true }).click();
  await expect(mode).toContainText("允许所有工具");
  expect(await page.evaluate(() => window.__permissionMode)).toBe(
    "bypassPermissions",
  );
  await mode.focus();
  await mode.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode).toBeFocused();
  await page.evaluate(() =>
    window.__emit({ type: "run_state", data: { streaming: true } }),
  );
  await expect(mode).toBeDisabled();
  await expect(page.locator("select:visible")).toHaveCount(0);
});

test("full command lists keep the search visible and align long results within small windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 540 });
  await bootstrap(page);
  await page.evaluate(() => {
    window.api.listCommands = async () =>
      Array.from({ length: 50 }, (_, index) => ({
        name: `command-${index}`,
        description: "long-description-".repeat(35),
        type: "prompt",
        isSkill: false,
      }));
  });
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "命令中心" });
  const search = dialog.getByRole("combobox");
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("option")).toHaveCount(55);
  const bounds = await dialog.boundingBox();
  const inputBounds = await search.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(540);
  expect(inputBounds.y).toBeGreaterThan(bounds.y);
  expect(inputBounds.width).toBeGreaterThan(300);
  expect(
    await dialog
      .locator("[cmdk-list]")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const firstResult = dialog.getByRole("option").nth(5);
  const row = await firstResult.boundingBox();
  const arrow = await firstResult.locator("svg").last().boundingBox();
  expect(row.x + row.width - arrow.x - arrow.width).toBeLessThan(20);
  await page.screenshot({
    path: "test-results/command-full.png",
    animations: "disabled",
  });
  await search.fill("没有此项");
  await expect(dialog.getByText("没有匹配的操作")).toBeVisible();
  await search.fill("command-49");
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: "任务输入" })).toHaveValue(
    "/command-49 ",
  );
});

test("missing projects have concise recovery, bounded details and a working retry", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    for (let index = 0; index < 3; index++)
      window.__emit({
        type: "init_state",
        data: {
          ok: false,
          kind: "project",
          error: "项目文件夹已移动或删除，请重新选择项目。",
          details:
            "/private/var/folders/" +
            "TestExecutorContextMappingPersistence".repeat(60),
        },
      });
  });
  await expect(
    page.getByRole("heading", { name: "项目无法打开" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择项目", exact: true }),
  ).toBeEnabled();
  const recovery = page
    .getByRole("heading", { name: "项目无法打开" })
    .locator("..");
  await expect(recovery.locator("pre")).toBeHidden();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(recovery.locator("pre")).toBeVisible();
  expect(
    await recovery.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/project-recovery.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务输入" })).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
});

test("code and inline diffs keep one line-number gutter and slim themed scrollbars", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await bootstrap(page);
  await page.evaluate(() => {
    const baseline = Array.from(
      { length: 160 },
      (_, index) => `export const value${index} = ${index};`,
    ).join("\n");
    window.api.workspaceRead = async () => ({
      path: "hello.ts",
      content: baseline.replace("value30 = 30", "value30 = 300"),
      baseline,
      revision: "long",
      deleted: false,
    });
  });
  await page.getByRole("button", { name: "hello.ts M" }).click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  await expect(
    page
      .locator(".margin-view-overlays .line-numbers")
      .filter({ hasText: /^1$/ }),
  ).toHaveCount(1);
  await editor.hover();
  const scrollbar = editor.locator(".scrollbar.vertical").first();
  await expect.poll(async () => (await scrollbar.boundingBox())?.width).toBe(8);
  const slider = scrollbar.locator(".slider");
  await expect(slider).toHaveCSS("border-radius", "6px");
  await page.screenshot({
    path: "test-results/editor-code.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "变更对比", exact: true }).click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await expect(
    page
      .locator(
        ".modified-in-monaco-diff-editor .margin-view-overlays .line-numbers",
      )
      .filter({ hasText: /^1$/ }),
  ).toHaveCount(1);
  await expect(page.locator(".monaco-diff-editor .editor.original")).toHaveCSS(
    "width",
    "0px",
  );
  await expect(page.locator(".diffOverview")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/editor-diff.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "变更对比", exact: true }).click();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});
