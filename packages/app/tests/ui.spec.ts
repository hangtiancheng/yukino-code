import assert from "node:assert/strict";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  BridgeEvent,
  InitState,
  SettingsSnapshot,
} from "@shared/ipc-types.ts";
import type { FileSnapshot } from "@shared/workspace-types.ts";

async function bootstrap(
  page: Page,
  initialTheme: "light" | "dark" | "system" = "light",
): Promise<void> {
  await page.addInitScript((initialTheme) => {
    const preferences: SettingsSnapshot["preferences"] = {
      values: {
        theme: initialTheme === "system" ? "auto" : initialTheme,
        code_mode: { mode: "off" as const, inline_budget: 12000 },
        display: {
          show_thinking: true,
          expanded_tools: false,
          editor_padding: 1,
          output_padding: 1,
          autocomplete_max_visible: 8,
        },
        auto_compaction: true,
        auto_retry: true,
        steering_mode: "all" as const,
        follow_up_mode: "one-at-a-time" as const,
      },
      sources: [],
    };
    const listeners = new Set<(event: BridgeEvent) => void>();
    let appearance: { mode: "system" | "light" | "dark"; dark: boolean } = {
      mode: initialTheme,
      dark:
        initialTheme === "dark" ||
        (initialTheme === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches),
    };
    const themeListeners = new Set<(theme: "light" | "dark") => void>();
    const emit = (event: BridgeEvent): void => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    let content = "export const greeting = 'Hello Yukino';\n";
    let revision = 1;
    const initial: InitState & { ok: true } = {
      ok: true,
      cwd: "/project/yukino",
      projectKey: "project",
      providerName: "Local test",
      model: "test-model",
      sessionId: "session",
      permissionMode: "default",
      contextWindow: 128_000,
      thinkingLevel: "high",
    };
    const file = (): FileSnapshot => ({
      path: "hello.ts",
      content,
      baseline: "export const greeting = 'Hello';\n",
      revision: String(revision),
      deleted: false,
    });
    window.__emit = emit;
    window.__changeFile = (text: string): void => {
      content = text;
      revision++;
      emit({
        type: "workspace_changed",
        data: { cwd: initial.cwd, path: "hello.ts" },
      });
    };
    window.__saved = [];
    window.__runtime = {
      tools: ["ReadFile", "EditFile", "WriteFile", "Bash", "Agent", "Workflow"],
      toolDescriptions: {
        ReadFile: "Read project files",
        EditFile: "Edit project files",
      },
      skills: [{ name: "review", description: "Review code changes" }],
      memories: [],
      mcpServers: ["local"],
      tasks: [
        {
          id: "1",
          subject: "Refine workspace interactions",
          status: "in_progress",
          description: "Handle input and workspace layout",
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
      reloadResources: async () => undefined,
      setPreferences: async (patch) => {
        Object.assign(preferences.values, {
          ...patch,
          display: { ...preferences.values.display, ...patch.display },
          code_mode: { ...preferences.values.code_mode, ...patch.code_mode },
        });
        emit({ type: "preferences", data: preferences });
        return window.api.getSettings();
      },
      transferSession: async () => true,
      controlAgent: async (action) => {
        window.__control = action;
      },
      cancelQueuedMessage: async () => "Recovered message",
      getAgentState: async () => ({
        sessionId: "session",
        busy: false,
        metadata: {},
        entries: [],
        queue: [],
        queueModes: { steering: "all", followUp: "one-at-a-time" },
        retry: null,
        status: {
          observedAt: Date.now(),
          sessionId: "session",
          model: "test-model",
          contextWindow: 128000,
          request: null,
          run: null,
          session: null,
          history: [],
          cache: {
            policy: { mode: "off", bestEffort: true },
            warmingMode: "off",
            warming: { state: "off" },
          },
        },
        stats: {
          requests: 0,
          attempts: 0,
          incompleteAttempts: 0,
          usage: {},
          estimated: {},
          providerReported: {},
          unknownCurrencyEstimates: 0,
          unknownProviderAmounts: 0,
        },
        attempts: [],
        codeMode: { activeToolCallIds: [], foregroundToolsRunning: false },
        mcp: { connectedServers: [], servers: [] },
        sources: [],
        preferences,
      }),
      init: async () => {
        emit({ type: "init_state", data: initial });
        return initial;
      },
      getTheme: async () => appearance,
      onTheme: (listener) => {
        themeListeners.add(listener);
        return () => {
          themeListeners.delete(listener);
        };
      },
      setTheme: async (mode) => {
        appearance = {
          mode,
          dark:
            mode === "dark" ||
            (mode === "system" &&
              window.matchMedia("(prefers-color-scheme: dark)").matches),
        };
        preferences.values.theme = mode === "system" ? "auto" : mode;
        emit({ type: "preferences", data: preferences });
        for (const listener of themeListeners) {
          listener(appearance.dark ? "dark" : "light");
        }
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      listSessions: async () => [
        {
          id: "session",
          firstMessage: "Build the Yukino desktop workspace",
          archived: false,
          tags: ["desktop"],
          cwd: initial.cwd,
          projectKey: "project",
          messageCount: 4,
          modTime: Date.now(),
          lastUserMessageTime: Date.now(),
        },
        {
          id: "archived",
          firstMessage: "An archived release",
          archived: true,
          tags: ["retired"],
          cwd: initial.cwd,
          projectKey: "project",
          messageCount: 1,
          modTime: Date.now(),
          lastUserMessageTime: Date.now(),
        },
      ],
      listCommands: async () => [
        {
          name: "review",
          description: "Review code changes",
          type: "prompt",
          isSkill: false,
        },
        {
          name: "goal",
          description: "Persistent goal",
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
      workspaceSave: async (_path, text, expected) => {
        if (String(revision) !== expected) {
          throw new Error("The file was modified by the agent");
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
        emit({ type: "user_input", data: { id: crypto.randomUUID(), text } });
      },
      abort: async () => {
        emit({ type: "run_state", data: { streaming: false } });
      },
      selectAttachments: async () => ["/project/image.png"],
      pasteImage: async () => "/project/clipboard.png",
      saveProvider: async (input) => {
        window.__provider = input;
      },
      getSettings: async () => ({
        preferences,
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
      respondPlan: async () => undefined,
      respondAsk: async () => undefined,
      respondPermission: async () => undefined,
      setPermissionMode: async (mode) => {
        initial.permissionMode = mode;
        window.__permissionMode = mode;
        emit({ type: "init_state", data: { ...initial } });
      },
      openConfig: async () => undefined,
      openLogs: async () => undefined,
      rewind: async () => undefined,
      resumeSession: async () => ({ sessionId: "new", messages: [] }),
      listModels: async () => ({
        status: "ready",
        models: [],
        current: "test-model",
      }),
      setProvider: async () => undefined,
      setModel: async () => undefined,
      setThinkingLevel: async () => undefined,
    };
  }, initialTheme);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("textbox", { name: "Task input", exact: true }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(region: Locator): Promise<void> {
  await expect
    .poll(() =>
      region.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
}

for (const width of [1480, 880, 560]) {
  test(`English workbench navigation and long content fit a ${width}px window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await bootstrap(page);
    await page.evaluate(() => {
      const name = "workspace-orchestration-".repeat(8);
      window.__runtime.tasks[0].subject = name;
      window.__runtime.skills = [{ name, description: name }];
      window.__runtime.activeSkills = [name];
      window.__runtime.tools = [name];
      window.__runtime.toolDescriptions = { [name]: name };
      window.__runtime.mcpServers = [name];
      window.__runtime.memories = [
        { name, description: name, type: "project", content: name },
      ];
      window.__runtime.namedWorkflows = [name];
      window.__runtime.subagents = [
        {
          id: "agent",
          role: name,
          background: true,
          status: "running",
          tools: 4,
          turns: 2,
          activity: name,
        },
      ];
      window.__runtime.checkpoints = [
        {
          id: "checkpoint",
          text: name,
          timestamp: new Date().toISOString(),
          files: 2,
        },
      ];
    });
    await page
      .getByRole("button", { name: "Agent workbench", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Agent workbench" });
    const navigation = dialog.getByRole("tablist");
    await expectNoHorizontalOverflow(navigation);
    for (const name of [
      "Goals & tasks",
      "Agents",
      "Workflows",
      "Tools & skills",
      "Context",
      "Checkpoints",
    ]) {
      const tab = navigation.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectNoHorizontalOverflow(dialog.getByRole("tabpanel"));
      await expectNoHorizontalOverflow(dialog);
    }
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Restore scope" }).click();
    await page
      .getByRole("option", { name: "Files and conversation", exact: true })
      .click();
    await expectNoHorizontalOverflow(dialog.getByRole("tabpanel"));
    const bounds = await dialog.boundingBox();
    assert.ok(bounds);
    expect(bounds.x).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 16);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
    await page.screenshot({
      path: `test-results/workbench-english-${width}.png`,
      animations: "disabled",
    });
    await navigation
      .getByRole("tab", { name: "Goals & tasks", exact: true })
      .focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      navigation.getByRole("tab", { name: "Agents", exact: true }),
    ).toBeFocused();
  });
}

test("long English labels, settings and questions fit the smallest split workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 880, height: 540 });
  await bootstrap(page);
  await page.evaluate(async () => {
    const name = "development-workspace-".repeat(8);
    window.__emit({
      type: "init_state",
      data: {
        ok: true,
        cwd: "/project/yukino",
        projectKey: "project",
        providerName: name,
        model: name,
        sessionId: "session",
        permissionMode: "default",
        contextWindow: 128_000,
        thinkingLevel: "high",
      },
    });
    window.__emit({
      type: "usage",
      data: { inputTokens: 123456, outputTokens: 9876 },
    });
    const preferences = (await window.api.getSettings()).preferences;
    window.api.getSettings = async () => ({
      preferences,
      providers: [
        { name, protocol: "openai", baseUrl: "http://localhost", model: name },
      ],
      currentProvider: 0,
      model: name,
      thinkingLevel: "high",
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
    });
    window.api.listModels = async () => ({
      status: "ready",
      current: name,
      models: [{ id: name, name: "Long model display name ".repeat(8) }],
    });
  });
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const separator = page.getByRole("separator", {
    name: "Resize code workspace",
  });
  const bounds = await separator.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(325, bounds.y + 100);
  await page.mouse.up();
  const main = page.getByRole("main");
  await expectNoHorizontalOverflow(main);
  await page.getByRole("button", { name: "hello.ts M" }).click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "Compare changes", exact: true })
    .click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Task input" });
  await page.evaluate(() => {
    window.api.listCommands = async () => [
      {
        name: "workspace-verification-".repeat(8),
        description: "Verify every changed package before continuing ".repeat(
          4,
        ),
        type: "prompt",
        isSkill: false,
      },
    ];
  });
  await input.fill("/");
  const command = page.getByRole("option", { name: /workspace-verification-/ });
  await expect(command).toBeVisible();
  await expectNoHorizontalOverflow(command);
  await input.fill("A long session title ".repeat(20));
  await input.press("Enter");
  await expectNoHorizontalOverflow(page.locator("header"));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings
    .getByRole("button", { name: "Load models", exact: true })
    .click();
  await expect(
    settings.getByTitle("Long model display name ".repeat(8)),
  ).toBeAttached();
  await expectNoHorizontalOverflow(settings);
  await page.screenshot({
    path: "test-results/settings-english.png",
    animations: "disabled",
  });
  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Protocol", exact: true })
    .click();
  await page
    .getByRole("option", { name: "OpenAI Chat Completions", exact: true })
    .click();
  await expectNoHorizontalOverflow(settings);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.__emit({
      type: "ask_request",
      data: {
        id: "long-question",
        questions: [
          {
            question:
              "How should changes across the workspace be verified before the next release?",
            multiSelect: false,
            options: [
              {
                label:
                  "Run the complete workspace verification before continuing",
                description:
                  "Check formatting, types, the build, and all relevant tests for every changed package.",
              },
            ],
          },
        ],
      },
    });
  });
  const option = page.getByRole("button", {
    name: /Run the complete workspace verification/,
  });
  await option.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(option);
  expect(
    await option.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeLessThanOrEqual(1);
  await option.click();
  await expect(
    page.getByRole("button", { name: "Submit answer", exact: true }),
  ).toBeEnabled();
  await expectNoHorizontalOverflow(main);
  await page.screenshot({
    path: "test-results/split-english.png",
    animations: "disabled",
  });
  const split = await separator.boundingBox();
  assert.ok(split);
  await page.mouse.move(split.x + split.width / 2, split.y + 100);
  await page.mouse.down();
  await page.mouse.move(550, split.y + 100);
  await page.mouse.up();
  const editor = page.getByRole("region", { name: "Files", exact: true });
  const editorBounds = await editor.boundingBox();
  const compareBounds = await page
    .getByRole("button", { name: "Compare changes", exact: true })
    .boundingBox();
  assert.ok(editorBounds);
  assert.ok(compareBounds);
  expect(editorBounds.width).toBeLessThan(400);
  expect(compareBounds.x).toBeGreaterThan(editorBounds.x);
  expect(compareBounds.x + compareBounds.width).toBeLessThanOrEqual(
    editorBounds.x + editorBounds.width,
  );
  await page
    .getByRole("button", { name: "Compare changes", exact: true })
    .click();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/editor-narrow.png",
    animations: "disabled",
  });
});

test("composer stays compact and only offers delivery while drafting during a run", async ({
  page,
}) => {
  await bootstrap(page);
  const input = page.getByRole("textbox", { name: "Task input" });
  const composer = input.locator("..").locator("..");
  const delivery = page.getByRole("combobox", { name: "Message delivery" });
  const initial = await composer.boundingBox();
  assert.ok(initial);
  expect(
    await input.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingTop),
    ),
  ).toBeLessThanOrEqual(8);
  await input.fill("Normal message");
  await input.press("Enter");
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await expect(delivery).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop task", exact: true }),
  ).toBeVisible();
  await input.fill("Adjust the current task");
  await expect(delivery).toBeVisible();
  const drafting = await composer.boundingBox();
  assert.ok(drafting);
  expect(Math.abs(drafting.height - initial.height)).toBeLessThanOrEqual(2);
  await delivery.click();
  await page
    .getByRole("option", { name: "Queue follow-up", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/composer-delivery.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Follow up", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(delivery).toHaveCount(0);
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: false } });
  });
  await input.fill("Another normal message");
  await expect(delivery).toHaveCount(0);
});

test("workspace layout, commands, IME composition and collapsed drafts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bootstrap(page);
  await page.screenshot({ path: "test-results/workspace-light.png" });
  await page.getByRole("button", { name: "hello.ts M" }).click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.waitForTimeout(800);
  const editorRegion = page.getByRole("region", { name: "Files", exact: true });
  await page.getByRole("button", { name: "Code", exact: true }).first().click();
  await expect(editorRegion).toBeHidden();
  await page.getByRole("button", { name: "Code", exact: true }).first().click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const separator = page.getByRole("separator", {
    name: "Resize code workspace",
  });
  await separator.focus();
  await separator.press("ArrowLeft");
  const beforeExpand = await editorRegion.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await page
    .getByRole("button", { name: "Expand editor", exact: true })
    .click();
  await expect(page.getByRole("main")).toBeHidden();
  await page
    .getByRole("button", { name: "Restore split", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({
    path: "test-results/settings-light.png",
    animations: "disabled",
  });
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Mocha · Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: "test-results/workspace-dark.png",
    animations: "disabled",
  });
  const input = page.locator("textarea").first();
  await input.fill("Composed input");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe("Composed input");
  await input.fill("/rev");
  await expect(page.getByRole("option", { name: /review/ })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("/review ");
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Refine workspace interactions"),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("live Agent changes preserve dirty drafts and require conflict review", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "hello.ts M" }).click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.evaluate(() => {
    window.__changeFile("export const greeting = 'Agent updated';\n");
  });
  await expect(page.locator(".view-lines").last()).toContainText(
    "Agent updated",
  );
  const code = page.locator(".monaco-editor").getByRole("textbox").last();
  await code.focus();
  await code.press("ControlOrMeta+End");
  await code.press("Enter");
  await code.pressSequentially("// user draft");
  await expect(
    page.getByRole("tab").first().getByRole("img", { name: "Unsaved changes" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__changeFile("export const greeting = 'Second Agent update';\n");
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "draft was preserved" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Compare with disk", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
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
  await page.locator("textarea").first().fill("Keep this message");
  await page.locator("textarea").first().press("Enter");
  await expect(
    page.getByRole("log").getByText("Keep this message", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "yukino", exact: true }).click();
  await expect(
    page.getByRole("log").getByText("Keep this message", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-narrow.png" });
});

test("provider form collects connection settings without exposing the key", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Test provider");
  await page
    .getByLabel("API URL", { exact: true })
    .fill("https://example.com/v1");
  const key = page.getByLabel("API Key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("test-key");
  await page.getByLabel("Model", { exact: true }).fill("test-model");
  await page
    .getByRole("button", { name: "Save and connect", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__provider?.name))
    .toBe("Test provider");
});

test("command center supports keyboard search and inserts commands without sending", async ({
  page,
}) => {
  await bootstrap(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Command center" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("review");
  await expect(dialog.getByRole("option", { name: /review/ })).toBeVisible();
  await page.screenshot({
    path: "test-results/command-center.png",
    animations: "disabled",
  });
  await dialog.getByRole("combobox").press("Enter");
  const input = page.getByRole("textbox", { name: "Task input" });
  await expect(input).toHaveValue("/review ");
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await page
    .getByRole("button", { name: "Command center", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("/review ");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(input).toHaveValue("");
});

test("goal budgets and task dependencies are visible and controllable", async ({
  page,
}) => {
  await bootstrap(page);
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Goals & tasks" }).click();
  await dialog
    .getByLabel("Goal", { exact: true })
    .fill("Refine the release process");
  await dialog.getByLabel("Token budget").fill("40000");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe("/goal --budget 40000 Refine the release process");
  await page.evaluate(() => {
    window.__runtime.goal = {
      objective: "Refine the release process",
      status: "active",
      tokenBudget: 40_000,
      tokensUsed: 12_000,
      turnsExecuted: 3,
      activeMs: 120_000,
      blockedAttempts: 0,
      lastBlockReason: null,
      lastBlockedTurn: null,
      budgetSummaryPending: false,
    };
    window.__runtime.tasks[0].blockedBy = ["2"];
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "Goals & tasks" }).click();
  await expect(
    dialog.getByRole("progressbar", { name: "Goal budget usage" }),
  ).toHaveAttribute("value", "12000");
  await dialog
    .getByText("Refine workspace interactions", { exact: true })
    .click();
  await expect(dialog.getByText("Blocked by · 2")).toBeVisible();
  await page.screenshot({ path: "test-results/agent-tasks.png" });
  await dialog.getByRole("button", { name: "Pause goal", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "pause_goal" });
  await expect(
    dialog.getByRole("button", { name: "Clear goal" }),
  ).toBeDisabled();
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
        activity: "ReadFile",
      },
    ];
    window.__runtime.backgroundTasks = [
      {
        id: "bg",
        name: "Run build",
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
        startTime: Date.now(),
        spinnerVerb: "Testing",
        progress: {
          turnCount: 2,
          toolUseCount: 3,
          tokenCount: 1000,
          activeTools: [],
          recentActivities: [],
        },
        lastMessage: "Verification complete",
      },
    ];
    window.__runtime.workflows = [
      {
        runId: "wf",
        taskId: "workflow-task",
        scriptPath: "/project/yukino/release.ts",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        workflowName: "release",
        status: "running",
        phases: [
          { title: "Check", status: "done" },
          { title: "Build", status: "running" },
        ],
        agents: [],
        logs: ["start release"],
      },
    ];
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(dialog.getByText("reviewer", { exact: true })).toBeVisible();
  await dialog.getByText("View output", { exact: true }).click();
  await expect(dialog.getByText("build succeeded")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Stop Run build", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "stop_task", id: "bg" });
  await dialog
    .getByRole("button", { name: "Stop tester", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "stop_teammate", team: "release", name: "tester" });
  await dialog.getByRole("tab", { name: "Workflows", exact: true }).click();
  await expect(dialog.getByText("Check", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Build", { exact: true })).toBeVisible();
  await dialog.getByText("Run logs", { exact: true }).click();
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
        name: "Project conventions",
        description: "Use pnpm",
        type: "project",
        content: "pnpm happy:fix",
      },
    ];
    window.__emit({
      type: "tool_result",
      data: {
        toolId: "memory",
        toolName: "ReadFile",
        output: "",
        isError: false,
        elapsed: 1,
      },
    });
  });
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("tab", { name: "Tools & skills", exact: true })
    .click();
  await dialog.getByLabel("Search capabilities").fill("read");
  await expect(dialog.locator("summary")).toHaveCount(1);
  await dialog.locator("summary").click();
  await expect(
    dialog.getByText("Read project files", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Reload skills" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "reload_skills" });
  await dialog.getByRole("tab", { name: "Context", exact: true }).click();
  await dialog.getByText("Project conventions", { exact: true }).click();
  await expect(
    dialog.getByText("pnpm happy:fix", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Sandbox mode" }).click();
  await page.getByRole("option", { name: "Auto-allow", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__action))
    .toEqual({ type: "sandbox", mode: "auto" });
  await dialog.getByRole("button", { name: "Reconnect MCP" }).click();
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
        text: "Before layout changes",
        timestamp: new Date().toISOString(),
        files: 2,
      },
    ];
    window.api.rewind = async (id, mode) => {
      window.__rewind = { id, mode };
    };
    window.__emit({ type: "run_state", data: { streaming: false } });
  });
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Checkpoints", exact: true }).click();
  await expect(dialog.getByText("Before layout changes")).toBeVisible();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  expect(await page.evaluate(() => window.__rewind)).toBeUndefined();
  await dialog.getByRole("combobox", { name: "Restore scope" }).click();
  await page
    .getByRole("option", { name: "Files and conversation", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Confirm restore", exact: true })
    .click();
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
    page.getByRole("button", {
      name: /Explore the project|Implement a feature|Review changes|Troubleshoot/,
    }),
  ).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Task input" });
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => window.__sent)).toBeUndefined();
  await input.fill("Read image");
  await page
    .getByRole("button", { name: "Add files or images", exact: true })
    .click();
  await expect(page.getByText("image.png", { exact: true })).toBeVisible();
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__sent))
    .toBe('Read image\n@"/project/image.png"');
  await expect(page.getByText("image.png", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Show sessions", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Session navigation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close session navigation", exact: true })
    .click({ position: { x: 500, y: 200 } });
  await expect(
    page.getByRole("complementary", { name: "Session navigation" }),
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
        toolName: "EditFile",
        args: { file_path: "hello.ts" },
        reason: "Edit project files",
      },
    });
  });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__permission))
    .toEqual({ id: "permission", response: "allow" });
  await expect(
    page.getByRole("log").getByText("Needs approval", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__emit({
      type: "ask_request",
      data: {
        id: "ask",
        questions: [
          {
            question: "Choose test scope",
            multiSelect: false,
            options: [{ label: "Full verification" }, { label: "Build only" }],
          },
        ],
      },
    });
  });
  await page
    .getByRole("button", { name: "Full verification", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__answers))
    .toEqual({ "Choose test scope": "Full verification" });
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: false } });
    window.__emit({
      type: "plan_approval",
      data: {
        id: "plan",
        path: "plan.md",
        content:
          "## Implementation steps\n\n1. Update the interface\n2. Run verification",
      },
    });
  });
  const plan = page.getByRole("dialog", { name: "Execute plan" });
  await expect(plan.getByText("Implementation steps")).toBeVisible();
  await plan
    .getByLabel("Plan feedback")
    .fill("Add keyboard interaction verification");
  await plan.getByRole("button", { name: "Revise plan", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__plan))
    .toEqual({
      id: "plan",
      choice: "feedback",
      feedback: "Add keyboard interaction verification",
    });
  await expect(plan).toBeHidden();
});

test("runtime refresh failures remain recoverable", async ({ page }) => {
  await bootstrap(page);
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Refine workspace interactions", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.api.getRuntime = async () => {
      throw new Error("Failed to read runtime state");
    };
  });
  await dialog
    .getByRole("button", { name: "Refresh capabilities", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Failed to read runtime state",
  );
  await page.evaluate(() => {
    window.api.getRuntime = async () => structuredClone(window.__runtime);
  });
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("workbench deep links and the Workflow launcher pass arguments to the SDK", async ({
  page,
}) => {
  await bootstrap(page, "dark");
  await page.evaluate(() => {
    window.__runtime.namedWorkflows = ["release"];
    window.__emit({ type: "open_runtime", page: "workflows" });
  });
  const workbench = page.getByRole("dialog", { name: "Agent workbench" });
  await expect(
    workbench.getByRole("tab", { name: "Workflows" }),
  ).toHaveAttribute("aria-selected", "true");
  await workbench
    .getByRole("textbox", { name: "Workflow arguments (JSON)" })
    .fill("{bad}");
  await workbench.getByRole("button", { name: "Run workflow" }).click();
  await expect(workbench.getByRole("alert")).toContainText("valid JSON");
  await workbench
    .getByRole("textbox", { name: "Workflow arguments (JSON)" })
    .fill('{"build": true}');
  await workbench
    .getByRole("spinbutton", { name: "Workflow concurrency" })
    .fill("2");
  await workbench.getByRole("button", { name: "Run workflow" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__control))
    .toEqual({
      type: "workflow_run",
      input: { name: "release", args: { build: true }, maxConcurrency: 2 },
    });
  await page.screenshot({
    path: "test-results/workbench-mocha.png",
    animations: "disabled",
  });
});

test("queued messages can be recovered without replacing the composer draft", async ({
  page,
}) => {
  await bootstrap(page);
  const input = page.getByRole("textbox", { name: "Task input" });
  await input.fill("Unsent draft");
  await page.evaluate(() => {
    window.api.cancelQueuedMessage = async (id) => {
      if (id !== "queue-1") {
        throw new Error("Wrong queue entry");
      }
      window.__emit({ type: "queue_changed", data: [] });
      return 'Recovered message\n@"/project/image.png"';
    };
    window.__emit({ type: "run_state", data: { streaming: true } });
    window.__emit({
      type: "queue_changed",
      data: [
        {
          id: "queue-1",
          kind: "followUp",
          text: "Recovered message",
          attachmentCount: 1,
          state: "queued",
        },
      ],
    });
  });
  await page.getByRole("button", { name: "Edit queued message" }).click();
  await expect(input).toHaveValue(
    'Unsent draft\n\nRecovered message\n@"/project/image.png"',
  );
  await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(
    0,
  );
});

test("session filters surface archived sessions and match tags", async ({
  page,
}) => {
  await bootstrap(page);
  const sidebar = page.getByRole("complementary", {
    name: "Session navigation",
  });
  await expect(
    sidebar.getByRole("button", { name: /archived release/ }),
  ).toHaveCount(0);
  await sidebar.getByRole("combobox", { name: "Session scope" }).click();
  await page.getByRole("option", { name: "Archived" }).click();
  await sidebar
    .getByRole("textbox", { name: "Search sessions" })
    .fill("retired");
  await expect(
    sidebar.getByRole("button", { name: /archived release/ }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: /Build the Yukino desktop workspace/ }),
  ).toHaveCount(0);
});

test("stream batches preserve text around tool boundaries and support reply copying", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await bootstrap(page);
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: true } });
    window.__emit({ type: "stream_text", data: { text: "First" } });
    window.__emit({ type: "stream_text", data: { text: " reply" } });
    window.__emit({
      type: "tool_use",
      data: {
        toolId: "read",
        toolName: "ReadFile",
        args: { file_path: "hello.ts" },
      },
    });
    window.__emit({
      type: "tool_result",
      data: {
        toolId: "read",
        toolName: "ReadFile",
        output: "file read",
        isError: false,
        elapsed: 0.1,
      },
    });
    window.__emit({ type: "stream_text", data: { text: "Second reply" } });
    window.__emit({ type: "turn_complete" });
    window.__emit({ type: "run_state", data: { streaming: false } });
  });
  const log = page.getByRole("log");
  await expect(log.getByText("First reply", { exact: true })).toBeVisible();
  await expect(log.getByText("Second reply", { exact: true })).toBeVisible();
  await expect(
    log.getByRole("button", { name: "Copy reply", exact: true }),
  ).toHaveCount(2);
  await log
    .getByRole("button", { name: "Copy reply", exact: true })
    .last()
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Second reply");
  await expect(
    page.getByRole("button", { name: "Stop task", exact: true }),
  ).toHaveCount(0);
});

test("permission modes use a themed keyboard accessible select", async ({
  page,
}) => {
  await bootstrap(page);
  const mode = page.getByRole("combobox", { name: "Agent permission mode" });
  await mode.click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.screenshot({
    path: "test-results/permission-modes.png",
    animations: "disabled",
  });
  await page
    .getByRole("option", { name: "Allow all tools", exact: true })
    .click();
  await expect(mode).toContainText("Allow all tools");
  expect(await page.evaluate(() => window.__permissionMode)).toBe(
    "bypassPermissions",
  );
  await mode.focus();
  await mode.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode).toBeFocused();
  await page.evaluate(() => {
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
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
  const dialog = page.getByRole("dialog", { name: "Command center" });
  const search = dialog.getByRole("combobox");
  await expect(search).toBeFocused();
  await expect(
    dialog.getByRole("option", { name: /^\/command-\d+\b/ }),
  ).toHaveCount(50);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds);
  const inputBounds = await search.boundingBox();
  assert.ok(inputBounds);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(540);
  expect(inputBounds.y).toBeGreaterThan(bounds.y);
  expect(inputBounds.width).toBeGreaterThan(300);
  expect(
    await dialog
      .locator("[cmdk-list]")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const firstResult = dialog.getByRole("option", { name: /^\/command-0\b/ });
  const row = await firstResult.boundingBox();
  assert.ok(row);
  const arrow = await firstResult.locator("svg").last().boundingBox();
  assert.ok(arrow);
  expect(row.x + row.width - arrow.x - arrow.width).toBeLessThan(20);
  await page.screenshot({
    path: "test-results/command-full.png",
    animations: "disabled",
  });
  await search.fill("nothing-matches");
  await expect(dialog.getByText("No matching actions")).toBeVisible();
  await search.fill("command-49");
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: "Task input" })).toHaveValue(
    "/command-49 ",
  );
});

test("missing projects have concise recovery, bounded details and a working retry", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    for (let index = 0; index < 3; index++) {
      window.__emit({
        type: "init_state",
        data: {
          ok: false,
          kind: "project",
          error: "The project folder was moved or deleted. Select it again.",
          details:
            "/private/var/folders/" +
            "TestExecutorContextMappingPersistence".repeat(60),
        },
      });
    }
  });
  await expect(
    page.getByRole("heading", { name: "Unable to open project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose project", exact: true }),
  ).toBeEnabled();
  const recovery = page
    .getByRole("heading", { name: "Unable to open project" })
    .locator("..");
  await expect(recovery.locator("pre")).toBeHidden();
  await page.getByRole("button", { name: "View details", exact: true }).click();
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
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Task input" })).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
});

test("the compact Catppuccin explorer resizes by pointer and keyboard", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.api.workspaceList = async (path) =>
      path === "src"
        ? [
            {
              path: "src/component.tsx",
              name: "component.tsx",
              directory: false,
            },
          ]
        : [
            { path: "src", name: "src", directory: true },
            { path: "package.json", name: "package.json", directory: false },
          ];
    window.__emit({
      type: "workspace_changed",
      data: { cwd: "/project/yukino", path: null },
    });
  });
  const explorer = page.getByRole("navigation", { name: "Project files" });
  const separator = page.getByRole("separator", {
    name: "Resize file explorer",
  });
  const width = async (): Promise<number> =>
    (await explorer.boundingBox())?.width ?? 0;
  const original = await width();
  const divider = await separator.boundingBox();
  assert.ok(divider);
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 160);
  await page.mouse.down();
  await page.mouse.move(divider.x + 55, divider.y + 160, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(original + 40);

  const resized = await width();
  await separator.focus();
  await separator.press("ArrowLeft");
  await expect.poll(width).toBeLessThan(resized);

  await explorer.getByRole("button", { name: "Files", exact: true }).click();
  const directory = explorer.getByRole("button", { name: "src", exact: true });
  await directory.click();
  const file = explorer.getByRole("button", {
    name: "component.tsx",
    exact: true,
  });
  await expect(file).toBeVisible();
  expect((await file.boundingBox())?.height).toBe(23);
  await expect(file.locator("use")).toHaveAttribute(
    "href",
    "#catppuccin-typescript-react",
  );
  expect(
    await file
      .locator("use")
      .evaluate((icon: SVGUseElement) => icon.getBBox().width),
  ).toBeGreaterThan(0);
  await expect(directory.locator("use")).toHaveAttribute(
    "href",
    "#catppuccin-folder_src_open",
  );
  await expect(
    explorer.getByRole("button", { name: "package.json" }).locator("use"),
  ).toHaveAttribute("href", "#catppuccin-package-json");

  await explorer.getByRole("button", { name: /Changes/ }).click();
  await explorer.getByRole("button", { name: "Files", exact: true }).click();
  await expect(file).toBeVisible();

  const remembered = await width();
  await page.reload();
  await expect
    .poll(async () => Math.abs((await width()) - remembered))
    .toBeLessThan(2);

  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await page.setViewportSize({ width: 560, height: 640 });
  await expect(page.getByRole("main")).toBeHidden();
  await expect(explorer).toBeVisible();
  await expectNoHorizontalOverflow(
    page.getByRole("region", { name: "Files", exact: true }),
  );
  await page
    .getByRole("button", { name: "Close workspace", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Task input" })).toBeVisible();
});

test("plain-text editing retains draft undo history across tabs and comparison", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bootstrap(page);
  await page.evaluate(() => {
    window.api.workspaceRead = async (path) => ({
      path,
      content: path === "notes.md" ? "Notes" : "const greeting = 'hello';\n",
      baseline: "",
      revision: "1",
      deleted: false,
    });
    window.api.workspaceList = async () => [
      { path: "hello.ts", name: "hello.ts", directory: false },
      { path: "notes.md", name: "notes.md", directory: false },
    ];
    window.__emit({
      type: "workspace_changed",
      data: { cwd: "/project/yukino", path: null },
    });
  });
  const explorer = page.getByRole("navigation", { name: "Project files" });
  await explorer.getByRole("button", { name: "Files", exact: true }).click();
  const notes = explorer.getByRole("button", { name: "notes.md", exact: true });
  await expect(notes).toBeVisible();
  await explorer.getByRole("button", { name: "hello.ts", exact: true }).click();
  const code = page.getByRole("textbox", { name: "File editor: hello.ts" });
  await expect(page.getByText("Plain text", { exact: true })).toBeVisible();
  await code.press("ControlOrMeta+End");
  await page.keyboard.insertText("draft");
  await expect(page.locator(".view-lines").last()).toContainText("draft");
  await expect(page.getByText("Ln 2, Col 6")).toBeVisible();
  await code.press("ControlOrMeta+f");
  await expect(page.getByRole("textbox", { name: /^Find/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await notes.click();
  await expect(page.locator(".view-lines").last()).toContainText("Notes");
  await page.getByRole("tab", { name: "hello.ts" }).click();
  await expect(page.getByText("Ln 2, Col 6")).toBeVisible();
  const compare = page.getByRole("button", {
    name: "Compare changes",
    exact: true,
  });
  await compare.click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await compare.click();

  await code.press("ControlOrMeta+z");
  await expect(page.locator(".view-lines").last()).not.toContainText("draft");
  await expect(page.getByRole("img", { name: "Unsaved changes" })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});

test("code and inline diffs keep one line-number gutter and slim themed scrollbars", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
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
  await page
    .getByRole("button", { name: "Compare changes", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Compare changes", exact: true })
    .click();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});

test("Catppuccin Latte and Mocha apply to the whole workspace", async ({
  page,
}) => {
  await bootstrap(page);
  await expect(page.locator("html")).toHaveClass(/latte/);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(239, 241, 245)",
  );
  const primary = page
    .locator("aside button")
    .filter({ hasText: "New session" });
  await expect(primary).toHaveCSS("background-color", "rgb(136, 57, 239)");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Mocha · Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/mocha/);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(30, 30, 46)",
  );
  await expect(primary).toHaveCSS("background-color", "rgb(203, 166, 247)");
  await expectNoHorizontalOverflow(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  );
  await page.screenshot({
    path: "test-results/catppuccin-mocha-settings.png",
    animations: "disabled",
  });
});

test("the first workspace frame respects a saved dark theme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.getElementById("root")?.childElementCount) {
        document.documentElement.dataset.firstFrameFlavor =
          document.documentElement.classList.contains("mocha")
            ? "mocha"
            : "latte";
        observer.disconnect();
      }
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  await bootstrap(page, "dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-first-frame-flavor",
    "mocha",
  );
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(30, 30, 46)",
  );
});

test("automatic appearance follows system changes and manual themes stay locked", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await bootstrap(page, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/mocha/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/latte/);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Mocha · Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/mocha/);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/mocha/);
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "System", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/latte/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/mocha/);
});

test("rejected appearance changes preserve the saved choice and shared reloads refresh it", async ({
  page,
}) => {
  await bootstrap(page);
  await page.evaluate(() => {
    window.api.setTheme = async () => {
      throw new Error("Agent settings are busy");
    };
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Mocha · Dark" }).click();
  await expect(
    page.getByText("Agent settings are busy", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/latte/);
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toContainText("Latte");
  await page.evaluate(async () => {
    const settings = await window.api.getSettings();
    settings.preferences.values.theme = "dark";
    window.__emit({ type: "preferences", data: settings.preferences });
  });
  await expect(page.locator("html")).toHaveClass(/mocha/);
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toContainText("Mocha");
});

test("shared agent settings change tool presentation, budget and display without losing sibling preferences", async ({
  page,
}) => {
  await bootstrap(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Tool presentation" }).click();
  await page
    .getByRole("option", { name: "Code Mode only", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Inline declaration budget" })
    .count();
  await page
    .getByRole("spinbutton", { name: "Inline declaration budget" })
    .fill("500");
  await page.getByRole("button", { name: "Apply budget" }).click();
  await page.getByRole("switch", { name: "Show thinking traces" }).click();
  await page.getByRole("switch", { name: "Expand tool results" }).click();
  const settings = await page.evaluate(() => window.api.getSettings());
  expect(settings.preferences.values.code_mode).toEqual({
    mode: "only",
    inline_budget: 500,
  });
  expect(settings.preferences.values.display.show_thinking).toBe(false);
  expect(settings.preferences.values.display.expanded_tools).toBe(true);
});

test("workbench exposes branch transfer, execution controls and MCP without losing the live chat", async ({
  page,
}) => {
  await bootstrap(page);
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  await page.getByRole("tab", { name: "Session & branches" }).click();
  await expect(
    page.getByRole("button", { name: "Clone session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Execution & usage" }).click();
  await expect(
    page.getByText("No queued messages", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload all resources" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "MCP server name" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read resource" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(
    page.getByRole("dialog", { name: "Agent workbench", exact: true }),
  );
});

test("permission requests from a workbench action remain actionable above the modal", async ({
  page,
}) => {
  await bootstrap(page);
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
  await page.evaluate(() => {
    window.__emit({
      type: "permission_request",
      data: {
        id: "modal-permission",
        toolCallId: "mcp-connect",
        toolName: "MCPConnect",
        args: { server: "local" },
        reason: "Connect to the requested server",
      },
    });
  });
  const approval = page.getByRole("dialog", {
    name: "Agent approval",
    exact: true,
  });
  await expect(approval).toBeVisible();
  await expect(
    approval.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeEnabled();
});

for (const theme of ["light", "dark"] as const) {
  test(`Catppuccin ${theme} keeps status and secondary text readable`, async ({
    page,
  }) => {
    await bootstrap(page);
    if (theme === "dark") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("combobox", { name: "Theme", exact: true }).click();
      await page.getByRole("option", { name: "Mocha · Dark" }).click();
      await page.keyboard.press("Escape");
    }
    await expect(page.locator("html")).toHaveClass(
      theme === "dark" ? /mocha/ : /latte/,
    );
    await page.evaluate(() => {
      window.api.workspaceRead = async (path) => ({
        path,
        content: "const message: string = 'hello'; // readable comment",
        baseline: "",
        revision: "syntax",
        deleted: false,
      });
    });
    await page.getByRole("button", { name: "hello.ts M" }).click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "readable comment",
    );
    const ratios = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas unavailable");
      }
      const luminance = (color: string): number => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => {
            const v = value / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
      };
      const probe = document.createElement("span");
      document.body.append(probe);
      const color = (token: string): number => {
        probe.style.color = `var(--${token})`;
        return luminance(getComputedStyle(probe).color);
      };
      try {
        const status = ["background", "card", "popover", "muted"].flatMap(
          (background) =>
            [
              "foreground",
              "muted-foreground",
              "success",
              "warning",
              "destructive",
              "accent-foreground",
            ].map((foreground) => {
              const a = color(background),
                b = color(foreground);
              return {
                background,
                foreground,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              };
            }),
        );
        const editor = document.querySelector(".monaco-editor");
        if (!editor) {
          throw new Error("Missing code editor");
        }
        const background = luminance(getComputedStyle(editor).backgroundColor);
        const tokens = [...editor.querySelectorAll(".view-line span")]
          .filter((element) => element.textContent?.trim())
          .map((element) => {
            const foreground = luminance(getComputedStyle(element).color);
            return {
              foreground: element.textContent,
              background: "code",
              contrast:
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05),
            };
          });
        return [...status, ...tokens];
      } finally {
        probe.remove();
      }
    });
    for (const result of ratios) {
      expect(
        result.contrast,
        `${result.foreground} on ${result.background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await page.screenshot({
      path: `test-results/catppuccin-${theme}-workbench.png`,
      animations: "disabled",
    });
  });
}

for (const selection of ["file", "tab"] as const) {
  test(`selecting an open ${selection} cancels a pending file activation`, async ({
    page,
  }) => {
    await bootstrap(page);
    await page.getByRole("button", { name: "hello.ts M" }).click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
    await page.evaluate(() => {
      const read = window.api.workspaceRead.bind(window.api);
      let release = (): void => undefined;
      window.api.workspaceRead = async (path) => {
        if (path === "release-pending") {
          release();
          return read("hello.ts");
        }
        if (path !== "slow.ts") {
          return read(path);
        }
        return new Promise((resolve) => {
          release = () => {
            resolve({
              path,
              content: "slow",
              baseline: "",
              revision: "slow",
              deleted: false,
            });
          };
        });
      };
      window.api.workspaceSnapshot = async () => ({
        cwd: "/project/yukino",
        branch: "main",
        changes: [
          { path: "hello.ts", status: "M" },
          { path: "slow.ts", status: "M" },
        ],
      });
      window.__emit({
        type: "workspace_changed",
        data: { cwd: "/project/yukino", path: null },
      });
    });
    const files = page.getByRole("region", { name: "Files", exact: true });
    await page.getByRole("button", { name: "slow.ts M" }).click();
    await expect(files.getByRole("status")).toBeVisible();
    if (selection === "file") {
      await page.getByRole("button", { name: "hello.ts M" }).click();
    } else {
      await page.getByRole("tab", { name: "hello.ts" }).click();
    }
    await page.evaluate(() => window.api.workspaceRead("release-pending"));
    await expect(files.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "hello.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: "slow.ts" })).toHaveCount(0);
  });
}
