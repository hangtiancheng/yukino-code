import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema, loadConfig } from "@/config/index.js";
import {
  PreferencesPatchSchema,
  persistPreferences,
} from "@/config/preferences.js";
import type { ThinkingLevel } from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { RateLimitError, ContextTooLongError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { reloadRuntimeResources } from "@/runtime/resources.js";
import { buildSessionEnvironment } from "@/sdk/factory.js";
import {
  createAgentSession,
  SessionBusyError,
  SessionManager,
  type AgentSession,
} from "@/sdk/index.js";
import { yukinoPath } from "@/storage/index.js";
import type {
  PermissionRequestHandler,
  ProviderToolSchema,
} from "@/tools/types.js";
import { createAgentWorktree } from "@/worktree/index.js";

const end: StreamEvent = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};
class Client implements LLMClient {
  calls: { messages: unknown[]; schemas: ProviderToolSchema[] }[] = [];
  level: ThinkingLevel = "low";
  setSystemPrompt = vi.fn();
  setThinkingLevel(level: ThinkingLevel) {
    this.level = level;
    return level;
  }
  getThinkingLevel() {
    return this.level;
  }
  getSupportedThinkingLevels(): readonly ThinkingLevel[] {
    return ["off", "low", "high"];
  }
  constructor(readonly scripts: (StreamEvent[] | Error)[] = []) {}
  async *stream(conv: ConversationManager, schemas: ProviderToolSchema[]) {
    const script = this.scripts[this.calls.length] ?? [end];
    this.calls.push({ messages: structuredClone(conv.getMessages()), schemas });
    await Promise.resolve();
    if (script instanceof Error) {
      throw script;
    }
    yield* script;
  }
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});
function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}
function directory() {
  const path = yukinoPath("workspace");
  mkdirSync(path, { recursive: true });
  return path;
}
async function make(
  extra: Parameters<typeof createAgentSession>[0] = {},
  client = new Client(),
) {
  const created = await createAgentSession({
    cwd: directory(),
    persist: false,
    tools: [],
    client,
    ...extra,
  });
  cleanups.push(() => created.session.dispose());
  return { session: created.session, client };
}
async function environment(config = {}) {
  const cwd = directory();
  const manager = SessionManager.create(cwd, { persist: false });
  const result = await buildSessionEnvironment(
    { client: new Client(), config, tools: [], trust: "once" },
    manager,
    () => {},
  );
  cleanups.push(async () => {
    await Promise.allSettled([
      result.project.dispose(),
      result.runtime.dispose(),
    ]);
  });
  return result;
}
const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: test\n---\n${body}`;

describe("runtime preferences", () => {
  it("saves preferences before provider setup and keeps provider validation for agent execution", () => {
    const path = yukinoPath("config.yaml");
    expect(existsSync(path)).toBe(false);
    persistPreferences(
      { theme: "dark", display: { show_thinking: false } },
      path,
    );
    const config = loadConfig(path, { allowEmptyProviders: true });
    expect(config.providers).toEqual([]);
    expect(config.theme).toBe("dark");
    expect(config.display.show_thinking).toBe(false);
    expect(() => loadConfig(path)).toThrow(/provider/iu);
    persistPreferences({ theme: "light" }, path);
    expect(
      loadConfig(path, { allowEmptyProviders: true }).display.show_thinking,
    ).toBe(false);
  });
  it("keeps queue modes consistent across settings, reload and runtime replacement", async () => {
    const { session } = await make({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
    });
    expect(session.getSettings().values).toMatchObject({
      steering_mode: "one-at-a-time",
      follow_up_mode: "all",
    });
    session.setQueueMode("steer", "all");
    session.setQueueMode("followUp", "one-at-a-time");
    await session.reloadResources();
    await session.newSession();
    expect(session.getSettings().values).toMatchObject({
      steering_mode: "all",
      follow_up_mode: "one-at-a-time",
    });
    expect(session.getQueueModes()).toEqual({
      steering: "all",
      followUp: "one-at-a-time",
    });
  });

  it("preserves explicit queue mode changes after reload and session replacement", async () => {
    const { session } = await make();
    session.setQueueMode("steer", "one-at-a-time");
    session.setQueueMode("followUp", "all");
    await session.reloadResources();
    await session.newSession({ persist: false });
    expect(session.getQueueModes()).toEqual({
      steering: "one-at-a-time",
      followUp: "all",
    });
    expect(session.getSettings().values).toMatchObject({
      steering_mode: "one-at-a-time",
      follow_up_mode: "all",
    });
  });

  it("persists only validated preferences atomically and preserves providers and unrelated YAML", () => {
    const path = write(
      yukinoPath("config.yaml"),
      yaml.dump({
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            base_url: "https://local.invalid",
            model: "test",
            api_key: "secret",
          },
        ],
        display: { output_padding: 3 },
        custom: { keep: true },
      }),
    );
    persistPreferences(
      { display: { show_thinking: false }, code_mode: { mode: "only" } },
      path,
    );
    const config = loadConfig(path);
    expect(config.display).toMatchObject({
      output_padding: 3,
      show_thinking: false,
      editor_padding: 1,
    });
    expect(config.code_mode).toEqual({ mode: "only", inline_budget: 12000 });
    expect(config.providers[0].api_key).toBe("secret");
    expect(config.custom).toEqual({ keep: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = readFileSync(path, "utf8");
    expect(() => {
      persistPreferences(PreferencesPatchSchema.parse({ providers: [] }), path);
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe(saved);
  });
  it("merges nested settings, returns detached values without secrets and retains explicit overrides on reload", async () => {
    const path = write(
      yukinoPath("config.yaml"),
      yaml.dump({
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            base_url: "https://local.invalid",
            model: "test",
            api_key: "secret",
          },
        ],
        display: { output_padding: 2 },
      }),
    );
    const { session } = await make({
      configPath: path,
      config: loadConfig(path),
    });
    await session.setSettings({
      display: { show_thinking: false },
      code_mode: { mode: "only", inline_budget: 0 },
      steering_mode: "one-at-a-time",
    });
    const settings = session.getSettings();
    settings.values.display.editor_padding = 3;
    expect(session.getSettings().values.display.editor_padding).toBe(1);
    expect(session.getSettings().sources).toContainEqual(
      expect.objectContaining({ field: "display", scope: "override" }),
    );
    expect(JSON.stringify(session.getSettings())).not.toContain("secret");
    expect(session.getSettings().sources).toContainEqual(
      expect.objectContaining({ field: "auto_retry", scope: "default" }),
    );
    expect(session.getQueueModes().steering).toBe("one-at-a-time");
    write(
      path,
      yaml.dump({
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            base_url: "https://local.invalid",
            model: "test",
          },
        ],
        display: { output_padding: 3, editor_padding: 2 },
      }),
    );
    await session.reloadResources();
    expect(session.getSettings().values.display).toMatchObject({
      show_thinking: false,
      output_padding: 3,
      editor_padding: 2,
    });
    await session.setSettings(
      { display: { autocomplete_max_visible: 12 } },
      { persist: true },
    );
    expect(loadConfig(path).display.autocomplete_max_visible).toBe(12);
  });
  it("cycles thinking using client capabilities and exposes configured models without API keys", async () => {
    const { session } = await make({
      config: {
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            base_url: "https://local.invalid",
            model: "test",
            api_key: "secret",
          },
        ],
      },
    });
    session.setThinking("low");
    expect(session.cycleThinkingLevel()).toBe("high");
    expect(session.cycleThinkingLevel()).toBe("off");
    expect(session.cycleThinkingLevel(-1)).toBe("high");
    expect(session.getAvailableModels()).toHaveLength(1);
    expect(JSON.stringify(session.getAvailableModels())).not.toContain(
      "secret",
    );
  });
  it("independently cancels retry while retaining the session and queued follow-up", async () => {
    const { session, client } = await make(
      {},
      new Client([
        new RateLimitError("slow", "60"),
        [{ type: "text_delta", text: "follow-up answer" }, end],
      ]),
    );
    let follow: ReturnType<AgentSession["followUp"]> | undefined;
    session.subscribe((event) => {
      if (event.type === "retry") {
        follow = session.followUp("next input");
        expect(session.abortRetry()).toBe(true);
      }
    });
    const result = await session.prompt("first input");
    expect(result.status).toBe("aborted");
    expect(result.stopReason).toBe("retry_aborted");
    expect((await follow?.completion)?.status).toBe("completed");
    expect(client.calls).toHaveLength(2);
    expect(
      session
        .getMessages()
        .filter((message) => message.userInput)
        .map((message) => message.content),
    ).toEqual(["first input", "next input"]);
    expect(session.getRetryState()).toBeNull();
    expect(session.abortRetry()).toBe(false);
  });
  it("disabling auto retry stops an existing wait and affects following runs", async () => {
    const { session, client } = await make(
      {},
      new Client([
        new RateLimitError("slow", "60"),
        new RateLimitError("slow", "60"),
      ]),
    );
    session.subscribe((event) => {
      if (event.type === "retry") {
        session.setAutoRetry(false);
      }
    });
    expect((await session.prompt("first")).stopReason).toBe("retry_aborted");
    expect((await session.prompt("second")).status).toBe("failed");
    expect(client.calls).toHaveLength(2);
    expect(session.getSettings().values.auto_retry).toBe(false);
  });
  it("does not force compact after context overflow when auto compaction is disabled", async () => {
    const { session, client } = await make(
      {},
      new Client([new ContextTooLongError("too long")]),
    );
    session.setAutoCompaction(false);
    expect((await session.prompt("input")).status).toBe("failed");
    expect(client.calls).toHaveLength(1);
    expect(session.getSettings().values.auto_compaction).toBe(false);
  });
});

describe("unified resource reload", () => {
  it("replaces prompt and skill resources and hooks without replacing the runtime, ledger, permissions or conversation", async () => {
    const cwd = directory();
    mkdirSync(join(cwd, ".git"));
    const prompt = write(join(cwd, ".yukino/prompts/old-prompt.md"), "before");
    const skillPath = write(
      join(cwd, ".agents/skills/demo/SKILL.md"),
      skill("demo", "before"),
    );
    const env = await environment();
    const { runtime } = env;
    const checker = runtime.checker;
    const ledger = env.ledger;
    runtime.conv.addUserMessage("preserved history");
    expect(runtime.cmdRegistry.find("old-prompt")?.resource).toBe("prompt");
    rmSync(prompt);
    write(join(cwd, ".yukino/prompts/new.md"), "new prompt");
    write(skillPath, skill("demo", "updated"));
    const ask = vi.fn().mockResolvedValue("once");
    const result = await reloadRuntimeResources(
      env,
      AppConfigSchema.parse({
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            base_url: "https://local.invalid",
            model: "test",
          },
        ],
        hooks: [
          {
            event: "pre_tool_use",
            action: { type: "command", command: "true" },
          },
        ],
      }),
      { onTrustRequest: ask },
    );
    expect(ask).toHaveBeenCalledOnce();
    expect(result.errors).toEqual([]);
    expect(env.runtime).toBe(runtime);
    expect(runtime.checker).toBe(checker);
    expect(env.ledger).toBe(ledger);
    expect(runtime.cmdRegistry.find("old-prompt")?.resource).not.toBe("prompt");
    expect(runtime.cmdRegistry.find("new")?.resource).toBe("prompt");
    expect(runtime.skillCatalog?.get("demo")?.body).toBe("updated");
    expect(runtime.conv.getMessages()).toContainEqual(
      expect.objectContaining({ content: "preserved history" }),
    );
  });
  it("fails closed on extension errors and removes stale project hooks, commands and skills", async () => {
    const cwd = directory();
    mkdirSync(join(cwd, ".git"));
    write(
      join(cwd, ".yukino/config.yaml"),
      "hooks:\n  - id: gate\n    event: pre_tool_use\n    action: { type: command, command: 'true' }\n",
    );
    write(join(cwd, ".yukino/prompts/custom.md"), "project prompt");
    write(join(cwd, ".agents/skills/demo/SKILL.md"), skill("demo", "before"));
    const env = await environment();
    const extension = write(
      join(cwd, ".yukino/extensions/broken.mjs"),
      'export function activate() { throw new Error("reload failure"); }',
    );
    write(
      join(cwd, ".yukino/config.yaml"),
      "extensions:\n  - {name: broken, path: extensions/broken.mjs}\n",
    );
    await expect(
      reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] }), {
        onTrustRequest: () => Promise.resolve("once"),
      }),
    ).rejects.toThrow("reload failure");
    expect(existsSync(extension)).toBe(true);
    expect(env.project.trusted).toBe(false);
    expect(env.runtime.cmdRegistry.find("custom")).toBeUndefined();
    expect(env.runtime.skillCatalog?.has("demo")).toBe(false);
    expect(env.runtime.hookEngine).toBeDefined();
    expect(env.config.hooks).toEqual([]);
  });
  it("refreshes local extension dependencies after an approved content change and disposes old activation once", () => {
    const cwd = directory();
    mkdirSync(join(cwd, ".git"));
    const marker = join(cwd, "activation.txt");
    const dependency = write(
      join(cwd, ".yukino/extensions/value.mjs"),
      'export const value = "one";',
    );
    write(
      join(cwd, ".yukino/extensions/main.mjs"),
      `import { value } from './value.mjs'; import { appendFileSync } from 'node:fs'; export function activate() { appendFileSync(${JSON.stringify(marker)}, value+'\\n'); return () => appendFileSync(${JSON.stringify(marker)}, 'dispose '+value+'\\n'); }`,
    );
    write(
      join(cwd, ".yukino/config.yaml"),
      "extensions:\n  - {name: main, path: extensions/main.mjs}\n",
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { createAgentSession } from ${JSON.stringify(pathToFileURL(resolve("src/sdk/factory.ts")).href)};
      import { writeFileSync } from 'node:fs';
      const client = { setSystemPrompt() {}, async *stream() { await Promise.resolve(); } };
      const { session } = await createAgentSession({ cwd: ${JSON.stringify(cwd)}, persist: false, tools: [], client, trust: 'once', onTrustRequest: () => Promise.resolve('once') });
      try { writeFileSync(${JSON.stringify(dependency)}, 'export const value = "two";'); await session.reloadResources(); }
      finally { await session.dispose(); }
    `,
      ],
      { env: { ...process.env, HOME: dirname(yukinoPath()) }, timeout: 15000 },
    );
    expect(readFileSync(marker, "utf8")).toBe(
      "one\ndispose one\ntwo\ndispose two\n",
    );
  });
  it("keeps background work intact by rejecting a reload before resource mutation", async () => {
    const env = await environment();
    const previous = env.project;
    vi.spyOn(env.runtime.backgroundTaskManager, "hasRunning").mockReturnValue(
      true,
    );
    await expect(
      reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] })),
    ).rejects.toThrow("background tasks");
    expect(env.project).toBe(previous);
  });

  it("keeps the current configuration if reload is cancelled before replacing it", async () => {
    const env = await environment();
    const previous = env.project;
    const controller = new AbortController();
    vi.spyOn(env.runtime.cache, "invalidate").mockImplementationOnce(() => {
      controller.abort(new Error("Reload cancelled"));
      return Promise.resolve();
    });
    await expect(
      reloadRuntimeResources(
        env,
        AppConfigSchema.parse({ providers: [], auto_retry: false }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Reload cancelled");
    expect(env.project).toBe(previous);
    expect(env.projectAccess.current).toBe(previous);
    expect(env.runtime.preferences.auto_retry).toBe(true);
  });

  it("rejects SDK reload and setting mutations during a foreground run", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new Client();
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      await wait;
      yield end;
    });
    const { session } = await make({}, client);
    const run = session.prompt("hold");
    await vi.waitFor(() => {
      expect(session.isBusy).toBe(true);
    });
    try {
      expect(() => session.reloadResources()).toThrow(SessionBusyError);
      expect(() => session.setSettings({ theme: "dark" })).toThrow(
        SessionBusyError,
      );
    } finally {
      release();
      await run;
    }
  });
});

describe("shared shell configuration", () => {
  it("runs model Bash and explicit user Bash with the same executable and exactly one prefix, including only mode", async () => {
    const cwd = directory();
    const marker = join(cwd, "prefix-count");
    const shell = write(
      join(cwd, "custom shell", "bash"),
      '#!/bin/sh\nexec /bin/bash "$@"\n',
    );
    chmodSync(shell, 0o700);
    const prefix = `export YUKINO_TEST_VALUE=ready\nprintf x >> '${marker}'`;
    const permission = vi.fn<PermissionRequestHandler>(() =>
      Promise.resolve("allow"),
    );
    const { session } = await make(
      {
        tools: ["Bash", "CodeMode"],
        config: {
          code_mode: { mode: "only", inline_budget: 0 },
          shellPath: shell,
          shellCommandPrefix: prefix,
        },
        onPermissionRequest: permission,
      },
      new Client([
        [
          {
            type: "tool_call_complete",
            toolId: "script",
            toolName: "CodeMode",
            arguments: {
              code: "return (await tools.Bash({command: 'printf \"$YUKINO_TEST_VALUE\"'})).output;",
            },
          },
          { ...end, stopReason: "tool_use" },
        ],
        [end],
      ]),
    );
    expect((await session.prompt("run configured shell")).status).toBe(
      "completed",
    );
    expect(
      session
        .getMessages()
        .flatMap((message) => message.toolResults ?? [])
        .some((result) => result.content.includes("ready")),
    ).toBe(true);
    const result = await session.userBash('printf "$YUKINO_TEST_VALUE"', {
      excludeFromContext: true,
    });
    expect(result.output).toBe("ready");
    expect(result.isError).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("xx");
    expect(
      permission.mock.calls
        .filter(([name]) => name === "Bash")
        .map(([, args]) => args.command),
    ).toEqual([
      `${prefix}\nprintf "$YUKINO_TEST_VALUE"`,
      `${prefix}\nprintf "$YUKINO_TEST_VALUE"`,
    ]);
  });
  it("checks a prefixed deny rule before executing an otherwise safe user command", async () => {
    const cwd = directory();
    const marker = join(cwd, "must-not-exist");
    write(
      yukinoPath("permissions.yaml"),
      '- rule: "Bash(touch *)"\n  effect: deny\n',
    );
    const permission = vi.fn<PermissionRequestHandler>(() =>
      Promise.resolve("allow"),
    );
    const { session } = await make({
      tools: ["Bash"],
      config: { shellCommandPrefix: `touch '${marker}'` },
      onPermissionRequest: permission,
    });
    await expect(session.userBash("pwd")).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    expect(permission).not.toHaveBeenCalled();
  });
  it("cancels a long-running prefix through the user Bash signal without starting the requested command", async () => {
    const cwd = directory();
    const marker = join(cwd, "prefix-started");
    const requested = join(cwd, "requested");
    const { session } = await make({
      tools: ["Bash"],
      permissions: "bypassPermissions",
      config: { shellCommandPrefix: `touch '${marker}'; sleep 30` },
    });
    const running = session.userBash(`touch '${requested}'`);
    await vi.waitFor(() => {
      expect(existsSync(marker)).toBe(true);
    });
    await session.abort("foreground");
    const result = await running;
    expect(result.status).toBe("stopped");
    expect(existsSync(requested)).toBe(false);
  });
});

it("removes revoked resources even when an old extension disposer throws", async () => {
  const cwd = directory();
  mkdirSync(join(cwd, ".git"));
  const skillPath = write(
    join(cwd, ".agents/skills/demo/SKILL.md"),
    skill("demo", "before"),
  );
  write(join(cwd, ".yukino/prompts/custom.md"), "project prompt");
  write(
    join(cwd, ".yukino/extensions/dispose.mjs"),
    'export function activate() { return () => { throw new Error("dispose failure"); }; }',
  );
  write(
    join(cwd, ".yukino/config.yaml"),
    "auto_retry: false\nextensions:\n  - { name: dispose, path: extensions/dispose.mjs }\n",
  );
  const env = await environment();
  write(skillPath, skill("demo", "changed"));
  await expect(
    reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] })),
  ).rejects.toThrow("cleanup failed");
  expect(env.project.trusted).toBe(false);
  expect(env.runtime.cmdRegistry.find("custom")).toBeUndefined();
  expect(env.runtime.skillCatalog?.has("demo")).toBe(false);
  expect(env.runtime.preferences.auto_retry).toBe(true);
});

it("keeps project prompt precedence identical at startup and reload", async () => {
  const cwd = directory();
  mkdirSync(join(cwd, ".git"));
  write(yukinoPath("prompts/custom.md"), "global prompt");
  const path = write(join(cwd, ".yukino/prompts/custom.md"), "project prompt");
  const env = await environment();
  expect(
    env.runtime.cmdRegistry.find("custom")?.handler({ cwd, args: "" }),
  ).toBe("project prompt");
  write(path, "updated project prompt");
  await reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] }));
  expect(
    env.runtime.cmdRegistry.find("custom")?.handler({ cwd, args: "" }),
  ).toBe("updated project prompt");
});
it("binds ancestor skill content to the approved project fingerprint through reload", async () => {
  const root = directory();
  mkdirSync(join(root, ".git"));
  const cwd = join(root, "packages/app");
  mkdirSync(cwd, { recursive: true });
  const path = write(
    join(root, ".agents/skills/ancestor/SKILL.md"),
    skill("ancestor", "approved body"),
  );
  const env = await buildSessionEnvironment(
    { client: new Client(), tools: [], trust: "once" },
    SessionManager.create(cwd, { persist: false }),
    () => {},
  );
  cleanups.push(async () => {
    await Promise.allSettled([env.project.dispose(), env.runtime.dispose()]);
  });
  expect(env.project.manifest).toContainEqual(
    expect.objectContaining({ kind: "skills", path }),
  );
  write(path, skill("ancestor", "changed body"));
  const stamp = new Date(Date.now() + 1000);
  utimesSync(path, stamp, stamp);
  expect(env.runtime.skillCatalog?.get("ancestor")?.body).toBe("approved body");
  await reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] }), {
    onTrustRequest: () => Promise.resolve("deny"),
  });
  expect(env.runtime.skillCatalog?.has("ancestor")).toBe(false);
  await reloadRuntimeResources(env, AppConfigSchema.parse({ providers: [] }), {
    onTrustRequest: () => Promise.resolve("once"),
  });
  expect(env.runtime.skillCatalog?.get("ancestor")?.body).toBe("changed body");
});

it("changes automatic controls without invalidating a pending tool approval", async () => {
  const cwd = directory();
  const marker = join(cwd, "approved-tool");
  let allow!: (response: "allow") => void;
  const permission = vi.fn<PermissionRequestHandler>(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const { session } = await make(
    { tools: ["Bash"], onPermissionRequest: permission },
    new Client([
      [
        {
          type: "tool_call_complete",
          toolId: "bash",
          toolName: "Bash",
          arguments: { command: `touch '${marker}'` },
        },
        { ...end, stopReason: "tool_use" },
      ],
      [end],
    ]),
  );
  const run = session.prompt("execute after approval");
  await vi.waitFor(() => {
    expect(permission).toHaveBeenCalledOnce();
  });
  session.setAutoCompaction(false);
  session.setAutoRetry(false);
  allow("allow");
  expect((await run).status).toBe("completed");
  expect(existsSync(marker)).toBe(true);
});

it("continues a native host session without inventing user input or cancelling running background tasks", async () => {
  const { session, client } = await make(
    {},
    new Client([[{ type: "text_delta", text: "Background update" }, end]]),
  );
  let finish = (_value: string): void => {};
  const cancelled = vi.fn();
  const task = session.runtime.backgroundTaskManager.create(
    "long job",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    cancelled,
  );
  await Promise.resolve();
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  const result = await session.continueRun();
  expect(result.text).toBe("Background update");
  expect(result.status).toBe("completed");
  expect(
    client.calls[0].messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "user",
    ),
  ).toBe(false);
  expect(
    session.getEntries().filter((entry) => entry.message.role === "user"),
  ).toHaveLength(0);
  expect(task.status).toBe("running");
  expect(cancelled).not.toHaveBeenCalled();
  expect(events).toContain("run_settled");
  finish("done");
  await task.done;
});

it("serializes and cancels native host operations and synchronizes their conversation", async () => {
  const { session } = await make();
  let started = (): void => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operation = session.runHostOperation(async (runtime, signal) => {
    runtime.conv.appendMessages([
      { role: "assistant", content: "Native command result" },
    ]);
    started();
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  });
  await ready;
  expect(() => session.setSettings({ code_mode: { mode: "only" } })).toThrow(
    SessionBusyError,
  );
  await session.abort("foreground");
  await operation;
  expect(
    session
      .getEntries()
      .some((entry) => entry.message.content === "Native command result"),
  ).toBe(true);
  await session.dispose();
  expect(() => session.runtime).toThrow();
});

it("streams authorized user shell output and records elapsed time in seconds", async () => {
  const { session } = await make({
    tools: ["Bash"],
    permissions: "bypassPermissions",
  });
  const outputs: string[] = [];
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
    if (event.type === "tool_output") {
      outputs.push(event.payload.output);
    }
  });
  const before = Date.now();
  const result = await session.userBash("printf desktop-shell; sleep 0.65");
  expect(result.output).toBe("desktop-shell");
  expect(outputs.join("")).toContain("desktop-shell");
  expect(result.elapsed).toBeLessThanOrEqual((Date.now() - before) / 1000);
  expect(events).toContain("tool_use");
  expect(events).toContain("tool_result");
  expect(
    session.getEntries().find((entry) => entry.message.user_bash)?.message
      .user_bash,
  ).toBeDefined();
});

it("delivers and settles steering receipts during native background continuation", async () => {
  let release = (): void => {};
  let started = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const client = new Client();
  vi.spyOn(client, "stream").mockImplementation(async function* () {
    if (calls++ === 0) {
      started();
      await gate;
    }
    yield { type: "text_delta", text: "Continuation complete" };
    yield end;
  });
  const { session } = await make({}, client);
  const continuation = session.continueRun();
  await ready;
  const receipt = session.steer("Add the latest requirement");
  release();
  await continuation;
  expect((await receipt.completion).status).toBe("completed");
  expect(session.getQueue()).toHaveLength(0);
  expect(
    session
      .getMessages()
      .some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("latest requirement"),
      ),
  ).toBe(true);
});

it("runs host shell commands and their hooks in the active worktree while retaining the session storage project", async () => {
  const cwd = directory();
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { cwd, stdio: "ignore" },
  );
  const { session } = await make({
    cwd,
    tools: ["Bash"],
    permissions: "bypassPermissions",
  });
  const worktree = await createAgentWorktree("native-host", undefined, cwd);
  await session.runtime.checker.enterWorktree(worktree, cwd);
  const engine = session.runtime.hookEngine;
  if (!engine) {
    throw new Error("Missing hook engine");
  }
  const hook = vi.spyOn(engine, "firePreToolHooks");
  const result = await session.userBash("pwd");
  expect(result.output.trim()).toBe(worktree.path);
  expect(hook.mock.calls[0]?.[2]?.cwd).toBe(worktree.path);
  expect(session.cwd).toBe(cwd);
});
