import assert from "node:assert/strict";

import { expect, test, type Page } from "@playwright/test";

import type { BridgeEvent, InitState } from "../src/shared/ipc-types.ts";
import type {
  FileSnapshot,
  RuntimeSnapshot,
} from "../src/shared/workspace-types.ts";

async function bootstrap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = new Set<(event: BridgeEvent) => void>();
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
      tools: ["Read", "Edit", "Write", "Bash", "Agent", "Workflow"],
      toolDescriptions: {
        Read: "Read project files",
        Edit: "Edit project files",
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
      init: async () => {
        emit({ type: "init_state", data: initial });
        return initial;
      },
      getTheme: async () => ({ mode: "light", dark: false }),
      onTheme: () => () => undefined,
      setTheme: async () => undefined,
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
      getRuntime: async () =>
        structuredClone(window.__runtime) as unknown as RuntimeSnapshot,
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
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("textbox", { name: "Task input", exact: true }),
  ).toBeVisible();
}

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
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
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
  await expect(page.getByRole("tab").first().locator("span")).toBeVisible();
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
    };
    window.__runtime.tasks[0].blockedBy = ["2"];
    window.__emit({ type: "run_state", data: { streaming: true } });
  });
  await page
    .getByRole("button", { name: "Agent workbench", exact: true })
    .click();
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
        activity: "Read",
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
        progress: { turnCount: 2, toolUseCount: 3, tokenCount: 1000 },
        lastMessage: "Verification complete",
      },
    ];
    window.__runtime.workflows = [
      {
        runId: "wf",
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
  await dialog
    .getByRole("tab", { name: "Agents and collaboration", exact: true })
    .click();
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
        toolName: "Read",
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
    .getByRole("tab", { name: "Tools and skills", exact: true })
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
  await dialog
    .getByRole("tab", { name: "Context and environment", exact: true })
    .click();
  await dialog.getByText("Project conventions", { exact: true }).click();
  await expect(
    dialog.getByText("pnpm happy:fix", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Sandbox mode" }).click();
  await page
    .getByRole("option", { name: "Auto-allow in sandbox", exact: true })
    .click();
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
        toolName: "Edit",
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
    page.getByRole("log").getByText("Waiting for permission", { exact: true }),
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
    window.api.getRuntime = async () =>
      structuredClone(window.__runtime) as unknown as RuntimeSnapshot;
  });
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
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
    window.__emit({ type: "stream_text", data: { text: "First" } });
    window.__emit({ type: "stream_text", data: { text: " reply" } });
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
  await expect(dialog.getByRole("option")).toHaveCount(55);
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
  const firstResult = dialog.getByRole("option").nth(5);
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
