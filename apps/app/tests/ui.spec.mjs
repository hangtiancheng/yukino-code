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
        { name: "review", description: "检查代码变更", type: "prompt" },
        { name: "goal", description: "持续目标", type: "prompt" },
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
      getRuntime: async () => ({
        tools: ["Read", "Edit", "Write", "Bash", "Agent", "Workflow"],
        skills: [{ name: "review", description: "审查代码" }],
        memories: [],
        mcpServers: ["local"],
        tasks: [
          { id: "task", subject: "完善工作区交互", status: "in_progress" },
        ],
        backgroundTasks: [],
        teammates: [],
        checkpoints: [],
        permissionMode: "default",
      }),
      requestMcpApp: async () => ({}),
      respondPlan: async () => {},
      respondAsk: async () => {},
      respondPermission: async () => {},
      setPermissionMode: async () => {},
      openConfig: async () => {},
    };
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "了解项目", exact: true }),
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
  await page.getByRole("button", { name: "代码", exact: true }).first().click();
  await expect(page.locator(".workspace-editor")).toBeHidden();
  await page.getByRole("button", { name: "代码", exact: true }).first().click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const separator = page.getByRole("separator", { name: "调整代码工作区宽度" });
  await separator.focus();
  await separator.press("ArrowLeft");
  const beforeExpand = await page
    .locator(".workspace-editor")
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("button", { name: "展开编辑器", exact: true }).click();
  await expect(page.locator(".conversation")).toBeHidden();
  await page.getByRole("button", { name: "恢复分栏", exact: true }).click();
  await expect(page.locator(".conversation")).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs(
        (await page
          .locator(".workspace-editor")
          .evaluate((element) => element.getBoundingClientRect().width)) -
          beforeExpand,
      ),
    )
    .toBeLessThan(12);
  await page.getByRole("button", { name: "切换深色主题" }).click();
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
  await expect(page.getByText("完善工作区交互")).toBeVisible();
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
  const code = page.locator(".monaco-diff-editor").getByRole("textbox").last();
  await code.focus();
  await code.press("ControlOrMeta+End");
  await code.press("Enter");
  await code.pressSequentially("// user draft");
  await expect(page.locator(".dirty-dot")).toBeVisible();
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
  await expect(page.getByText("保留这条消息", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "yukino", exact: true }).click();
  await expect(page.getByText("保留这条消息", { exact: true })).toBeVisible();
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
