import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Agent } from "@/agent/index.js";
import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { CODE_MODE_MAX_OUTPUT_CHARS } from "@/code-mode/constants.js";
import { CodeModeExecution } from "@/code-mode/execution.js";
import {
  appendCodeModeRecord,
  appendCodeModeRecovery,
  codeModeStore,
  readCodeModeRuns,
} from "@/code-mode/persistence.js";
import { describeCodeModeTools } from "@/code-mode/prompts.js";
import { CODE_MODE_FINGERPRINT } from "@/code-mode/runtime.js";
import { VmJsonObjectSchema } from "@/code-mode/schema.js";
import type {
  CodeModeHost,
  CodeModeStart,
  CodeModeResult,
} from "@/code-mode/types.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { createAgentSession } from "@/sdk/index.js";
import {
  getSessionFilePath,
  loadTranscript,
  rebuildFromSession,
  saveTranscriptMessage,
  readSessionDocument,
  appendDocumentRecords,
} from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import { TaskList } from "@/todo/index.js";
import { CodeModeTool } from "@/tools/code-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool, ToolResult } from "@/tools/types.js";

const directories: string[] = [];
const registries: ToolRegistry[] = [];
const children: ChildProcess[] = [];
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
function directory() {
  const path = mkdtempSync(join(tmpdir(), "yukino-code-mode-"));
  directories.push(path);
  return path;
}
function tool(
  name: string,
  execute: Tool["execute"],
  category: Tool["category"] = "read",
): Tool {
  return {
    name,
    description: name,
    category,
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute,
  };
}
function client(code?: string, id = "script"): LLMClient {
  let calls = 0;
  return {
    setSystemPrompt() {},
    async *stream() {
      await Promise.resolve();
      if (calls++ === 0 && code) {
        yield {
          type: "tool_call_complete",
          toolId: id,
          toolName: "CodeMode",
          arguments: { code },
        };
        yield { ...end, stopReason: "tool_use" };
      } else {
        yield end;
      }
    },
  };
}
function setup(
  code?: string,
  tools: Tool[] = [],
  options: {
    mode?: "plan" | "default" | "bypassPermissions";
    filter?: (name: string) => boolean;
    hooks?: HookEngine;
  } = {},
) {
  const cwd = directory();
  const sessionId = "session";
  const transcriptPath = getSessionFilePath(cwd, sessionId);
  const conversation = new ConversationManager();
  conversation.addUserMessage("Run the script");
  const registry = new ToolRegistry();
  registry.setPolicy({ codeModeEnabled: true });
  registries.push(registry);
  registry.register(new CodeModeTool());
  for (const item of tools) {
    registry.register(item);
  }
  const checker = new PermissionChecker(
    cwd,
    options.mode ?? "bypassPermissions",
  );
  const config = {
    client: client(code),
    registry,
    checker,
    conversation,
    cwd,
    sessionId,
    transcriptPath,
    hookEngine: options.hooks,
    toolFilter: options.filter,
  };
  return { ...config, agent: new Agent(config) };
}
async function run(agent: Agent) {
  const events = [];
  for await (const event of agent.run()) {
    events.push(event);
  }
  const result = events.find(
    (event) => event.type === "tool_result" && event.toolName === "CodeMode",
  );
  if (result?.type !== "tool_result") {
    throw new Error("No CodeMode result");
  }
  return result;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function processFixture(
  transcript: string,
  counter: string,
  phase: string,
): Promise<{
  child: ChildProcess;
  message: { stage?: string; result?: ToolResult; records?: string };
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./fixtures/code-mode-process.ts", import.meta.url),
      ),
      transcript,
      counter,
      phase,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`Fixture exited: ${code}/${signal}: ${stderr}`));
      }
    });
    child.once("message", (message: unknown) => {
      const parsed = z
        .object({
          stage: z.string().optional(),
          result: z
            .object({ output: z.string(), isError: z.boolean() })
            .optional(),
          records: z.string().optional(),
        })
        .parse(message);
      resolve({ child, message: parsed });
    });
  });
}

describe("CodeMode integration", () => {
  it("registers only when explicitly enabled", () => {
    const disabled = createToolRegistry(new TaskList());
    const enabled = createToolRegistry(new TaskList(), {
      codeMode: { mode: "on", inline_budget: 12000 },
    });
    registries.push(disabled, enabled);
    expect(disabled.get("CodeMode")).toBeUndefined();
    expect(enabled.get("CodeMode")).toBeInstanceOf(CodeModeTool);
    expect(enabled.get("ReadFile")).toBeDefined();
  });

  it("composes tools without exposing nested results to conversation history", async () => {
    const execute = vi.fn<Tool["execute"]>((_ctx, args) =>
      Promise.resolve({ output: String(args.value), isError: false }),
    );
    const state = setup(
      "const results = await Promise.all([tools.Echo({value:1}), tools.Echo({value:2})]); return results.map(r => r.output);",
      [tool("Echo", execute)],
    );
    const result = await run(state.agent);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('["1","2"]');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      state.conversation
        .getMessages()
        .flatMap((message) => message.toolResults ?? []),
    ).toHaveLength(1);
    expect(
      readCodeModeRuns(state.transcriptPath).get("script")?.journal,
    ).toHaveLength(2);
  });

  it("preserves native structured and raw results in VM, journal and final output", async () => {
    const value: CodeModeResult = {
      output: "native",
      isError: false,
      structuredContent: { answer: 42 },
      rawContent: [
        { type: "resource", resource: { uri: "file:///test", text: "raw" } },
      ],
    };
    const state = setup("return await tools.Echo({});", [
      tool("Echo", () => Promise.resolve(value)),
    ]);
    const result = await run(state.agent);
    expect(result.isError, result.output).toBe(false);
    expect(result.structuredContent).toEqual({ value });
    const saved = readCodeModeRuns(state.transcriptPath).get("script");
    if (!saved) {
      throw new Error("Missing saved CodeMode run");
    }
    expect(saved.journal[0].outcome).toEqual({ ok: true, value });
    expect(saved.result?.structuredContent).toEqual({ value });
    expect(saved.result?.rawContent).toEqual(result.rawContent);
  });

  it("retains nested file operations when a script fails after a successful tool call", async () => {
    const fileOperations = {
      readFiles: ["/repo/read.txt"],
      modifiedFiles: ["/repo/written.txt"],
    };
    const state = setup(
      'await tools.Files({}); throw new Error("later failure")',
      [
        tool("Files", () =>
          Promise.resolve({
            output: "done",
            isError: false,
            structuredContent: { fileOperations },
          }),
        ),
      ],
    );
    const result = await run(state.agent);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ fileOperations });
    const restored = rebuildFromSession(loadTranscript(state.transcriptPath));
    expect(
      restored
        .flatMap((message) => message.toolResults ?? [])
        .find((item) => item.toolUseId === "script")?.structuredContent,
    ).toEqual({ fileOperations });
  });

  it("persists file operations even when a completed nested result exceeds the bridge limit", async () => {
    const fileOperations = {
      readFiles: [],
      modifiedFiles: ["/repo/committed.txt"],
    };
    const state = setup("await tools.Files({})", [
      tool("Files", () =>
        Promise.resolve({
          output: "x".repeat(CODE_MODE_MAX_OUTPUT_CHARS + 1),
          isError: false,
          structuredContent: { fileOperations },
        }),
      ),
    ]);
    const result = await run(state.agent);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ fileOperations });
    const saved = readCodeModeRuns(state.transcriptPath).get("script");
    expect(saved?.journal[0].outcome).toMatchObject({
      ok: false,
      fileOperations,
    });
    expect(saved?.result?.structuredContent).toEqual({ fileOperations });
  });

  it("spills full structured output while keeping every inline result field bounded", async () => {
    const cwd = directory();
    const result = await new CodeModeExecution().execute(
      {
        stateKey: {},
        sessionId: "bounded",
        transcriptPath: join(cwd, "session.jsonl"),
        tools: () => [],
        async *execute() {
          await Promise.resolve();
          yield* [];
          throw new Error("No tools expected");
        },
      },
      "large",
      {
        code: "return {value: 'x'.repeat(10000)}",
        timeout_ms: 5000,
        max_output_tokens: 100,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.artifact?.path).toBeTypeOf("string");
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(3000);
    const artifactPath = result.artifact?.path;
    if (!artifactPath) {
      throw new Error("Missing CodeMode artifact path");
    }
    const raw: unknown = JSON.parse(readFileSync(artifactPath, "utf8"));
    const full = VmJsonObjectSchema.parse(raw);
    const content = VmJsonObjectSchema.parse(full.structuredContent);
    expect(VmJsonObjectSchema.parse(content.value).value).toHaveLength(10000);
    expect(
      readCodeModeRuns(join(cwd, "session.jsonl")).get("large")?.result,
    ).toEqual(result);
  });

  it("keeps allowed reads usable in plan mode but blocks nested writes", async () => {
    const write = vi.fn(() =>
      Promise.resolve({ output: "written", isError: false }),
    );
    const state = setup(
      "text((await tools.Read({})).output); return (await tools.Write({})).isError;",
      [
        tool("Read", () => Promise.resolve({ output: "read", isError: false })),
        tool("Write", write, "write"),
      ],
      { mode: "plan" },
    );
    const result = await run(state.agent);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ value: true });
    expect(result.output).toContain("read");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not advertise or execute filtered tools", async () => {
    const secret = vi.fn(() =>
      Promise.resolve({ output: "secret", isError: false }),
    );
    const state = setup(
      "text(ALL_TOOLS.map(t=>t.name)); await tools.Secret({});",
      [tool("Secret", secret)],
      { filter: (name) => name !== "Secret" },
    );
    const result = await run(state.agent);
    expect(result.isError).toBe(true);
    expect(secret).not.toHaveBeenCalled();
    expect(result.output).toContain("[]");
  });

  it("runs nested reads concurrently and nested writes serially", async () => {
    let active = 0;
    let maxReads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = tool("Read", async () => {
      active++;
      maxReads = Math.max(active, maxReads);
      if (active === 2) {
        release();
      }
      await gate;
      active--;
      return { output: "read", isError: false };
    });
    let maxWrites = 0;
    const write = tool(
      "Write",
      async () => {
        active++;
        maxWrites = Math.max(active, maxWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { output: "write", isError: false };
      },
      "write",
    );
    const state = setup(
      "await Promise.all([tools.Read({}),tools.Read({})]); await Promise.all([tools.Write({}),tools.Write({})]);",
      [read, write],
    );
    expect((await run(state.agent)).isError).toBe(false);
    expect(maxReads).toBe(2);
    expect(maxWrites).toBe(1);
  });

  it("executes pre/post hooks for nested calls", async () => {
    const hooks = new HookEngine([]);
    const pre = vi.spyOn(hooks, "firePreToolHooks");
    const post = vi.spyOn(hooks, "fire");
    const state = setup(
      "return (await tools.Echo({})).output;",
      [tool("Echo", () => Promise.resolve({ output: "ok", isError: false }))],
      { hooks },
    );
    expect((await run(state.agent)).isError).toBe(false);
    expect(pre.mock.calls.some(([name]) => name === "Echo")).toBe(true);
    expect(
      post.mock.calls.some(
        ([event, input]) =>
          event === "post_tool_use" && input.toolName === "Echo",
      ),
    ).toBe(true);
  });

  it("returns recorded final output without repeating completed tools", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ output: "once", isError: false }),
    );
    const state = setup("return (await tools.Echo({})).output;", [
      tool("Echo", execute),
    ]);
    expect((await run(state.agent)).isError).toBe(false);
    const saved = readCodeModeRuns(state.transcriptPath).get("script");
    if (!saved) {
      throw new Error("Missing saved CodeMode run");
    }
    const cached = await new CodeModeExecution().execute(
      {
        stateKey: {},
        sessionId: "test",
        transcriptPath: state.transcriptPath,
        tools: () => saved.start.tools,
        async *execute() {
          await Promise.resolve();
          yield* [];
          throw new Error("Completed tools must not execute again");
        },
      },
      "script",
      { code: saved.start.code, timeout_ms: 1000, max_output_tokens: 1000 },
    );
    expect(cached.output).toContain("once");
    expect(execute).toHaveBeenCalledTimes(1);
    const recovered = new Agent({ ...state, client: client() });
    expect(await recovered.recoverCodeMode()).toEqual([]);
  });

  it("does not persist oversized tool results into the journal", async () => {
    const state = setup("return await tools.Echo({});", [
      tool("Echo", () =>
        Promise.resolve({
          output: "x".repeat(CODE_MODE_MAX_OUTPUT_CHARS),
          isError: false,
        }),
      ),
    ]);
    const result = await run(state.agent);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bridge limit");
    expect(
      JSON.stringify(
        readCodeModeRuns(state.transcriptPath).get("script")?.journal,
      ).length,
    ).toBeLessThan(1000);
  });

  it("commits store only on success and preserves JSON keys across calls", async () => {
    const state = setup('store("__proto__", {n:1}); return load("__proto__");');
    expect((await run(state.agent)).output).toContain('{"n":1}');
    const failed = new Agent({
      ...state,
      client: client(
        'store("__proto__", {n:2}); throw new Error("failed");',
        "script-two",
      ),
    });
    expect((await run(failed)).isError).toBe(true);
    const next = new Agent({
      ...state,
      client: client('return load("__proto__");', "script-three"),
    });
    expect((await run(next)).output).toContain('{"n":1}');
  });

  it("does not expose recursive or plan/worktree transition tools", async () => {
    const state = setup(
      "return [typeof tools.CodeMode, typeof tools.EnterPlanMode];",
      [
        tool("EnterPlanMode", () =>
          Promise.resolve({ output: "no", isError: false }),
        ),
      ],
    );
    expect((await run(state.agent)).output).toContain(
      '["undefined","undefined"]',
    );
  });
});

describe("CodeMode durable history", () => {
  it.each(["expired", "fingerprint", "code", "tools", "unknown"])(
    "retains completed file operations when recovery refuses %s state",
    async (reason) => {
      const cwd = directory();
      const path = join(cwd, "session.jsonl");
      const fileOperations = {
        readFiles: [],
        modifiedFiles: [join(cwd, "done.txt")],
      };
      const start: CodeModeStart = {
        code: "return 1",
        tools:
          reason === "tools"
            ? [
                {
                  name: "Files",
                  description: "files",
                  schema: {
                    name: "Files",
                    description: "files",
                    input_schema: { type: "object", properties: {} },
                  },
                },
              ]
            : [],
        store: {},
        seed: 1,
        startedAt: 1,
        deadline: reason === "expired" ? 1 : Date.now() + 60_000,
        maxOutputTokens: 1000,
      };
      appendCodeModeRecord(path, {
        kind: "start",
        id: "recovery",
        start,
        fingerprint:
          reason === "fingerprint" ? "changed" : CODE_MODE_FINGERPRINT,
      });
      appendCodeModeRecord(path, {
        kind: "calls",
        id: "recovery",
        calls: [
          { id: 1, name: "Files", args: {} },
          { id: 2, name: "Pending", args: {} },
        ],
      });
      appendCodeModeRecord(path, {
        kind: "started",
        id: "recovery",
        callId: 1,
      });
      appendCodeModeRecord(path, {
        kind: "result",
        id: "recovery",
        callId: 1,
        now: 2,
        outcome: {
          ok: true,
          value: { output: "done", structuredContent: { fileOperations } },
        },
      });
      if (reason === "unknown") {
        appendCodeModeRecord(path, {
          kind: "started",
          id: "recovery",
          callId: 2,
        });
      }
      const execute = vi.fn(async function* () {});
      const result = await new CodeModeExecution().execute(
        {
          stateKey: {},
          sessionId: "recovery",
          transcriptPath: path,
          tools: () => [],
          execute,
        },
        "recovery",
        {
          code: reason === "code" ? "changed code" : start.code,
          timeout_ms: 1000,
          max_output_tokens: 1000,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ fileOperations });
      expect(
        readCodeModeRuns(path).get("recovery")?.result?.structuredContent,
      ).toEqual({ fileOperations });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("replays recorded results after a killed process without repeating effects", async () => {
    const cwd = directory();
    const transcript = join(cwd, "session.jsonl");
    const counter = join(cwd, "effects.jsonl");
    writeFileSync(counter, "");
    const first = await processFixture(transcript, counter, "recorded");
    expect(first.message.stage).toBe("recorded");
    const exit = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exit;
    const resumed = await processFixture(transcript, counter, "resume");
    expect(resumed.message.result?.isError).toBe(false);
    expect(resumed.message.result?.output).toContain('["a","b"]');
    const records = (resumed.message.records ?? "")
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({ key: z.string(), sample: z.array(z.number()) })
          .parse(JSON.parse(line)),
      );
    expect(records.map((record) => record.key)).toEqual(["a", "b"]);
    expect(records[0].sample).toEqual(records[1].sample);
  });

  it("refuses to retry a started call with an unknown outcome", async () => {
    const cwd = directory();
    const transcript = join(cwd, "session.jsonl");
    const counter = join(cwd, "effects.jsonl");
    writeFileSync(counter, "");
    const first = await processFixture(transcript, counter, "unknown");
    const exit = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exit;
    const resumed = await processFixture(transcript, counter, "resume");
    expect(resumed.message.result?.isError).toBe(true);
    expect(resumed.message.result?.output).toContain("will not be retried");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rewinds committed store with the transcript and ignores journal records in model messages", () => {
    const cwd = directory();
    const path = join(cwd, "session.jsonl");
    const start: CodeModeStart = {
      code: "store('n',1)",
      tools: [],
      store: {},
      seed: 1,
      startedAt: 1,
      deadline: Date.now() + 10_000,
      maxOutputTokens: 1000,
    };
    saveTranscriptMessage(path, {
      role: "user",
      timestamp: 1,
      content: "original",
    });
    appendCodeModeRecord(path, {
      kind: "start",
      id: "one",
      start,
      fingerprint: CODE_MODE_FINGERPRINT,
    });
    appendCodeModeRecord(path, {
      kind: "finished",
      id: "one",
      result: { output: "ok", isError: false },
      store: { n: 1 },
    });
    appendCodeModeRecord(path, {
      kind: "start",
      id: "two",
      start,
      fingerprint: CODE_MODE_FINGERPRINT,
    });
    appendCodeModeRecord(path, {
      kind: "finished",
      id: "two",
      result: { output: "ok", isError: false },
      store: { n: 2 },
    });
    expect(codeModeStore(readCodeModeRuns(path))).toEqual({ n: 2 });
    expect(rebuildFromSession(loadTranscript(path))).toHaveLength(1);
    const document = readSessionDocument(path);
    if (!document) {
      throw new Error("Missing session document");
    }
    appendDocumentRecords(path, document, [
      {
        type: "active_leaf",
        leafId: document.entries[2].entryId,
        revision: document.revision + 1,
      },
    ]);
    expect(codeModeStore(readCodeModeRuns(path))).toEqual({ n: 1 });
  });

  it("pairs a persisted recovery before subsequent user input", () => {
    const cwd = directory();
    const path = join(cwd, "session.jsonl");
    saveTranscriptMessage(path, {
      role: "assistant",
      timestamp: 1,
      content: "",
      tool_uses: [
        {
          tool_use_id: "script",
          tool_name: "CodeMode",
          arguments: { code: "return 1" },
        },
      ],
    });
    appendCodeModeRecovery(path, "script", { output: "1", isError: false });
    saveTranscriptMessage(path, {
      role: "user",
      timestamp: 2,
      content: "later",
    });
    const restored = rebuildFromSession(loadTranscript(path));
    expect(restored[1].toolResults?.[0]?.toolUseId).toBe("script");
    expect(restored[2].content).toBe("later");
  });

  it("rejects corrupted checkpoints before executing new effects", async () => {
    const cwd = directory();
    const path = join(cwd, "session.jsonl");
    writeFileSync(path, '{"truncated":');
    const execute = vi.fn();
    const host: CodeModeHost = {
      stateKey: {},
      sessionId: "test",
      transcriptPath: path,
      tools: () => [],
      execute,
    };
    await expect(
      new CodeModeExecution().execute(host, "broken", {
        code: "return 1",
        timeout_ms: 1000,
        max_output_tokens: 1000,
      }),
    ).rejects.toThrow("incomplete");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("configurable tool presentation", () => {
  it("hides direct tools in only mode while retaining script access and direct control tools", async () => {
    const execute = vi.fn<Tool["execute"]>(() =>
      Promise.resolve({ output: "script result", isError: false }),
    );
    const state = setup("return await tools.Echo({});", [
      tool("Echo", execute),
    ]);
    state.registry.setPolicy({
      codeModeEnabled: true,
      codeModeMode: "only",
      codeModeInlineBudget: 0,
    });
    expect(state.registry.canInvoke("Echo", "direct")).toBe(false);
    expect(state.registry.canInvoke("Echo", "codemode")).toBe(true);
    expect(state.registry.listVisibleToolNames("anthropic")).toEqual([
      "CodeMode",
    ]);
    const result = await run(state.agent);
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    state.registry.setPolicy({
      codeModeEnabled: true,
      codeModeMode: "only",
      denylist: ["Echo"],
    });
    expect(state.registry.canInvoke("Echo", "codemode")).toBe(false);
    state.registry.setPolicy({ codeModeEnabled: false, codeModeMode: "off" });
    expect(state.registry.canInvoke("CodeMode", "direct")).toBe(false);
    expect(state.registry.canInvoke("Echo", "direct")).toBe(true);
    expect(state.registry.canInvoke("Echo", "codemode")).toBe(false);
  });
});

it("keeps inline declarations within the configured budget and skips oversized declarations without starving small tools", () => {
  const declaration = (name: string, description: string) => ({
    name,
    description,
    namespace: "tools",
    source: { kind: "builtin" },
    schema: {
      name,
      description,
      input_schema: { type: "object" as const, properties: {} },
    },
  });
  const tools = [
    declaration("Huge", "x".repeat(1000)),
    declaration("Small", "ok"),
  ];
  const description = describeCodeModeTools(tools, 100);
  const body = description.split("\n").slice(1).join("\n");
  expect(body.length).toBeLessThanOrEqual(100);
  expect(body).toContain("Small");
  expect(body).not.toContain("Huge");
  expect(describeCodeModeTools(tools, 0).split("\n").slice(1).join("\n")).toBe(
    "",
  );
});

it.each([
  'text("CodeMode is available");',
  'const results = await Promise.all([tools.Bash({ command: "printf one" }), tools.Bash({ command: "printf two" })]); text(results.map((result) => result.output));',
])(
  "runs CodeMode with the complete production tool registry and persisted session: %s",
  async (code) => {
    const { session } = await createAgentSession({
      cwd: directory(),
      client: client(code),
      trust: "once",
      config: { code_mode: { mode: "on", inline_budget: 12000 } },
      onPermissionRequest: () => Promise.resolve("allow"),
    });
    try {
      expect(session.runtime.registry.get("InstallSkill")).toBeDefined();
      const result = await session.prompt("Try CodeMode");
      const toolResult = result.messages
        .flatMap((message) => message.toolResults ?? [])
        .find((item) => item.toolUseId === "script");
      expect(toolResult?.isError, toolResult?.content).toBe(false);
      expect(toolResult?.content).toContain(
        code.includes("Promise.all") ? "one" : "CodeMode is available",
      );
      const exported = session.export({
        scope: "tree",
        format: "jsonl",
        redact: false,
      });
      expect(exported).toContain("InstallSkill");
      expect(() => SessionManager.import(session.cwd, exported)).not.toThrow();
    } finally {
      await session.dispose();
    }
  },
);
